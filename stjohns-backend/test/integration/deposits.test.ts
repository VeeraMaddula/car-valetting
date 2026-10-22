// End-to-end deposit flow against real PostgreSQL (a Neon dev branch) with a stubbed Stripe client.
// Run: put TEST_DATABASE_URL=<dev branch connection string> in .env, then npm test
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
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test-db.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const WHSEC = 'whsec_test_secret_0123456789';
const SITE = 'http://localhost:5500';

/**
 * A fake Stripe: records calls, hands back deterministic sessions/refunds, verifies real signatures. Like Stripe,
 * it answers a repeated idempotency key with the original result, and rejects the key with different parameters.
 */
function fakeStripe() {
  const calls: { method: string; args: unknown[] }[] = [];
  let sessions = 0;
  const real = new Stripe('sk_test_fake');
  const replays = new Map<string, { params: string; result: unknown }>();
  const refundCount = new Map<string, number>();
  const refundState = new Map<string, { id: string; amount: number; status: string; payment_intent: string }>();
  function idempotent<T>(key: string, params: unknown, make: () => T): T {
    const seen = replays.get(key);
    if (seen) {
      if (seen.params !== JSON.stringify(params)) {
        throw new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.', type: 'idempotency_error' });
      }
      return seen.result as T;
    }
    const result = make();
    replays.set(key, { params: JSON.stringify(params), result });
    return result;
  }
  const fake = {
    calls,
    /** Make the next create succeed at "Stripe" but lose its reply, as a dropped connection would. */
    loseNextCreateReply: false,
    /** Stripe moves expiries a little; tests check we keep Stripe's, not our own. */
    expiryShiftSeconds: 0,
    retrieveError: null as Error | null,
    nextRefundStatus: 'succeeded',
    /** Make refunds fail outright, as Stripe does for e.g. a disputed payment. */
    refundError: null as Error | null,
    refundState,
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => {
          calls.push({ method: 'sessions.create', args: [params, opts] });
          const session = idempotent(opts.idempotencyKey, params, () => {
            sessions += 1;
            return { id: `cs_test_${sessions}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sessions}`, status: 'open', expires_at: params.expires_at! - fake.expiryShiftSeconds };
          });
          if (fake.loseNextCreateReply) {
            fake.loseNextCreateReply = false;
            throw new Stripe.errors.StripeConnectionError({ message: 'socket hang up', type: 'api_error' });
          }
          return session;
        },
        retrieve: async (id: string) => {
          calls.push({ method: 'sessions.retrieve', args: [id] });
          if (fake.retrieveError) throw fake.retrieveError;
          return { id, status: 'open' };
        },
        expire: async (id: string) => {
          calls.push({ method: 'sessions.expire', args: [id] });
          return { id, status: 'expired' };
        },
      },
    },
    refunds: {
      create: async (params: Stripe.RefundCreateParams, opts: { idempotencyKey: string }) => {
        calls.push({ method: 'refunds.create', args: [params, opts] });
        if (fake.refundError) throw fake.refundError;
        return idempotent(opts.idempotencyKey, params, () => {
          const intent = String(params.payment_intent);
          const n = (refundCount.get(intent) ?? 0) + 1;
          refundCount.set(intent, n);
          const refund = { id: n === 1 ? `re_test_${intent}` : `re_test_${intent}_${n}`, amount: 3000, status: fake.nextRefundStatus, payment_intent: intent };
          refundState.set(refund.id, refund);
          return { ...refund };
        });
      },
      retrieve: async (id: string) => {
        calls.push({ method: 'refunds.retrieve', args: [id] });
        return { ...refundState.get(id)! };
      },
    },
    webhooks: real.webhooks,
  };
  return fake;
}

suite('deposit payments on PostgreSQL', () => {
  let testDb: TestDatabase;
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let deps: Deps;
  let worker: JobWorker;
  let stripe: ReturnType<typeof fakeStripe>;
  let adminCookie: string;
  let day: string;
  let freeDays: string[] = [];

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
    testDb = await createTestDatabase('sjp_deposits');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testDb.url,
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
    deps = { config, db: pool, settings: new SettingsCache(pool, config), wakeWorker: () => undefined };
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
    freeDays = res.json.days.filter((d: any) => d.open && d.available === 3).map((d: any) => d.date);
    day = freeDays.shift()!;
  });

  afterAll(async () => {
    setStripeClientForTests(null);
    await app?.close();
    await pool?.end();
    await testDb?.drop().catch(() => undefined);
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
    expect((create.args[1] as any).idempotencyKey).toMatch(new RegExp(`^deposit:${bookingId}:[0-9a-f-]{36}$`));
    // The saved request is cleared once the session is stored; the link's expiry is the one Stripe returned.
    const stored = (await pool.query('SELECT deposit_checkout_request, deposit_link_expires_at FROM bookings WHERE id = $1', [bookingId])).rows[0];
    expect(stored.deposit_checkout_request).toBeNull();
    expect(stored.deposit_link_expires_at.getTime()).toBe(params.expires_at! * 1000);

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
    expect(detail.json.booking.deposit).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    expect(detail.json.booking.depositRefundId).toBe('re_test_pi_test_1');
    expect(detail.json.events.map((e: any) => e.type)).toContain('deposit_refunded');
    const told = await pool.query("SELECT payload->>'channel' AS c FROM jobs WHERE payload->>'template' = 'deposit_refunded' ORDER BY c");
    expect(told.rows.map((r) => r.c)).toEqual(['customer_email', 'customer_sms']);
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

  // ---------- fix.md findings 6-8 ----------

  const idOf = async (reference: string) =>
    (await pool.query('SELECT id FROM bookings WHERE reference = $1', [reference.replace(/^SJP-/, '').replace('-', '')])).rows[0].id as string;

  /** A confirmed booking whose deposit was paid online through payment intent `intent`. */
  async function paidBooking(intent: string, name: string, phone: string) {
    const created = await call('POST', '/bookings', { serviceCode: 'mini', date: freeDays.shift(), period: 'morning', name, phone, email: `${intent}@example.com`, vehicle: 'Ford Focus' });
    expect(created.status).toBe(201);
    const reference: string = created.json.booking.reference;
    const id = await idOf(reference);
    await call('PATCH', `/admin/bookings/${reference}`, { status: 'confirmed', depositStatus: 'requested' }, admin());
    await drain();
    const session = { id: `cs_for_${intent}`, object: 'checkout.session', payment_status: 'paid', payment_intent: intent, amount_total: 3000, currency: 'eur', metadata: { bookingId: id, reference } };
    expect((await webhook({ id: `evt_paid_${intent}`, type: 'checkout.session.completed', data: { object: session } })).json().outcome).toBe('paid');
    await pool.query('DELETE FROM jobs');
    return { id, reference };
  }

  const refundEvent = (id: string, type: string, refund: { id: string; status: string; payment_intent: string }, bookingId?: string) => ({
    id,
    type,
    data: { object: { object: 'refund', amount: 3000, ...refund, metadata: bookingId ? { bookingId } : {} } },
  });

  const notices = async (bookingId: string) =>
    (
      await pool.query("SELECT payload->>'channel' AS c, payload->>'template' AS t FROM jobs WHERE kind = 'notify' AND payload->>'bookingId' = $1 ORDER BY c", [bookingId])
    ).rows.map((r) => `${r.c}:${r.t}`);

  it('resends the saved Checkout request after a lost reply, so Stripe returns the session it made (finding 6)', async () => {
    const created = await call('POST', '/bookings', { serviceCode: 'mini', date: freeDays.shift(), period: 'morning', name: 'Lost Reply', phone: '087 111 2201', vehicle: 'Mini' });
    const reference = created.json.booking.reference;
    const id = await idOf(reference);
    const before = stripe.calls.filter((c) => c.method === 'sessions.create').length;
    stripe.loseNextCreateReply = true;
    stripe.expiryShiftSeconds = 90;
    try {
      await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'requested' }, admin());
      await drain();
      // Stripe made the session, but its reply was lost: nothing stored yet, the request is saved for the retry.
      const saved = (await pool.query('SELECT deposit_checkout_request, deposit_pay_url FROM bookings WHERE id = $1', [id])).rows[0];
      expect(saved.deposit_pay_url).toBeNull();
      expect(JSON.parse(saved.deposit_checkout_request).idempotencyKey).toMatch(new RegExp(`^deposit:${id}:`));

      await new Promise((r) => setTimeout(r, 1100)); // the retry comes later, when a fresh expiry would differ
      await pool.query("UPDATE jobs SET run_at = now() WHERE kind = 'deposit.link' AND status = 'pending'");
      await drain();
    } finally {
      stripe.expiryShiftSeconds = 0;
    }
    const creates = stripe.calls.filter((c) => c.method === 'sessions.create').slice(before);
    expect(creates).toHaveLength(2);
    expect(creates[1].args).toEqual(creates[0].args); // same key, same parameters: Stripe replays, no second session
    const params = creates[0].args[0] as Stripe.Checkout.SessionCreateParams;
    const row = (await pool.query('SELECT deposit_pay_url, deposit_link_expires_at, deposit_checkout_request FROM bookings WHERE id = $1', [id])).rows[0];
    expect(row.deposit_pay_url).toMatch(/checkout\.stripe\.com/);
    expect(row.deposit_link_expires_at.getTime()).toBe((params.expires_at! - 90) * 1000); // Stripe's expiry, not ours
    expect(row.deposit_checkout_request).toBeNull();
    const jobs = await pool.query("SELECT status FROM jobs WHERE kind = 'deposit.link' AND payload->>'bookingId' = $1", [id]);
    expect(jobs.rows.map((r) => r.status)).toEqual(['done']);
  });

  it('fails the expiry job and keeps the link when Stripe rejects the API key (finding 7)', async () => {
    const created = await call('POST', '/bookings', { serviceCode: 'mini', date: freeDays.shift(), period: 'morning', name: 'Key Revoked', phone: '087 111 2202', vehicle: 'Mini' });
    const reference = created.json.booking.reference;
    const id = await idOf(reference);
    await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'requested' }, admin());
    await drain();
    const link = (await pool.query('SELECT deposit_pay_url FROM bookings WHERE id = $1', [id])).rows[0].deposit_pay_url;
    expect(link).toMatch(/checkout\.stripe\.com/);

    stripe.retrieveError = new Stripe.errors.StripeAuthenticationError({ message: 'Invalid API Key provided', type: 'authentication_error' });
    try {
      await call('PATCH', `/admin/bookings/${reference}`, { status: 'cancelled', note: 'Owner cancelled' }, admin());
      await drain();
    } finally {
      stripe.retrieveError = null;
    }
    const job = (await pool.query("SELECT status, last_error FROM jobs WHERE kind = 'deposit.expire' AND payload->>'bookingId' = $1", [id])).rows[0];
    expect(job.status).toBe('failed');
    expect(job.last_error).toMatch(/authentication/i);
    expect((await pool.query('SELECT deposit_pay_url FROM bookings WHERE id = $1', [id])).rows[0].deposit_pay_url).toBe(link);
  });

  it('counts a refund only once Stripe says it succeeded, and tells the customer then (finding 8)', async () => {
    const { id, reference } = await paidBooking('pi_pending', 'Pending Refund', '087 111 2203');
    stripe.nextRefundStatus = 'pending';
    try {
      const asked = await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin());
      expect(asked.status).toBe(200);
      expect(asked.json.booking.deposit).toMatchObject({ status: 'paid', refundStatus: 'requested' });
      expect((await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin())).status).toBe(409); // already in progress
      await drain();
    } finally {
      stripe.nextRefundStatus = 'succeeded';
    }
    let detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'paid', refundStatus: 'pending' });
    const types = detail.json.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['deposit_refund_requested', 'deposit_refund_pending']));
    expect(types).not.toContain('deposit_refunded');
    expect(await notices(id)).toEqual([]); // nothing to the customer while it's pending
    const check = await pool.query("SELECT run_at FROM jobs WHERE kind = 'deposit.refund' AND status = 'pending' AND payload->>'bookingId' = $1", [id]);
    expect(check.rows).toHaveLength(1); // a follow-up check, in case the webhook never comes
    expect(check.rows[0].run_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    const done = refundEvent('evt_refund_ok', 'refund.updated', { id: 're_test_pi_pending', status: 'succeeded', payment_intent: 'pi_pending' }, id);
    expect((await webhook(done)).json().outcome).toBe('refunded');
    detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    expect(await notices(id)).toEqual(['customer_email:deposit_refunded', 'customer_sms:deposit_refunded']);
    expect((await webhook({ ...done, id: 'evt_refund_ok_2' })).json().outcome).toBe('duplicate');

    // The follow-up check finds it settled and changes nothing.
    await pool.query("UPDATE jobs SET run_at = now() WHERE kind = 'deposit.refund' AND status = 'pending'");
    await drain();
    expect(await notices(id)).toHaveLength(2);
    const payments = await pool.query("SELECT stripe_id, status FROM payments WHERE booking_id = $1 AND kind = 'refund'", [id]);
    expect(payments.rows).toEqual([{ stripe_id: 're_test_pi_pending', status: 'succeeded' }]);
  });

  it('checks on a pending refund itself when no webhook arrives (finding 8)', async () => {
    const { id, reference } = await paidBooking('pi_quiet', 'Quiet Refund', '087 111 2206');
    stripe.nextRefundStatus = 'pending';
    try {
      await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin());
      await drain();
    } finally {
      stripe.nextRefundStatus = 'succeeded';
    }
    stripe.refundState.get('re_test_pi_quiet')!.status = 'succeeded'; // settled at Stripe; its webhook is lost
    await pool.query("UPDATE jobs SET run_at = now() WHERE kind = 'deposit.refund' AND status = 'pending'");
    await drain();
    expect(stripe.calls.some((c) => c.method === 'refunds.retrieve' && c.args[0] === 're_test_pi_quiet')).toBe(true);
    const detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    expect(await notices(id)).toEqual(['customer_email:deposit_refunded', 'customer_sms:deposit_refunded']);
  });

  it('puts a failed refund back to paid, alerts the owner, and lets them try again (finding 8)', async () => {
    const { id, reference } = await paidBooking('pi_fails', 'Failed Refund', '087 111 2204');
    stripe.nextRefundStatus = 'pending';
    try {
      await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin());
      await drain();
    } finally {
      stripe.nextRefundStatus = 'succeeded';
    }
    const failed = refundEvent('evt_refund_failed', 'refund.failed', { id: 're_test_pi_fails', status: 'failed', payment_intent: 'pi_fails' }, id);
    expect((await webhook(failed)).json().outcome).toBe('refund_failed');
    let detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'paid', refundStatus: 'failed' });
    expect(detail.json.events.map((e: any) => e.type)).toContain('deposit_refund_failed');
    expect(await notices(id)).toEqual(['owner_email:deposit_refund_failed', 'owner_sms:deposit_refund_failed']);
    expect((await webhook({ ...failed, id: 'evt_refund_failed_2', type: 'refund.updated' })).json().outcome).toBe('duplicate');

    // The owner tries again: a new idempotency key, so Stripe makes a new refund rather than replaying the failed one.
    expect((await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin())).status).toBe(200);
    await drain();
    const keys = stripe.calls
      .filter((c) => c.method === 'refunds.create' && (c.args[0] as Stripe.RefundCreateParams).payment_intent === 'pi_fails')
      .map((c) => (c.args[1] as any).idempotencyKey);
    expect(keys).toEqual(['refund:pi_fails', 'refund:pi_fails:retry:1']);
    detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    expect(detail.json.booking.depositRefundId).toBe('re_test_pi_fails_2');
    expect(await notices(id)).toEqual(expect.arrayContaining(['customer_email:deposit_refunded', 'customer_sms:deposit_refunded']));
    // The old failed refund reporting late doesn't undo the one that succeeded.
    expect((await webhook({ ...failed, id: 'evt_refund_failed_3' })).json().outcome).toBe('duplicate');
    expect((await call('GET', `/admin/bookings/${reference}`, undefined, admin())).json.booking.deposit.status).toBe('refunded');
  });

  it('records a refund Stripe refuses as failed, alerts the owner, and lets them try again (finding 8)', async () => {
    const { id, reference } = await paidBooking('pi_disputed', 'Disputed Refund', '087 111 2207');
    stripe.refundError = new Stripe.errors.StripeInvalidRequestError({ message: 'This charge is disputed', type: 'invalid_request_error', code: 'charge_disputed' });
    try {
      await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin());
      await drain();
    } finally {
      stripe.refundError = null;
    }
    const job = (await pool.query("SELECT status, last_error FROM jobs WHERE kind = 'deposit.refund' AND payload->>'bookingId' = $1", [id])).rows[0];
    expect(job.status).toBe('failed');
    expect(job.last_error).toMatch(/disputed/);
    let detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'paid', refundStatus: 'failed' }); // not stuck on "requested"
    expect(await notices(id)).toEqual(['owner_email:deposit_refund_failed', 'owner_sms:deposit_refund_failed']);

    expect((await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin())).status).toBe(200);
    await drain();
    detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    const keys = stripe.calls.filter((c) => c.method === 'refunds.create' && (c.args[0] as Stripe.RefundCreateParams).payment_intent === 'pi_disputed').map((c) => (c.args[1] as any).idempotencyKey);
    expect(keys).toEqual(['refund:pi_disputed', 'refund:pi_disputed:retry:1']);
  });

  it('stops showing "refund requested" when the worker gives up on Stripe, so the owner can retry (finding 8)', async () => {
    const { id, reference } = await paidBooking('pi_outage', 'Outage Refund', '087 111 2208');
    stripe.refundError = new Stripe.errors.StripeConnectionError({ message: 'Stripe is unreachable', type: 'api_error' });
    try {
      await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin());
      await pool.query("UPDATE jobs SET max_attempts = 1 WHERE kind = 'deposit.refund' AND payload->>'bookingId' = $1", [id]); // give up at once
      await drain();
    } finally {
      stripe.refundError = null;
    }
    const job = (await pool.query("SELECT status FROM jobs WHERE kind = 'deposit.refund' AND payload->>'bookingId' = $1", [id])).rows[0];
    expect(job.status).toBe('failed');
    expect((await call('GET', `/admin/bookings/${reference}`, undefined, admin())).json.booking.deposit).toMatchObject({ status: 'paid', refundStatus: 'failed' });
    expect(await notices(id)).toEqual(['owner_email:deposit_refund_failed', 'owner_sms:deposit_refund_failed']);
    expect((await call('PATCH', `/admin/bookings/${reference}`, { depositStatus: 'refunded' }, admin())).status).toBe(200);
  });

  it('mirrors a refund made in the Stripe dashboard without messaging the customer (finding 8)', async () => {
    const { id, reference } = await paidBooking('pi_dash', 'Dashboard Refund', '087 111 2205');
    // A partial refund (€5 of €30) doesn't make the deposit refunded.
    const partial = { id: 'evt_dash_partial', type: 'refund.created', data: { object: { id: 're_dash_part', object: 'refund', amount: 500, status: 'succeeded', payment_intent: 'pi_dash', metadata: {} } } };
    expect((await webhook(partial)).json().outcome).toBe('ignored');
    expect((await call('GET', `/admin/bookings/${reference}`, undefined, admin())).json.booking.deposit.status).toBe('paid');
    // No metadata: the booking is found by its payment.
    expect((await webhook(refundEvent('evt_dash_1', 'refund.created', { id: 're_dash_1', status: 'succeeded', payment_intent: 'pi_dash' }))).json().outcome).toBe('refunded');
    const detail = await call('GET', `/admin/bookings/${reference}`, undefined, admin());
    expect(detail.json.booking.deposit).toMatchObject({ status: 'refunded', refundStatus: 'succeeded' });
    expect(await notices(id)).toEqual([]);
    const charge = { id: 'ch_dash', object: 'charge', refunded: true, payment_intent: 'pi_dash', metadata: { bookingId: id } };
    expect((await webhook({ id: 'evt_dash_2', type: 'charge.refunded', data: { object: charge } })).json().outcome).toBe('duplicate');
    // A refund of a payment that isn't a deposit here is ignored.
    expect((await webhook(refundEvent('evt_other_refund', 'refund.updated', { id: 're_x', status: 'failed', payment_intent: 'pi_unknown' }))).json().outcome).toBe('ignored');
  });
});
