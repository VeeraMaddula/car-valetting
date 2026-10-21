// End-to-end API tests against real PostgreSQL (a Neon dev branch).
// Run: put TEST_DATABASE_URL=<dev branch connection string> in .env, then npm test
import pg from 'pg';
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
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test-db.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

type App = Awaited<ReturnType<typeof buildApp>>;
const FEED_KEY = 'k'.repeat(32);
const SITE = 'http://localhost:5500';

suite('booking API on PostgreSQL', () => {
  let testDb: TestDatabase;
  let pool: pg.Pool;
  let app: App;
  let deps: Deps;
  let days: string[] = [];

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload: body as object | undefined, headers });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, headers: res.headers, body: res.body };
  }

  function sessionCookie(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const first = Array.isArray(raw) ? raw[0] : String(raw);
    return first.split(';')[0];
  }

  const booking = (date: string, period: string, extra: Record<string, unknown> = {}) => ({
    serviceCode: 'full',
    date,
    period,
    name: 'Test Customer',
    phone: '089 470 9672',
    email: 'test@example.com',
    vehicle: 'VW Golf, black',
    ...extra,
  });

  beforeAll(async () => {
    testDb = await createTestDatabase('sjp_api');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testDb.url,
      PUBLIC_SITE_URL: SITE,
      PUBLIC_API_URL: 'http://localhost:8080',
      ALLOWED_ORIGINS: SITE,
      OWNER_EMAIL: 'owner@example.com',
      OWNER_PHONE: '089 470 9672',
      ADMIN_CALENDAR_FEED_KEY: FEED_KEY,
      LOG_LEVEL: 'silent',
    });
    pool = createPool(config);
    await migrate(pool, () => undefined);
    deps = { config, db: pool, settings: new SettingsCache(pool, config), wakeWorker: () => undefined };
    app = await buildApp(deps, { logger: false, rateLimit: false });

    // Pick days where all three slots are free, at least 2 days out so they're outside the 24h cancellation cut-off.
    const today = todayInZone(config.TIMEZONE);
    const res = await call('GET', `/availability?from=${addDays(today, 2)}&to=${addDays(today, 30)}`);
    days = res.json.days.filter((d: any) => d.open && d.available === 3).map((d: any) => d.date);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await testDb?.drop().catch(() => undefined);
  });

  it('serves config, health and availability', async () => {
    const health = await call('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json.ok).toBe(true);
    expect(health.headers['server-timing']).toMatch(/^app;dur=/);

    const config = await call('GET', '/config');
    expect(config.json.services.map((s: any) => s.code)).toEqual(['mini', 'standard', 'full', 'polish']);
    expect(config.json.services.find((s: any) => s.code === 'mini')).toMatchObject({ priceEur: 50, priceFrom: false });
    expect(config.json.services.find((s: any) => s.code === 'full')).toMatchObject({ priceEur: 130, priceFrom: true });
    expect(config.json.periods.map((p: any) => p.code)).toEqual(['morning', 'afternoon', 'evening']);
    expect(days.length).toBeGreaterThanOrEqual(5);

    const sunday = (await call('GET', `/availability?from=${days[0]}&to=${addDays(days[0], 6)}`)).json.days.find((d: any) => d.weekday === 0);
    expect(sunday).toMatchObject({ open: false, reason: 'closed', available: 0 });

    expect((await call('GET', '/availability?from=2026-01-01&to=2026-12-31')).status).toBe(400);
    expect((await call('GET', '/availability?from=not-a-date')).status).toBe(400);
  });

  let guest: any;

  it('takes a guest booking, queues notifications and blocks the slot', async () => {
    const res = await call('POST', '/bookings', booking(days[0], 'morning'));
    expect(res.status).toBe(201);
    guest = res.json.booking;
    expect(guest.reference).toMatch(/^SJP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(guest).toMatchObject({ status: 'pending', date: days[0], canCancel: true, phone: '089 470 9672' });

    const jobs = await pool.query(
      "SELECT payload->>'channel' AS channel, payload->>'template' AS template FROM jobs WHERE kind = 'notify'",
    );
    const sent = jobs.rows.map((r) => `${r.channel}:${r.template}`);
    expect(sent).toEqual(expect.arrayContaining(['customer_email:created', 'customer_sms:created', 'owner_email:created', 'owner_sms:created']));

    const again = await call('POST', '/bookings', booking(days[0], 'morning', { name: 'Someone Else', phone: '087 123 4567' }));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('SLOT_UNAVAILABLE');

    const avail = await call('GET', `/availability?from=${days[0]}&to=${days[0]}`);
    expect(avail.json.days[0].slots.map((s: any) => s.status)).toEqual(['booked', 'available', 'available']);
  });

  it('never double-books a slot, even with simultaneous requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call('POST', '/bookings', booking(days[0], 'afternoon', { name: `Racer ${i}` }))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const { rows } = await pool.query("SELECT count(*) AS n FROM bookings WHERE slot_date = $1 AND period = 'afternoon'", [days[0]]);
    expect(Number(rows[0].n)).toBe(1);
  });

  let idempotent: any;

  it('treats a retried request with the same Idempotency-Key as the same booking', async () => {
    const headers = { 'idempotency-key': 'retry-key-0001' };
    const first = await call('POST', '/bookings', booking(days[0], 'evening'), headers);
    const second = await call('POST', '/bookings', booking(days[0], 'evening'), headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.booking.reference).toBe(first.json.booking.reference);
    idempotent = first.json.booking;
  });

  it('validates input with field-level messages', async () => {
    const missing = await call('POST', '/bookings', { serviceCode: 'full', date: days[1], period: 'morning' });
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.json.error.fields)).toEqual(expect.arrayContaining(['name', 'phone', 'vehicle']));

    const badPhone = await call('POST', '/bookings', booking(days[1], 'morning', { phone: '12345' }));
    expect(badPhone.json.error.fields.phone).toBeTruthy();

    const noAddress = await call('POST', '/bookings', booking(days[1], 'morning', { handover: 'collection' }));
    expect(noAddress.json.error.fields.collectionAddress).toBeTruthy();

    const badService = await call('POST', '/bookings', booking(days[1], 'morning', { serviceCode: 'nope' }));
    expect(badService.json.error.fields.serviceCode).toBeTruthy();

    const past = await call('POST', '/bookings', booking('2020-01-06', 'morning'));
    expect(past.status).toBe(409);

    const notJson = await app.inject({ method: 'POST', url: '/api/v1/bookings', payload: '{bad json', headers: { 'content-type': 'application/json' } });
    expect(notJson.statusCode).toBe(400);
  });

  it('lets a guest track and cancel with reference + phone, freeing the slot', async () => {
    const loose = guest.reference.toLowerCase().replace(/-/g, ' ');
    const tracked = await call('POST', '/bookings/track', { reference: loose, phone: '+353 89 470 9672' });
    expect(tracked.status).toBe(200);
    expect(tracked.json.booking.phone).toBe('••• ••• •672');
    expect(tracked.json.booking.timeline.map((t: any) => t.type)).toEqual(['created']);

    expect((await call('POST', '/bookings/track', { reference: guest.reference, phone: '087 000 0000' })).status).toBe(404);
    expect((await call('POST', '/bookings/track', { reference: 'SJP-0000-0000', phone: '089 470 9672' })).status).toBe(404);

    const cancelled = await call('POST', '/bookings/track/cancel', { reference: guest.reference, phone: '0894709672', reason: 'Plans changed' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.booking.status).toBe('cancelled');

    const avail = await call('GET', `/availability?from=${days[0]}&to=${days[0]}`);
    expect(avail.json.days[0].slots[0].status).toBe('available');
    expect((await call('POST', '/bookings', booking(days[0], 'morning', { name: 'Rebooker' }))).status).toBe(201);
  });

  it('serves an Apple/Google calendar file only with the right token', async () => {
    const url = new URL(idempotent.calendarUrl);
    const ok = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/calendar');
    expect(ok.body).toContain('BEGIN:VCALENDAR');
    const bad = await app.inject({ method: 'GET', url: url.pathname + '?t=wrong' });
    expect(bad.statusCode).toBe(404);
  });

  let cookie = '';

  it('registers, signs in and out, with clear errors', async () => {
    const res = await call('POST', '/auth/register', {
      username: 'Jane.Doe',
      email: 'Jane@Example.com',
      password: 'correct horse battery',
      fullName: 'Jane Doe',
      phone: '087 123 4567',
    });
    expect(res.status).toBe(201);
    expect(res.json.user).toMatchObject({ username: 'jane.doe', email: 'jane@example.com', role: 'customer' });
    cookie = sessionCookie(res);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);

    const me = await call('GET', '/auth/me', undefined, { cookie });
    expect(me.json.user.username).toBe('jane.doe');

    const dupe = await call('POST', '/auth/register', { username: 'jane.doe', email: 'x@example.com', password: 'another password', fullName: 'X Y', phone: '087 123 4567' });
    expect(dupe.status).toBe(409);
    expect(dupe.json.error.fields.username).toBeTruthy();
    const dupeEmail = await call('POST', '/auth/register', { username: 'jane2', email: 'JANE@example.com', password: 'another password', fullName: 'X Y', phone: '087 123 4567' });
    expect(dupeEmail.json.error.fields.email).toBeTruthy();
    const weak = await call('POST', '/auth/register', { username: 'weak', email: 'w@example.com', password: 'short', fullName: 'W W', phone: '087 123 4567' });
    expect(weak.json.error.fields.password).toBeTruthy();

    expect((await call('POST', '/auth/login', { login: 'jane.doe', password: 'wrong password!' })).status).toBe(401);
    expect((await call('POST', '/auth/login', { login: 'nobody', password: 'wrong password!' })).status).toBe(401);
    const byEmail = await call('POST', '/auth/login', { login: 'JANE@EXAMPLE.COM', password: 'correct horse battery' });
    expect(byEmail.status).toBe(200);
    cookie = sessionCookie(byEmail);

    expect((await call('GET', '/me/bookings')).status).toBe(401);
  });

  it('lists account bookings, claims guest bookings and hides other people’s', async () => {
    const mine = await call('POST', '/bookings', booking(days[1], 'morning', { email: null, phone: '087 123 4567' }), { cookie });
    expect(mine.status).toBe(201);
    expect(mine.json.booking.email).toBe('jane@example.com'); // falls back to the account email

    const claim = await call('POST', '/me/bookings/claim', { reference: idempotent.reference, phone: '089 470 9672' }, { cookie });
    expect(claim.status).toBe(200);

    const list = await call('GET', '/me/bookings', undefined, { cookie });
    expect(list.json.bookings.map((b: any) => b.reference)).toEqual(expect.arrayContaining([mine.json.booking.reference, idempotent.reference]));

    const detail = await call('GET', `/me/bookings/${mine.json.booking.reference}`, undefined, { cookie });
    expect(detail.json.booking.timeline[0].type).toBe('created');

    const other = await call('POST', '/auth/register', { username: 'other', email: 'other@example.com', password: 'other password 1', fullName: 'Other Person', phone: '086 765 4321' });
    const otherCookie = sessionCookie(other);
    expect((await call('GET', `/me/bookings/${mine.json.booking.reference}`, undefined, { cookie: otherCookie })).status).toBe(404);
    expect((await call('POST', '/me/bookings/claim', { reference: idempotent.reference, phone: '089 470 9672' }, { cookie: otherCookie })).status).toBe(404);

    const cancel = await call('POST', `/me/bookings/${mine.json.booking.reference}/cancel`, {}, { cookie });
    expect(cancel.json.booking.status).toBe('cancelled');
  });

  it('blocks cross-site writes', async () => {
    const res = await call('POST', '/bookings', booking(days[2], 'morning'), { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    const ok = await call('POST', '/bookings', booking(days[2], 'morning'), { origin: SITE });
    expect(ok.status).toBe(201);
  });

  let adminCookie = '';

  it('lets the owner confirm bookings, enforce valid transitions and close slots', async () => {
    await pool.query(
      "INSERT INTO users (username, email, full_name, phone, password_hash, role) VALUES ('owner', 'owner@example.com', 'Owner', '+353894709672', $1, 'admin')",
      [await hashPassword('owner password 1')],
    );
    adminCookie = sessionCookie(await call('POST', '/auth/login', { login: 'owner', password: 'owner password 1' }));

    expect((await call('GET', `/admin/bookings?from=${days[0]}&to=${days[2]}`, undefined, { cookie })).status).toBe(403);
    const list = await call('GET', `/admin/bookings?from=${days[0]}&to=${days[2]}&status=pending`, undefined, { cookie: adminCookie });
    expect(list.status).toBe(200);
    expect(list.json.bookings.length).toBeGreaterThan(0);
    expect(list.json.bookings[0].phoneE164).toMatch(/^\+353/);

    const ref = idempotent.reference;
    const confirmed = await call('PATCH', `/admin/bookings/${ref}`, { status: 'confirmed', depositStatus: 'requested' }, { cookie: adminCookie });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.booking).toMatchObject({ status: 'confirmed', deposit: { status: 'requested' } });

    const completed = await call('PATCH', `/admin/bookings/${ref}`, { status: 'completed' }, { cookie: adminCookie });
    expect(completed.json.booking.status).toBe('completed');
    const invalid = await call('PATCH', `/admin/bookings/${ref}`, { status: 'confirmed' }, { cookie: adminCookie });
    expect(invalid.status).toBe(409);
    expect(invalid.json.error.code).toBe('INVALID_TRANSITION');

    const detail = await call('GET', `/admin/bookings/${ref}`, undefined, { cookie: adminCookie });
    expect(detail.json.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['created', 'claimed', 'confirmed', 'deposit_requested', 'completed']));

    const block = await call('POST', '/admin/blocks', { date: days[3], period: 'all', reason: 'Bank holiday' }, { cookie: adminCookie });
    expect(block.status).toBe(201);
    const avail = await call('GET', `/availability?from=${days[3]}&to=${days[3]}`);
    expect(avail.json.days[0]).toMatchObject({ open: false, reason: 'blocked', available: 0 });
    expect((await call('POST', '/bookings', booking(days[3], 'evening'))).status).toBe(409);
    expect((await call('DELETE', `/admin/blocks/${block.json.block.id}`, undefined, { cookie: adminCookie })).status).toBe(200);
    expect((await call('POST', '/bookings', booking(days[3], 'evening'))).status).toBe(201);
  });

  it('lets the owner set slot times, shown to customers immediately', async () => {
    const res = await call(
      'PUT',
      '/admin/slot-periods/morning',
      { label: 'Morning', startTime: '09:00', endTime: '12:00', daysOfWeek: [1, 2, 3, 4, 5, 6], active: true },
      { cookie: adminCookie },
    );
    expect(res.status).toBe(200);
    const config = await call('GET', '/config');
    expect(config.json.periods[0]).toMatchObject({ startTime: '09:00', endTime: '12:00' });
    const bad = await call('PUT', '/admin/slot-periods/morning', { label: 'Morning', startTime: '12:00', endTime: '09:00', daysOfWeek: [1], active: true }, { cookie: adminCookie });
    expect(bad.status).toBe(400);
  });

  it('reports website analytics status and booking counts to admins only', async () => {
    const res = await call('GET', '/admin/analytics?range=30', undefined, { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ configured: false, rangeDays: 30 });
    expect(res.json.bookings).toBeGreaterThan(0);
    expect((await call('GET', '/admin/analytics?range=15', undefined, { cookie: adminCookie })).status).toBe(400);
    expect((await call('GET', '/admin/analytics', undefined, { cookie })).status).toBe(403);
    expect((await call('GET', '/config')).json.analytics).toEqual({ measurementId: null });
  });

  it('serves the owner calendar feed only with the secret key', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/v1/admin/calendar.ics?key=${FEED_KEY}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('X-WR-CALNAME:St Johns Park bookings');
    expect(ok.body).toContain('BEGIN:VEVENT');
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/calendar.ics?key=nope' })).statusCode).toBe(404);
  });

  it('resets a forgotten password and signs out old sessions', async () => {
    expect((await call('POST', '/auth/password/forgot', { email: 'nobody@example.com' })).status).toBe(202);
    expect((await call('POST', '/auth/password/forgot', { email: 'jane@example.com' })).status).toBe(202);
    const { rows } = await pool.query("SELECT payload->>'token' AS token FROM jobs WHERE kind = 'auth.password_reset' ORDER BY created_at DESC LIMIT 1");
    const token = rows[0].token;
    expect(token).toBeTruthy();

    expect((await call('POST', '/auth/password/reset', { token, password: 'brand new password' })).status).toBe(200);
    expect((await call('POST', '/auth/password/reset', { token, password: 'another new password' })).status).toBe(400);
    expect((await call('GET', '/auth/me', undefined, { cookie })).json.user).toBeNull();
    expect((await call('POST', '/auth/login', { login: 'jane.doe', password: 'brand new password' })).status).toBe(200);

    const fresh = sessionCookie(await call('POST', '/auth/login', { login: 'jane.doe', password: 'brand new password' }));
    await call('POST', '/auth/logout', {}, { cookie: fresh });
    expect((await call('GET', '/auth/me', undefined, { cookie: fresh })).json.user).toBeNull();
  });

  it('delivers queued jobs (skipping providers that are not configured) without failures', async () => {
    const worker = new JobWorker(deps, { info: () => undefined, warn: () => undefined, error: () => undefined });
    const processed = await worker.drain();
    expect(processed).toBeGreaterThan(0);
    const { rows } = await pool.query('SELECT status, count(*) AS n FROM jobs GROUP BY status');
    const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    expect(counts.failed ?? 0).toBe(0);
    expect(counts.running ?? 0).toBe(0);
    const tokens = await pool.query("SELECT count(*) AS n FROM jobs WHERE kind = 'auth.password_reset' AND payload ? 'token'");
    expect(Number(tokens.rows[0].n)).toBe(0); // reset tokens are wiped after sending
  });

  it('returns JSON for unknown routes', async () => {
    const res = await call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });
});
