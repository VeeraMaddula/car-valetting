// End-to-end deposit flow against CockroachDB with a stubbed Stripe client.
// Run: TEST_DATABASE_URL=postgresql://root@localhost:26257/defaultdb?sslmode=disable npm test
import pg from 'pg';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import type { Deps } from '../../src/deps.js';
import { SettingsCache } from '../../src/domain/settings.js';
import { hashPassword } from '../../src/domain/users.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { addDays, todayInZone } from '../../src/lib/time.js';
import { setStripeClientForTests } from '../../src/payments/stripe.js';

const BASE_URL = process.env.TEST_DATABASE_URL;
const suite = BASE_URL ? describe : describe.skip;
const WHSEC = 'whsec_test_secret_0123456789';
const SITE = 'http://localhost:5500';

/** A fake Stripe: records calls, hands back deterministic sessions/refunds, verifies real signatures. */
function fakeStripe() {
  const calls: { method: string; args: unknown[] }[] = [];
  let sessions = 0;
  const real = new Stripe('sk_test_fake');
  const fake = {
    calls,
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams, opts: unknown) => {
          calls.push({ method: 'sessions.create', args: [params, opts] });
          sessions += 1;
          return { id: `cs_test_${sessions}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sessions}`, status: 'open' };
        },
        retrieve: async (id: string) => {
          calls.push({ method: 'sessions.retrieve', args: [id] });
          return { id, status: 'open' };
        },
        expire: async (id: string) => {
          calls.push({ method: 'sessions.expire', args: [id] });
          return { id, status: 'expired' };
        },
      },
    },
    refunds: {
      create: async (params: Stripe.RefundCreateParams, opts: unknown) => {
        calls.push({ method: 'refunds.create', args: [params, opts] });
        return { id: `re_test_${params.payment_intent}`, amount: 3000, status: 'succeeded' };
      },
    },
    webhooks: real.webhooks,
  };
  return fake;
}

suite('deposit payments on CockroachDB', () => {
  const dbName = `sjp_dep_${Date.now()}`;
  let root: pg.Pool;
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let deps: Deps;
  let worker: JobWorker;
  let stripe: ReturnType<typeof fakeStripe>;
  let adminCookie: string;
  let day: string;

  async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload: body as object | undefined, headers });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, headers: res.headers };
  }

  function webhook(event: object, secret = WHSEC) {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
    });
  }

  async function drain() {
    await worker.drain();
  }

  beforeAll(async () => {
    root = new pg.Pool({ connectionString: BASE_URL });
    await root.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(BASE_URL!);
    url.pathname = `/${dbName}`;
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      PUBLIC_SITE_URL: SITE,
      PUBLIC_API_URL: 'http://localhost:8080',
      ALLOWED_ORIGINS: SITE,
      OWNER_EMAIL: 'owner@example.com',
      OWNER_PHONE: '089 470 9672',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: WHSEC,
      DEPOSIT_AMOUNT_EUR: '30',
      LOG_LEVEL: 'silent',
    });
    expect(config.stripeEnabled).toBe(true);
    stripe = fakeStripe();
    setStripeClientForTests(stripe as unknown as Stripe);
    pool = createPool(config);
    await migrate(pool, () => undefined);
    deps = { config, db: pool, settings: new SettingsCache(pool), wakeWorker: () => undefined };
    app = await buildApp(deps, { logger: false, rateLimit: false });
    worker = new JobWorker(deps, { info() {}, warn() {}, error() {} });

    await pool.query(
      `INSERT INTO users (username, email, full_name, phone, password_hash, role) VALUES ('owner', 'owner@example.com', 'Owner', '+353894709672', $1, 'admin')`,
      [await hashPassword('owner-password-123')],
    );
    const login = await call('POST', '/auth/login', { login: 'owner', password: 'owner-password-123' }, { origin: SITE });
    expect(login.status).toBe(200);
    const raw = login.headers['set-cookie'];
    adminCookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];

    const today = todayInZone(config.TIMEZONE);
    const res = await call('GET', `/availability?from=${addDays(today, 3)}&to=${addDays(today, 30)}`);
    day = res.json.days.find((d: any) => d.open && d.available === 3).date;
  });

  afterAll(async () => {
    setStripeClientForTests(null);
    await app?.close();
    await pool?.end();
    await root?.query(`DROP DATABASE IF EXISTS ${dbName} CASCADE`).catch(() => undefined);
    await root?.end();
  });

  const admin = () => ({ cookie: adminCookie, origin: SITE });
  let ref: string;
  let bookingId: string;
  let payUrl: string;

  it('advertises online deposits in /config', async () => {
    const res = await call('GET', '/config');
    expect(res.json.booking).toMatchObject({ depositAmountEur: 30, onlineDeposit: true });
  });

  it('creates a Checkout link when the owner requests the deposit, then sends it', async () => {
    const created = await call('POST', '/bookings', {
      serviceCode: 'full',
      date: day,
      period: 'morning',
      name: 'Mary Smith',
      phone: '089 470 9672',
      email: 'mary@example.com',
      vehicle: 'VW Golf',
    });
    expect(created.status).toBe(201);
    ref = created.json.booking.reference;
    await pool.query("DELETE FROM jobs"); // ignore the booking-created notifications
    const row = await pool.query('SELECT id FROM bookings WHERE reference = $1', [ref.replace(/^SJP-/, '').replace('-', '')]);
    bookingId = row.rows[0].id;

    const res = await call('PATCH', `/admin/bookings/${ref}`, { status: 'confirmed', depositStatus: 'requested' }, admin());
    expect(res.status).toBe(200);
    expect(res.json.booking.deposit.status).toBe('requested');
    expect(res.json.booking.deposit.payUrl).toBeNull(); // not until the worker has created it

    const queued = await pool.query("SELECT kind, payload FROM jobs WHERE status = 'pending' ORDER BY created_at");
    expect(queued.rows.map((r) => r.kind)).toContain('deposit.link');
    // The "deposit requested" messages are NOT queued directly; the link job queues them once the URL exists.
    expect(queued.rows.filter((r) => r.payload.template === 'deposit_requested')).toHaveLength(0);

    await drain();
    const create = stripe.calls.find((c) => c.method === 'sessions.create')!;
    expect(create).toBeDefined();
    const params = create.args[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.mode).toBe('payment');
    expect(params.line_items![0].price_data).toMatchObject({ currency: 'eur', unit_amount: 3000 });
    expect(params.metadata).toMatchObject({ bookingId, reference: ref });
    expect(params.customer_email).toBe('mary@example.com');
    expect(params.success_url).toBe(`${SITE}/track.html?ref=${encodeURIComponent(ref)}&deposit=paid`);
    expect(params.cancel_url).toBe(`${SITE}/track.html?ref=${encodeURIComponent(ref)}&deposit=cancelled`);
    expect((create.args[1] as any).idempotencyKey).toBe(`deposit:${bookingId}:1`);

    const tracked = await call('POST', '/bookings/track', { reference: ref, phone: '089 470 9672' });
    payUrl = tracked.json.booking.deposit.payUrl;
    expect(payUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(tracked.json.booking.timeline.map((t: any) => t.type)).toContain('deposit_link_sent');

    const sent = await pool.query("SELECT payload->>'channel' AS channel, last_error FROM jobs WHERE payload->>'template' = 'deposit_requested'");
    expect(sent.rows.map((r) => r.channel).sort()).toEqual(['customer_email', 'customer_sms']);
    // Providers aren't configured in tests, so they're "skipped", not failed: the template rendered with the link.
    expect(sent.rows.every((r) => /skipped: (RESEND|SENDMODE)/.test(r.last_error))).toBe(true);

    // Asking again while the link is live does not create a second session.
    await pool.query("INSERT INTO jobs (kind, payload) VALUES ('deposit.link', $1)", [JSON.stringify({ bookingId })]);
    await drain();
    expect(stripe.calls.filter((c) => c.method === 'sessions.create')).toHaveLength(1);
  });

  it('rejects webhooks with a bad signature and ignores unrelated events', async () => {
    const bad = await webhook({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }, 'whsec_wrong');
    expect(bad.statusCode).toBe(400);
    const unsigned = await app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(400);
    const other = await webhook({ id: 'evt_other', type: 'payment_intent.created', data: { object: { id: 'pi_x', metadata: {} } } });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ received: true, outcome: 'ignored' });
  });

  it('marks the deposit paid from a signed checkout.session.completed, exactly once', async () => {
    const event = {
      id: 'evt_paid_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          payment_status: 'paid',
          payment_intent: 'pi_test_1',
          amount_total: 3000,
          currency: 'eur',
          client_reference_id: bookingId,
          metadata: { bookingId, reference: ref },
        },
      },
    };
    // A first delivery that fails part-way (here: the payment row is rejected) must not use up the event id,
    // otherwise Stripe's retry would be skipped as a duplicate and the paid deposit lost.
    const broken = { ...event, data: { object: { ...event.data.object, amount_total: 'not-a-number' } } };
    expect((await webhook(broken)).statusCode).toBe(500);
    expect((await pool.query("SELECT 1 FROM stripe_events WHERE id = 'evt_paid_1'")).rowCount).toBe(0);

    const res = await webhook(event);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('paid');

    const tracked = await call('POST', '/bookings/track', { reference: ref, phone: '089 470 9672' });
    expect(tracked.json.booking.deposit).toMatchObject({ status: 'paid', payUrl: null });
    expect(tracked.json.booking.deposit.paidAt).toBeTruthy();
    expect(tracked.json.booking.timeline.map((t: any) => t.type)).toContain('deposit_paid');

    const payments = await pool.query('SELECT kind, amount_cents, stripe_id, status FROM payments WHERE booking_id = $1', [bookingId]);
    expect(payments.rows).toEqual([{ kind: 'deposit', amount_cents: 3000, stripe_id: 'pi_test_1', status: 'succeeded' }]);

    const notify = await pool.query("SELECT payload->>'channel' AS channel FROM jobs WHERE payload->>'template' = 'deposit_paid'");
    expect(notify.rows.map((r) => r.channel).sort()).toEqual(['customer_email', 'customer_sms', 'owner_email', 'owner_sms']);

    // Stripe redelivers: same event id is a no-op, and a second completed event for the same booking is too.
    expect((await webhook(event)).json().outcome).toBe('duplicate');
    expect((await webhook({ ...event, id: 'evt_paid_2' })).json().outcome).toBe('duplicate');
    const events = await pool.query("SELECT count(*) AS n FROM booking_events WHERE booking_id = $1 AND type = 'deposit_paid'", [bookingId]);
    expect(Number(events.rows[0].n)).toBe(1);
  });

  it('refunds a paid deposit automatically when the customer cancels', async () => {
    await pool.query('DELETE FROM jobs');
    const res = await call('POST', '/bookings/track/cancel', { reference: ref, phone: '089 470 9672', reason: 'Change of plan' });
    expect(res.status).toBe(200);
    expect(res.json.booking.status).toBe('cancelled');

    const queued = await pool.query("SELECT kind FROM jobs WHERE kind LIKE 'deposit.%'");
    expect(queued.rows.map((r) => r.kind)).toEqual(['deposit.refund']);
    await drain();

    const refund = stripe.calls.find((c) => c.method === 'refunds.create')!;
    expect((refund.args[0] as Stripe.RefundCreateParams).payment_intent).toBe('pi_test_1');
    expect((refund.args[1] as any).idempotencyKey).toBe('refund:pi_test_1');

    const detail = await call('GET', `/admin/bookings/${ref}`, undefined, admin());
    expect(detail.json.booking.deposit.status).toBe('refunded');
    expect(detail.json.booking.depositRefundId).toBe('re_test_pi_test_1');
    expect(detail.json.events.map((e: any) => e.type)).toContain('deposit_refunded');
    const payments = await pool.query('SELECT kind, amount_cents FROM payments WHERE booking_id = $1 ORDER BY created_at', [bookingId]);
    expect(payments.rows.map((r) => r.kind)).toEqual(['deposit', 'refund']);

    // A retry of the refund job must not refund twice.
    await pool.query("INSERT INTO jobs (kind, payload) VALUES ('deposit.refund', $1)", [JSON.stringify({ bookingId })]);
    await drain();
    expect(stripe.calls.filter((c) => c.method === 'refunds.create')).toHaveLength(1);
  });

  it('expires an unpaid link when a booking is cancelled, and the link disappears from tracking', async () => {
    const created = await call('POST', '/bookings', {
      serviceCode: 'mini',
      date: day,
      period: 'afternoon',
      name: 'Pat Byrne',
      phone: '087 123 4567',
      vehicle: 'Ford Focus',
    });
    const ref2 = created.json.booking.reference;
    await call('PATCH', `/admin/bookings/${ref2}`, { depositStatus: 'requested' }, admin());
    await drain();
    let t = await call('POST', '/bookings/track', { reference: ref2, phone: '087 123 4567' });
    expect(t.json.booking.deposit.payUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_2');

    await call('PATCH', `/admin/bookings/${ref2}`, { status: 'cancelled', note: 'Owner cancelled' }, admin());
    await drain();
    expect(stripe.calls.some((c) => c.method === 'sessions.expire' && c.args[0] === 'cs_test_2')).toBe(true);
    t = await call('POST', '/bookings/track', { reference: ref2, phone: '087 123 4567' });
    expect(t.json.booking.deposit.payUrl).toBeNull();

    // Stripe's own expiry event for an already-cancelled booking is harmless.
    const id2 = (await pool.query('SELECT id FROM bookings WHERE reference = $1', [ref2.replace(/^SJP-/, '').replace('-', '')])).rows[0].id;
    const exp = await webhook({ id: 'evt_exp_2', type: 'checkout.session.expired', data: { object: { id: 'cs_test_2', object: 'checkout.session', metadata: { bookingId: id2 } } } });
    expect(exp.json().outcome).toBe('expired');
  });

  it('only lets the owner refund a paid deposit', async () => {
    const created = await call('POST', '/bookings', { serviceCode: 'mini', date: day, period: 'evening', name: 'Ann', phone: '086 555 5555', vehicle: 'Mini' });
    const r = await call('PATCH', `/admin/bookings/${created.json.booking.reference}`, { depositStatus: 'refunded' }, admin());
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('INVALID_TRANSITION');
  });
});
