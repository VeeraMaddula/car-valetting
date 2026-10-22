// End-to-end tests for the admin dashboard API against real PostgreSQL (a Neon dev branch).
// Run: put TEST_DATABASE_URL=<dev branch connection string> in .env, then npm test
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import type { Deps } from '../../src/deps.js';
import { SettingsCache } from '../../src/domain/settings.js';
import { grantAdmin, hashPassword } from '../../src/domain/users.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { addDays, todayInZone } from '../../src/lib/time.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test-db.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const SITE = 'http://localhost:5500';
type App = Awaited<ReturnType<typeof buildApp>>;
type Who = 'owner' | 'staff' | 'customer';

suite('admin dashboard API on PostgreSQL', () => {
  let testDb: TestDatabase;
  let pool: pg.Pool;
  let app: App;
  let deps: Deps;
  let worker: JobWorker;
  let today = '';
  let customerId = '';
  let settings: any;
  const cookies: Record<Who, string> = { owner: '', staff: '', customer: '' };
  let slots: { date: string; period: string }[] = [];

  const nextSlot = () => {
    const s = slots.shift();
    if (!s) throw new Error('ran out of free slots');
    return s;
  };

  /** `who` is a test user, or a raw session cookie. */
  async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, who?: Who | string | null) {
    const cookie = who ? (who in cookies ? cookies[who as Who] : who) : undefined;
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      payload: body as object | undefined,
      headers: { origin: SITE, ...(cookie ? { cookie } : {}) },
    });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, headers: res.headers, body: res.body };
  }

  const sessionCookie = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  };

  const guestBooking = (slot: { date: string; period: string }, extra: Record<string, unknown> = {}) => ({
    serviceCode: 'full',
    date: slot.date,
    period: slot.period,
    name: 'Guest Person',
    phone: '086 555 0101',
    email: 'guest@example.com',
    vehicle: 'Ford Focus',
    ...extra,
  });

  const jpeg = (width = 1600, height = 900, background = '#446688') =>
    sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();

  async function upload(buf: Buffer, type = 'image/jpeg', who: Who = 'owner') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/images',
      payload: buf,
      headers: { 'content-type': type, cookie: cookies[who], origin: SITE },
    });
    return { status: res.statusCode, json: res.json() };
  }

  async function jobsFor(bookingId: string): Promise<string[]> {
    const { rows } = await pool.query("SELECT payload->>'channel' AS c, payload->>'template' AS t FROM jobs WHERE payload->>'bookingId' = $1", [bookingId]);
    return rows.map((r) => `${r.c}:${r.t}`);
  }

  beforeAll(async () => {
    testDb = await createTestDatabase('sjp_admin');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testDb.url,
      PUBLIC_SITE_URL: SITE,
      PUBLIC_API_URL: 'http://localhost:8080',
      ALLOWED_ORIGINS: SITE,
      OWNER_EMAIL: 'owner@example.com',
      OWNER_PHONE: '089 470 9672',
      LOG_LEVEL: 'silent',
    });
    pool = createPool(config);
    await migrate(pool, () => undefined);
    deps = { config, db: pool, settings: new SettingsCache(pool, config), wakeWorker: () => undefined };
    app = await buildApp(deps, { logger: false, rateLimit: false });
    worker = new JobWorker(deps, { info() {}, warn() {}, error() {} });

    const hash = await hashPassword('correct-horse-battery');
    const { rows } = await pool.query<{ id: string; username: string }>(
      `INSERT INTO users (username, email, full_name, phone, password_hash, role) VALUES
         ('owner', 'owner@example.com', 'Owner One', '+353894709672', $1, 'admin'),
         ('staffer', 'staff@example.com', 'Staff Two', '+353872223333', $1, 'staff'),
         ('cust', 'cust@example.com', 'Customer Three', '+353857654321', $1, 'customer')
       RETURNING id, username`,
      [hash],
    );
    customerId = rows.find((r) => r.username === 'cust')!.id;
    for (const [who, username] of [['owner', 'owner'], ['staff', 'staffer'], ['customer', 'cust']] as const) {
      const res = await call('POST', '/auth/login', { login: username, password: 'correct-horse-battery' });
      expect(res.status).toBe(200);
      cookies[who] = sessionCookie(res);
    }

    today = todayInZone(config.TIMEZONE);
    const res = await call('GET', `/availability?from=${addDays(today, 3)}&to=${addDays(today, 60)}`);
    slots = res.json.days
      .filter((d: any) => d.open && d.available === 3)
      .flatMap((d: any) => ['morning', 'afternoon', 'evening'].map((period) => ({ date: d.date, period })));
    expect(slots.length).toBeGreaterThan(60);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await testDb?.drop().catch(() => undefined);
  });

  it('lets staff manage bookings only, and keeps customers out', async () => {
    expect((await call('GET', '/admin/pricing', undefined, null)).status).toBe(401);
    expect((await call('GET', '/admin/pricing', undefined, 'customer')).status).toBe(403);
    const staffPricing = await call('GET', '/admin/pricing', undefined, 'staff');
    expect(staffPricing.status).toBe(403);
    expect(staffPricing.json.error.message).toMatch(/bookings only/);
    expect((await call('GET', `/admin/bookings?from=${today}&to=${addDays(today, 7)}`, undefined, 'staff')).status).toBe(200);
    expect((await call('GET', '/admin/badges', undefined, 'staff')).json).toEqual({ pendingBookings: 0, failedNotifications: 0 });
    expect((await call('GET', '/admin/badges', undefined, 'customer')).status).toBe(403);
    for (const url of ['/admin/pricing', '/admin/sales', '/admin/discounts', '/admin/customers', '/admin/settings', '/admin/overview', '/admin/slides', '/admin/photos', '/admin/before-after', '/admin/team', '/admin/integrations']) {
      expect((await call('GET', url, undefined, 'owner')).status, url).toBe(200);
    }
  });

  it('saves settings that take effect straight away', async () => {
    const got = await call('GET', '/admin/settings', undefined, 'owner');
    expect(got.json.saved).toEqual([]);
    settings = got.json.settings;
    expect(settings.business.name).toBe('St Johns Park Car Valeting Service');
    expect(settings.booking).toMatchObject({ maxWeeksAhead: 12, minNoticeHours: 2, cancelCutoffHours: 24, paused: false, autoConfirm: false });
    expect(settings.alerts).toMatchObject({ ownerEmail: 'owner@example.com', newBooking: { email: true, sms: true } });

    const bad = await call('PUT', '/admin/settings', { ...settings, messages: { reminder: true, reviewRequest: true, googleReviewUrl: null } }, 'owner');
    expect(bad.status).toBe(400);
    expect(bad.json.error.fields['messages.googleReviewUrl']).toMatch(/review link/);

    settings = {
      ...settings,
      business: {
        ...settings.business,
        name: 'St Johns Park Valeting',
        publicEmail: 'Hello@StJohnsPark.ie',
        openingHours: [
          { label: 'Monday – Saturday', hours: '9:00 – 18:00' },
          { label: 'Sunday', hours: 'Closed' },
        ],
      },
      booking: { ...settings.booking, cancelCutoffHours: 48 },
      alerts: { ...settings.alerts, newBooking: { email: true, sms: false } },
    };
    const saved = await call('PUT', '/admin/settings', settings, 'owner');
    expect(saved.status).toBe(200);
    expect([...saved.json.saved].sort()).toEqual(['alerts', 'booking', 'business', 'messages']);
    expect(deps.config.CANCEL_CUTOFF_HOURS).toBe(48);
    expect(deps.config.BUSINESS_NAME).toBe('St Johns Park Valeting');

    const cfg = (await call('GET', '/config')).json;
    expect(cfg.business).toMatchObject({ name: 'St Johns Park Valeting', email: 'hello@stjohnspark.ie' });
    expect(cfg.business.openingHours).toHaveLength(2);
    expect(cfg.booking.cancelCutoffHours).toBe(48);
  });

  it('pauses online booking for customers but not for the owner', async () => {
    await call('PUT', '/admin/settings', { ...settings, booking: { ...settings.booking, paused: true, pausedMessage: 'Back on Monday!' } }, 'owner');
    expect((await call('GET', '/config')).json.booking).toMatchObject({ paused: true, pausedMessage: 'Back on Monday!' });
    const slot = nextSlot();
    const blocked = await call('POST', '/bookings', guestBooking(slot));
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatchObject({ code: 'BOOKING_PAUSED', message: 'Back on Monday!' });

    const byOwner = await call('POST', '/admin/bookings', guestBooking(slot, { name: 'Phoned In' }), 'staff');
    expect(byOwner.status).toBe(201);
    expect(byOwner.json.booking.status).toBe('confirmed');
    const sent = await jobsFor(byOwner.json.booking.id);
    expect(sent).toEqual(expect.arrayContaining(['customer_email:confirmed', 'customer_sms:confirmed']));
    expect(sent.some((s) => s.startsWith('owner_'))).toBe(false);

    await call('PUT', '/admin/settings', settings, 'owner');
    expect((await call('GET', '/config')).json.booking.paused).toBe(false);
  });

  it('lets the owner book at short notice, record the price charged, and ask for a review', async () => {
    // Customers need 3 days' notice for this test; the owner doesn't.
    await call('PUT', '/admin/settings', { ...settings, booking: { ...settings.booking, minNoticeHours: 72 } }, 'owner');
    const avail = await call('GET', `/availability?from=${addDays(today, 1)}&to=${addDays(today, 2)}`);
    const soon = avail.json.days
      .flatMap((d: any) => d.slots.filter((s: any) => s.reason === 'too_soon').map((s: any) => ({ date: d.date, period: s.period })))
      .at(-1);
    expect(soon).toBeTruthy();
    expect((await call('POST', '/bookings', guestBooking(soon))).json.error.code).toBe('SLOT_UNAVAILABLE');

    const res = await call(
      'POST',
      '/admin/bookings',
      { ...guestBooking(soon, { name: 'Customer Three', phone: '085 765 4321', email: null }), confirm: true, customerUserId: customerId },
      'owner',
    );
    expect(res.status).toBe(201);
    const b = res.json.booking;
    expect(b).toMatchObject({ status: 'confirmed', userId: customerId, email: 'cust@example.com' });
    expect(b.price).toMatchObject({ serviceEur: 130, totalEur: 130, from: true, discount: null, finalEur: null });
    await call('PUT', '/admin/settings', settings, 'owner');

    settings = { ...settings, messages: { reminder: true, reviewRequest: true, googleReviewUrl: 'https://g.page/r/test-review' } };
    expect((await call('PUT', '/admin/settings', settings, 'owner')).status).toBe(200);
    const done = await call('PATCH', `/admin/bookings/${b.reference}`, { status: 'completed', finalPriceEur: 145 }, 'staff');
    expect(done.status).toBe(200);
    expect(done.json.booking.price.finalEur).toBe(145);
    const review = await pool.query("SELECT run_at FROM jobs WHERE payload->>'bookingId' = $1 AND payload->>'template' = 'review_request'", [b.id]);
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0].run_at.getTime()).toBeGreaterThan(Date.now());
    const history = (await call('GET', `/admin/bookings/${b.reference}`, undefined, 'owner')).json.events.map((e: any) => e.type);
    expect(history).toEqual(expect.arrayContaining(['created', 'confirmed', 'completed', 'price_set']));
  });

  it('confirms bookings automatically when switched on, and follows the alert switches', async () => {
    await call('PUT', '/admin/settings', { ...settings, booking: { ...settings.booking, autoConfirm: true } }, 'owner');
    const res = await call('POST', '/bookings', guestBooking(nextSlot(), { phone: '083 555 0103', email: 'auto@example.com' }));
    expect(res.status).toBe(201);
    expect(res.json.booking.status).toBe('confirmed');
    const detail = (await call('GET', `/admin/bookings/${res.json.booking.reference}`, undefined, 'owner')).json;
    const sent = await jobsFor(detail.booking.id);
    expect(sent).toContain('customer_email:confirmed');
    expect(sent).not.toContain('customer_email:created');
    expect(sent).toContain('owner_email:created');
    expect(sent).not.toContain('owner_sms:created'); // switched off in settings
    expect(detail.events.map((e: any) => e.type)).toEqual(['created', 'confirmed']);
    await call('PUT', '/admin/settings', settings, 'owner');
  });

  let addonId = '';

  it('saves services, size prices, extras and the deposit in one go', async () => {
    const pricing = (await call('GET', '/admin/pricing', undefined, 'owner')).json;
    expect(pricing.services.map((s: any) => s.code)).toEqual(['mini', 'standard', 'full', 'polish', 'wheel']);
    expect(pricing.services.find((s: any) => s.code === 'full')).toMatchObject({ prices: { small: 130, large: null, suv: null }, active: true });
    expect(pricing.depositEur).toBe(30);

    const tiers: Record<string, number[]> = { mini: [50, 60, 70], standard: [90, 105, 120], full: [130, 150, 170], polish: [150, 175, 200] };
    const asSent = (s: any, withSizes: boolean) => ({
      code: s.code,
      name: s.name,
      description: s.description,
      durationLabel: s.durationLabel,
      priceFrom: s.priceFrom,
      active: s.active,
      featured: s.code === 'full',
      prices: tiers[s.code] ? { small: tiers[s.code][0], large: withSizes ? tiers[s.code][1] : null, suv: withSizes ? tiers[s.code][2] : null } : s.prices,
    });
    const missing = await call('PUT', '/admin/pricing', { bySize: true, depositEur: 25, services: pricing.services.map((s: any) => asSent(s, false)), addons: [] }, 'owner');
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.json.error.fields)).toContain('services.0.prices.large');

    const body = {
      bySize: true,
      depositEur: 25,
      services: [
        ...pricing.services.map((s: any) => asSent(s, true)),
        { code: null, name: 'Ceramic Coating', description: 'Long-lasting gloss', durationLabel: 'Full day', priceFrom: true, active: true, featured: false, prices: { small: 400, large: 450, suv: 500 } },
      ],
      addons: [
        { id: null, name: 'Pet hair removal', priceEur: 15, active: true },
        { id: null, name: 'Seat shampoo', priceEur: 25, active: false },
      ],
    };
    const saved = await call('PUT', '/admin/pricing', body, 'owner');
    expect(saved.status).toBe(200);
    expect(saved.json.services.at(-1)).toMatchObject({ code: 'ceramic-coating', prices: { small: 400, large: 450, suv: 500 } });
    expect(saved.json.addons.map((a: any) => a.name)).toEqual(['Pet hair removal', 'Seat shampoo']);
    expect(saved.json.depositEur).toBe(25);
    expect(deps.config.DEPOSIT_AMOUNT_EUR).toBe(25);
    addonId = saved.json.addons[0].id;

    const withoutWheel = { ...body, services: body.services.filter((s: any) => s.code !== 'wheel' && s.code !== null) };
    expect((await call('PUT', '/admin/pricing', withoutWheel, 'owner')).status).toBe(409);

    const cfg = (await call('GET', '/config')).json;
    expect(cfg.booking.pricesBySize).toBe(true);
    expect(cfg.booking.vehicleSizes.map((v: any) => v.code)).toEqual(['small', 'large', 'suv']);
    expect(cfg.services.find((s: any) => s.code === 'ceramic-coating').prices.suv).toEqual({ priceEur: 500, salePriceEur: null });
    expect(cfg.services.find((s: any) => s.code === 'full').featured).toBe(true);
    expect(cfg.addons).toEqual([{ id: addonId, name: 'Pet hair removal', priceEur: 15 }]);

    // No size chosen (e.g. an older booking page): quoted the base price rather than refused.
    const noSize = await call('POST', '/bookings', guestBooking(nextSlot(), { phone: '083 555 0103' }));
    expect(noSize.status).toBe(201);
    expect(noSize.json.booking.vehicleSize).toBeNull();
    expect(noSize.json.booking.price).toMatchObject({ serviceEur: 130, totalEur: 130 });
    const inactiveExtra = saved.json.addons[1].id;
    expect((await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'suv', addons: [inactiveExtra] }))).json.error.fields.addons).toBeTruthy();
    const booked = await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'suv', addons: [addonId], phone: '085 555 0104' }));
    expect(booked.status).toBe(201);
    expect(booked.json.booking.vehicleSize).toEqual({ code: 'suv', label: 'SUV / van' });
    expect(booked.json.booking.price).toMatchObject({ serviceEur: 170, addons: [{ name: 'Pet hair removal', priceEur: 15 }], totalEur: 185 });
  });

  it('runs sale prices, shown on the website and charged at booking', async () => {
    const ends = addDays(today, 30);
    expect((await call('PUT', '/admin/sales', { sales: [{ code: 'full', enabled: true, priceEur: 130, startsOn: today, endsOn: ends }] }, 'owner')).status).toBe(400);
    const live = await call('PUT', '/admin/sales', { sales: [{ code: 'full', enabled: true, priceEur: 104, startsOn: today, endsOn: ends }] }, 'owner');
    expect(live.json.services.find((s: any) => s.code === 'full')).toMatchObject({ status: 'live', percentOff: 20 });

    const full = (await call('GET', '/config')).json.services.find((s: any) => s.code === 'full');
    expect(full).toMatchObject({ priceEur: 130, salePriceEur: 104, saleEndsOn: ends });
    expect(full.prices.large).toEqual({ priceEur: 150, salePriceEur: 120 });
    const booked = await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'large', phone: '087 555 0102' }));
    expect(booked.json.booking.price).toMatchObject({ serviceEur: 120, totalEur: 120 });

    const later = await call('PUT', '/admin/sales', { sales: [{ code: 'full', enabled: true, priceEur: 104, startsOn: addDays(today, 5), endsOn: null }] }, 'owner');
    expect(later.json.services.find((s: any) => s.code === 'full').status).toBe('scheduled');
    const off = await call('PUT', '/admin/sales', { sales: [{ code: 'full', enabled: false, priceEur: null, startsOn: null, endsOn: null }] }, 'owner');
    expect(off.json.services.find((s: any) => s.code === 'full').status).toBe('none');
  });

  it('checks, redeems and gives back discount codes, never past the limit', async () => {
    const body = { code: 'spring15', kind: 'percent', value: 15, serviceCodes: ['full', 'standard'], startsOn: today, endsOn: null, maxUses: 2, firstBookingOnly: false, onePerCustomer: true };
    const created = await call('POST', '/admin/discounts', body, 'owner');
    expect(created.status).toBe(201);
    expect(created.json.discount).toMatchObject({ code: 'SPRING15', status: 'active', label: '15% off', uses: 0 });
    expect((await call('POST', '/admin/discounts', body, 'owner')).status).toBe(409);
    const invalid = await call('POST', '/admin/discounts', { ...body, code: 'X', value: 95 }, 'owner');
    expect(Object.keys(invalid.json.error.fields).sort()).toEqual(['code', 'value']);

    const check = await call('POST', '/discounts/check', { code: 'spring15', serviceCode: 'full', vehicleSize: 'small' });
    expect(check.json).toMatchObject({ valid: true, code: 'SPRING15', priceEur: 130, discountEur: 19.5, totalEur: 110.5 });
    expect((await call('POST', '/discounts/check', { code: 'SPRING15', serviceCode: 'mini', vehicleSize: 'small' })).json).toMatchObject({
      valid: false,
      message: "That code doesn't apply to Mini Valet.",
    });
    expect((await call('POST', '/discounts/check', { code: 'NOPE', serviceCode: 'full' })).json.valid).toBe(false);

    const first = await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'small', discountCode: 'spring15', phone: '086 123 4567' }));
    expect(first.status).toBe(201);
    expect(first.json.booking.price).toMatchObject({ serviceEur: 130, discount: { code: 'SPRING15', amountEur: 19.5 }, totalEur: 110.5 });
    const again = await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'small', discountCode: 'SPRING15', phone: '086 123 4567' }));
    expect(again.status).toBe(400);
    expect(again.json.error.fields.discountCode).toMatch(/already used/);
    const second = await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'small', discountCode: 'SPRING15', phone: '083 111 2222' }));
    expect(second.status).toBe(201);
    const third = await call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'small', discountCode: 'SPRING15', phone: '087 123 4567' }));
    expect(third.json.error.fields.discountCode).toMatch(/fully used/);

    // Cancelling gives the use back.
    expect((await call('POST', '/bookings/track/cancel', { reference: second.json.booking.reference, phone: '083 111 2222' })).status).toBe(200);
    const list = (await call('GET', '/admin/discounts', undefined, 'owner')).json;
    expect(list.discounts[0]).toMatchObject({ code: 'SPRING15', uses: 1, status: 'active' });
    expect(list.stats).toMatchObject({ activeCodes: 1, totalCodes: 1, timesUsed: 1, discountGivenEur: 19.5 });

    const id = list.discounts[0].id;
    expect((await call('POST', `/admin/discounts/${id}/pause`, undefined, 'owner')).json.discount.status).toBe('paused');
    expect((await call('POST', '/discounts/check', { code: 'SPRING15', serviceCode: 'full', vehicleSize: 'small' })).json.message).toMatch(/isn't active/);
    expect((await call('POST', `/admin/discounts/${id}/resume`, undefined, 'owner')).json.discount.status).toBe('active');
    const edited = await call('PUT', `/admin/discounts/${id}`, { ...body, maxUses: 1 }, 'owner');
    expect(edited.json.discount.status).toBe('used_up');
  });

  it('never lets a single-use code be used twice, even at the same moment', async () => {
    const created = await call(
      'POST',
      '/admin/discounts',
      { code: 'ONEOFF', kind: 'fixed', value: 10, serviceCodes: ['full'], startsOn: today, endsOn: null, maxUses: 1, firstBookingOnly: false, onePerCustomer: false },
      'owner',
    );
    expect(created.json.discount.label).toBe('€10 off');
    const phones = ['086 555 0101', '087 555 0102', '083 555 0103', '085 555 0104', '087 222 3333'];
    const results = await Promise.all(phones.map((phone) => call('POST', '/bookings', guestBooking(nextSlot(), { vehicleSize: 'small', discountCode: 'ONEOFF', phone }))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400 && /fully used/.test(r.json.error.message))).toHaveLength(4);
    const winner = results.find((r) => r.status === 201)!;
    expect(winner.json.booking.price).toMatchObject({ discount: { code: 'ONEOFF', amountEur: 10 }, totalEur: 120 });
  });

  it('lists, searches and exports customers', async () => {
    const res = await call('GET', '/admin/customers?sort=name', undefined, 'owner');
    expect(res.status).toBe(200);
    expect(res.json.customers.map((c: any) => c.key)).toContain(`user:${customerId}`);
    expect(res.json.customers.find((c: any) => c.key === `user:${customerId}`)).toMatchObject({ type: 'account', bookings: 1, spentEur: 145 });
    expect(res.json.customers.find((c: any) => c.key === 'guest:+353861234567')).toMatchObject({ type: 'guest', bookings: 1, name: 'Guest Person' });
    expect(res.json.stats.total).toBe(res.json.total);
    expect(res.json.customers.some((c: any) => ['owner@example.com', 'staff@example.com'].includes(c.email))).toBe(false);

    const search = await call('GET', '/admin/customers?q=086%20123%204567', undefined, 'owner');
    expect(search.json.customers.map((c: any) => c.key)).toEqual(['guest:+353861234567']);
    const accounts = await call('GET', '/admin/customers?type=account', undefined, 'owner');
    expect(accounts.json.customers.every((c: any) => c.type === 'account')).toBe(true);
    expect((await call('GET', '/admin/customers?sort=oldest', undefined, 'owner')).status).toBe(400);

    const csv = await call('GET', '/admin/customers.csv?type=account', undefined, 'owner');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.body).toContain('"Customer Three","Account","cust@example.com","085 765 4321"');
  });

  it('shows a customer with their bookings and private notes, and sends a reset link', async () => {
    const key = encodeURIComponent(`user:${customerId}`);
    const detail = await call('GET', `/admin/customers/${key}`, undefined, 'owner');
    expect(detail.json.customer).toMatchObject({ name: 'Customer Three', type: 'account' });
    expect(detail.json.bookings).toHaveLength(1);
    expect(detail.json.bookings[0].status).toBe('completed');
    expect((await call('PUT', `/admin/customers/${key}/note`, { note: 'Prefers mornings' }, 'owner')).json.note).toBe('Prefers mornings');
    expect((await call('GET', `/admin/customers/${key}`, undefined, 'owner')).json.note).toBe('Prefers mornings');
    expect((await call('PUT', `/admin/customers/${key}/note`, { note: '' }, 'owner')).json.note).toBe('');

    expect((await call('POST', `/admin/customers/${key}/password-reset`, undefined, 'owner')).status).toBe(202);
    const reset = await pool.query("SELECT 1 FROM jobs WHERE kind = 'auth.password_reset' AND payload->>'userId' = $1", [customerId]);
    expect(reset.rowCount).toBe(1);
    expect((await call('POST', `/admin/customers/${encodeURIComponent('guest:+353861234567')}/password-reset`, undefined, 'owner')).status).toBe(400);
    expect((await call('GET', `/admin/customers/${encodeURIComponent('guest:nonsense')}`, undefined, 'owner')).status).toBe(404);
  });

  it('deletes a customer’s personal data on request (GDPR), keeping the bookings', async () => {
    const guestKey = encodeURIComponent('guest:+353861234567');
    const blocked = await call('DELETE', `/admin/customers/${guestKey}`, undefined, 'owner');
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.message).toMatch(/upcoming booking/);

    const ref = (await call('GET', `/admin/customers/${guestKey}`, undefined, 'owner')).json.bookings[0].reference;
    expect((await call('PATCH', `/admin/bookings/${ref}`, { status: 'cancelled' }, 'owner')).status).toBe(200);
    const erased = await call('DELETE', `/admin/customers/${guestKey}`, undefined, 'owner');
    expect(erased.json).toEqual({ ok: true, erasedBookings: 1 });
    const after = (await call('GET', `/admin/bookings/${ref}`, undefined, 'owner')).json.booking;
    expect(after).toMatchObject({ customerName: 'Deleted customer', phone: '—', email: null, vehicle: 'Removed', notes: null });
    expect((await call('GET', '/admin/customers', undefined, 'owner')).json.customers.map((c: any) => c.key)).not.toContain('guest:+353861234567');

    // An account holder: the account goes, so do guest bookings they made earlier with the same phone, and their
    // session stops working.
    const earlier = await call('POST', '/bookings', guestBooking(nextSlot(), { name: 'Leaving Soon', phone: '087 555 0199', email: 'old-address@example.com' }));
    expect(earlier.status).toBe(201);
    expect((await call('POST', '/bookings/track/cancel', { reference: earlier.json.booking.reference, phone: '087 555 0199' })).status).toBe(200);
    const reg = await call('POST', '/auth/register', { username: 'leaving', email: 'leaving@example.com', password: 'leaving-password-1', fullName: 'Leaving Soon', phone: '087 555 0199' });
    expect(reg.status).toBe(201);
    const leaver = sessionCookie(reg);
    const gone = await call('DELETE', `/admin/customers/${encodeURIComponent(`user:${reg.json.user.id}`)}`, undefined, 'owner');
    expect(gone.json).toEqual({ ok: true, erasedBookings: 1 });
    expect((await call('GET', `/admin/bookings/${earlier.json.booking.reference}`, undefined, 'owner')).json.booking).toMatchObject({
      customerName: 'Deleted customer',
      email: null,
    });
    expect((await call('GET', '/auth/me', undefined, leaver)).json.user).toBeNull();
  });

  it('uploads photos, and publishes the slideshow only with descriptions', async () => {
    expect((await upload(await jpeg(), 'image/jpeg', 'staff')).status).toBe(403);
    expect((await upload(Buffer.from('not a photo'), 'image/png')).status).toBe(400);
    const up = await upload(await jpeg(3000, 2000));
    expect(up.status).toBe(201);
    expect(up.json.image.sizes.map((s: any) => s.width)).toEqual([640, 1280, 2400]);

    const added = (await call('POST', '/admin/slides', { imageId: up.json.image.id, caption: 'Snow foam' }, 'owner')).json;
    expect(added.slides).toHaveLength(1);
    expect(added.slides[0]).toMatchObject({ visible: false, caption: 'Snow foam' });
    const slideId = added.slides[0].id;
    const noAlt = await call('PUT', '/admin/slides', { seconds: 7, slides: [{ id: slideId, caption: 'Snow foam', alt: null, visible: true }] }, 'owner');
    expect(noAlt.status).toBe(400);
    expect(noAlt.json.error.fields['slides.0.alt']).toBeTruthy();
    const published = await call('PUT', '/admin/slides', { seconds: 7, slides: [{ id: slideId, caption: 'Snow foam', alt: 'Black saloon in snow foam', visible: true }] }, 'owner');
    expect(published.json.seconds).toBe(7);

    const gallery = (await call('GET', '/gallery')).json;
    expect(gallery.slideshow.seconds).toBe(7);
    expect(gallery.slideshow.slides[0]).toMatchObject({ caption: 'Snow foam', alt: 'Black saloon in snow foam' });
    const path = new URL(gallery.slideshow.slides[0].image.src).pathname;
    expect(path).toMatch(/\/api\/v1\/images\/[0-9a-f-]{36}\/1280\.webp$/);
    const img = await app.inject({ method: 'GET', url: path });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['cache-control']).toMatch(/immutable/);
    expect((await sharp(img.rawPayload).metadata()).width).toBe(1280);
    expect((await app.inject({ method: 'GET', url: path, headers: { 'if-none-match': String(img.headers.etag) } })).statusCode).toBe(304);

    // Removing the slide removes its image.
    await call('DELETE', `/admin/slides/${slideId}`, undefined, 'owner');
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });

  it('manages gallery photos and one published before & after pair', async () => {
    const a = (await upload(await jpeg(1200, 800, '#111111'))).json.image;
    const b = (await upload(await jpeg(1200, 800, '#eeeeee'))).json.image;
    const added = await call('POST', '/admin/photos', { items: [{ imageId: a.id, caption: 'Wheels', category: 'wheels' }, { imageId: b.id, caption: null, category: 'interior' }] }, 'owner');
    expect(added.status).toBe(201);
    expect(added.json.counts).toMatchObject({ all: 2, wheels: 1, interior: 1, exterior: 0 });
    const wheel = added.json.photos.find((p: any) => p.caption === 'Wheels');
    const patched = await call('PATCH', `/admin/photos/${wheel.id}`, { featured: true, category: 'detail' }, 'owner');
    expect(patched.json.photo).toMatchObject({ featured: true, category: 'detail', caption: 'Wheels' });
    const other = added.json.photos.find((p: any) => p.id !== wheel.id);
    expect((await call('DELETE', `/admin/photos/${other.id}`, undefined, 'owner')).status).toBe(200);

    const images = [];
    for (const colour of ['#553311', '#aa8866', '#223344', '#8899aa']) images.push((await upload(await jpeg(1000, 700, colour))).json.image);
    await call('POST', '/admin/before-after', { title: 'Muddy SUV', beforeImageId: images[0].id, afterImageId: images[1].id }, 'owner');
    const pairs = (await call('POST', '/admin/before-after', { title: 'Dog hair', beforeImageId: images[2].id, afterImageId: images[3].id }, 'owner')).json.pairs;
    const muddy = pairs.find((p: any) => p.title === 'Muddy SUV');
    const dog = pairs.find((p: any) => p.title === 'Dog hair');
    await call('PATCH', `/admin/before-after/${muddy.id}`, { published: true }, 'owner');
    const after = (await call('PATCH', `/admin/before-after/${dog.id}`, { published: true }, 'owner')).json.pairs;
    expect(after.filter((p: any) => p.published).map((p: any) => p.title)).toEqual(['Dog hair']);
    expect((await call('POST', '/admin/before-after', { title: 'Same', beforeImageId: images[0].id, afterImageId: images[0].id }, 'owner')).status).toBe(400);

    const gallery = (await call('GET', '/gallery')).json;
    expect(gallery.beforeAfter.title).toBe('Dog hair');
    expect(gallery.photos).toHaveLength(1);
    expect(gallery.photos[0]).toMatchObject({ caption: 'Wheels', category: 'detail', featured: true });
  });

  it('summarises the business on the overview', async () => {
    const o = (await call('GET', '/admin/overview?range=7', undefined, 'owner')).json;
    expect(o.tiles.bookings.value).toBeGreaterThan(0);
    expect(o.tiles.visitors).toBeNull();
    expect(o.bookingsSeries.granularity).toBe('day');
    expect(o.bookingsSeries.points).toHaveLength(7);
    expect(o.todaySlots).toHaveLength(3);
    expect(o.attention).toEqual({
      awaitingConfirmation: expect.any(Number),
      depositsUnpaid: expect.any(Number),
      failedMessages: 0,
      slotsLeftNextWeek: expect.any(Number),
    });
    expect(o.serviceMix.length).toBeGreaterThan(0);
    expect(o.activity.some((a: any) => a.type === 'code_used' && a.text.includes('SPRING15'))).toBe(true);
    expect(o.activity.some((a: any) => a.type === 'photos')).toBe(true);
    expect((await call('GET', '/admin/overview?range=90', undefined, 'owner')).json.bookingsSeries.granularity).toBe('week');
    expect((await call('GET', '/admin/overview?range=12', undefined, 'owner')).status).toBe(400);
  });

  it('reports connected services and explains what is not set up', async () => {
    const s = (await call('GET', '/admin/integrations', undefined, 'owner')).json;
    expect(s).toMatchObject({
      email: { configured: false },
      sms: { configured: false },
      calendar: { configured: false },
      analytics: { configured: false },
      iphoneCalendar: { configured: false, feedUrl: null },
    });
    expect((await call('POST', '/admin/integrations/email/test', undefined, 'owner')).json.error.message).toMatch(/RESEND_API_KEY/);
    expect((await call('POST', '/admin/integrations/sms/test', undefined, 'owner')).json.error.message).toMatch(/SENDMODE_ACCESS_KEY/);
    expect((await call('POST', '/admin/integrations/calendar/sync', undefined, 'owner')).status).toBe(400);
    const health = (await call('GET', '/admin/notifications/health', undefined, 'staff')).json;
    expect(health.email).toMatchObject({ configured: false, failed7d: 0 });
    expect((await call('GET', '/admin/analytics/live', undefined, 'owner')).json).toEqual({ configured: false, activeNow: 0 });
  });

  it('invites team members with bookings-only or full access, and removes them', async () => {
    const invited = await call('POST', '/admin/team/invites', { email: 'New.Helper@Example.com', access: 'bookings' }, 'owner');
    expect(invited.status).toBe(201);
    expect(invited.json.status).toBe('invited');
    expect(invited.json.invites).toEqual([expect.objectContaining({ email: 'new.helper@example.com', access: 'bookings' })]);
    const inviteToken = async (email: string) =>
      (
        await pool.query(
          "SELECT j.payload->>'token' AS token FROM jobs j JOIN team_invites i ON i.id = (j.payload->>'inviteId')::UUID WHERE j.kind = 'team.invite' AND i.email = $1",
          [email],
        )
      ).rows[0].token as string;
    const token = await inviteToken('new.helper@example.com');

    const helper = { username: 'helper', email: 'new.helper@example.com', password: 'helper-password-1', fullName: 'New Helper', phone: '086 555 0101' };
    expect((await call('POST', '/auth/register', { ...helper, email: 'someone.else@example.com', inviteToken: token })).status).toBe(400);
    const reg = await call('POST', '/auth/register', { ...helper, inviteToken: token });
    expect(reg.status).toBe(201);
    expect(reg.json.user.role).toBe('staff');
    const helperCookie = sessionCookie(reg);
    expect((await call('GET', '/admin/badges', undefined, helperCookie)).status).toBe(200);
    expect((await call('GET', '/admin/pricing', undefined, helperCookie)).status).toBe(403);
    expect((await call('POST', '/auth/register', { ...helper, username: 'helper2', email: 'helper2@example.com', inviteToken: token })).status).toBe(400);

    // Someone who already has an account gets access only by opening the emailed link while signed in to it
    // (proving the inbox is theirs; emails aren't verified at registration).
    const promote = await call('POST', '/auth/register', { username: 'promote', email: 'promote@example.com', password: 'promote-password-1', fullName: 'Pro Mote', phone: '087 555 0102' });
    const promoteCookie = sessionCookie(promote);
    const invitedAccount = await call('POST', '/admin/team/invites', { email: 'promote@example.com', access: 'bookings' }, 'owner');
    expect(invitedAccount.json.status).toBe('invited');
    expect((await call('GET', '/admin/pricing', undefined, promoteCookie)).status).toBe(403); // also caches their session as "customer"
    const promoteToken = await inviteToken('promote@example.com');
    const wrongAccount = await call('POST', '/auth/invites/accept', { token: promoteToken }, 'customer');
    expect(wrongAccount.status).toBe(403);
    expect(wrongAccount.json.error.message).toMatch(/promote@example\.com/);
    // Meanwhile they were given full access another way. Accepting the older bookings-only invite must not
    // downgrade them, even though their cached session still says "customer".
    await pool.query("UPDATE users SET role = 'admin' WHERE email = 'promote@example.com'");
    const accepted = await call('POST', '/auth/invites/accept', { token: promoteToken }, promoteCookie);
    expect(accepted.json.user.role).toBe('admin');
    expect((await call('GET', '/admin/pricing', undefined, promoteCookie)).status).toBe(200);
    expect((await call('POST', '/auth/invites/accept', { token: promoteToken }, promoteCookie)).status).toBe(400);
    expect((await call('POST', '/admin/team/invites', { email: 'promote@example.com', access: 'full' }, 'owner')).status).toBe(409);

    const team = (await call('GET', '/admin/team', undefined, 'owner')).json;
    expect(team.members.map((m: any) => [m.username, m.access, m.isYou])).toEqual(
      expect.arrayContaining([
        ['owner', 'full', true],
        ['promote', 'full', false],
        ['staffer', 'bookings', false],
        ['helper', 'bookings', false],
      ]),
    );

    expect((await call('DELETE', `/admin/team/members/${reg.json.user.id}`, undefined, 'owner')).status).toBe(200);
    expect((await call('GET', '/admin/badges', undefined, helperCookie)).status).toBe(401);
    const ownerId = team.members.find((m: any) => m.isYou).id;
    expect((await call('DELETE', `/admin/team/members/${ownerId}`, undefined, 'owner')).status).toBe(403);
    // Malformed ids get "not found", never reach the database.
    for (const url of [`/admin/team/members/${'-'.repeat(36)}`, `/admin/team/invites/${'-'.repeat(36)}`, `/admin/blocks/${'-'.repeat(36)}`]) {
      expect((await call('DELETE', url, undefined, 'owner')).status, url).toBe(404);
    }
    expect((await call('GET', `/admin/customers/${encodeURIComponent(`user:${'-'.repeat(36)}`)}`, undefined, 'owner')).status).toBe(404);
    expect((await call('DELETE', `/admin/team/members/${promote.json.user.id}`, undefined, 'owner')).status).toBe(200);

    // Removing someone also cancels any open invite for their address, so it can't hand the access straight back
    // (e.g. they were given access with the create-admin script while an invite was still open).
    const late = await call('POST', '/auth/register', { username: 'late', email: 'late@example.com', password: 'late-password-1', fullName: 'Late Comer', phone: '083 555 0103' });
    const lateCookie = sessionCookie(late);
    await call('POST', '/admin/team/invites', { email: 'late@example.com', access: 'full' }, 'owner');
    const lateToken = await inviteToken('late@example.com');
    await pool.query("UPDATE users SET role = 'staff' WHERE id = $1", [late.json.user.id]);
    expect((await call('DELETE', `/admin/team/members/${late.json.user.id}`, undefined, 'owner')).status).toBe(200);
    const relogin = await call('POST', '/auth/login', { login: 'late', password: 'late-password-1' });
    expect((await call('POST', '/auth/invites/accept', { token: lateToken }, sessionCookie(relogin))).status).toBe(400);
    expect((await call('GET', '/admin/badges', undefined, lateCookie)).status).toBe(401);
  });

  it('signs an account out everywhere when create-admin promotes it or changes its password (finding 9)', async () => {
    const reg = await call('POST', '/auth/register', { username: 'promoted', email: 'promoted@example.com', password: 'promoted-password-1', fullName: 'Pro Moted', phone: '083 555 0104' });
    const oldCookie = sessionCookie(reg);
    expect((await call('GET', '/auth/me', undefined, oldCookie)).json.user.role).toBe('customer');

    expect(await grantAdmin(pool, reg.json.user.id, await hashPassword('brand-new-password-2'))).toEqual({ revokedSessions: 1 });
    // The old session is gone, so it never picks up admin access.
    expect((await call('GET', '/auth/me', undefined, oldCookie)).json.user).toBeNull();
    expect((await call('GET', '/admin/pricing', undefined, oldCookie)).status).toBe(401);
    expect((await call('POST', '/auth/login', { login: 'promoted', password: 'promoted-password-1' })).status).toBe(401);
    const fresh = await call('POST', '/auth/login', { login: 'promoted', password: 'brand-new-password-2' });
    expect(fresh.status).toBe(200);
    expect((await call('GET', '/admin/pricing', undefined, sessionCookie(fresh))).status).toBe(200);

    // Running it again for an admin without a new password changes nothing and keeps them signed in.
    expect(await grantAdmin(pool, reg.json.user.id, null)).toEqual({ revokedSessions: 0 });
    expect((await call('GET', '/admin/pricing', undefined, sessionCookie(fresh))).status).toBe(200);
  });

  it('stops a staff session at once when another process revokes it (finding 9)', async () => {
    const reg = await call('POST', '/auth/register', { username: 'otherstaff', email: 'otherstaff@example.com', password: 'otherstaff-password-1', fullName: 'Other Staff', phone: '083 555 0105' });
    await pool.query("UPDATE users SET role = 'staff' WHERE id = $1", [reg.json.user.id]);
    const cookie = sessionCookie(await call('POST', '/auth/login', { login: 'otherstaff', password: 'otherstaff-password-1' }));
    expect((await call('GET', '/admin/badges', undefined, cookie)).status).toBe(200);
    // Revoked outside this API process (the create-admin script, another instance): nothing clears this process's cache.
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [reg.json.user.id]);
    expect((await call('GET', '/admin/badges', undefined, cookie)).status).toBe(401);
  });

  it('lets an invite acceptance queue behind a removal instead of deadlocking with it (finding 11)', async () => {
    const reg = await call('POST', '/auth/register', { username: 'racer', email: 'racer@example.com', password: 'racer-password-1', fullName: 'Ray Sir', phone: '083 555 0106' });
    const racerId: string = reg.json.user.id;
    const racerCookie = sessionCookie(reg);
    await call('POST', '/admin/team/invites', { email: 'racer@example.com', access: 'bookings' }, 'owner');
    const token = (
      await pool.query(
        "SELECT j.payload->>'token' AS token FROM jobs j JOIN team_invites i ON i.id = (j.payload->>'inviteId')::UUID WHERE j.kind = 'team.invite' AND i.email = 'racer@example.com'",
      )
    ).rows[0].token as string;
    await pool.query("UPDATE users SET role = 'staff' WHERE id = $1", [racerId]); // given access another way; the invite is still open

    // A removal part-way through (removeMember's statements, paused): it holds the user rows...
    const removal = new pg.Client({ connectionString: testDb.url, application_name: 'removal-under-test' });
    await removal.connect();
    try {
      const removalPid: number = (await removal.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await removal.query('BEGIN');
      await removal.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE");
      await removal.query("SELECT role FROM users WHERE id = $1 AND role IN ('staff', 'admin') FOR UPDATE", [racerId]);

      // ...when they open the invite link. Acceptance must wait for the user row first, holding no invite lock.
      const accepting = call('POST', '/auth/invites/accept', { token }, racerCookie);
      const waiting = async () =>
        (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1", [removalPid]))
          .rows[0].n > 0;
      for (let i = 0; i < 100 && !(await waiting()); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await waiting()).toBe(true);
      const inviteLocks = await pool.query(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND relation = 'team_invites'::regclass AND pid <> $1 AND pid <> pg_backend_pid()`,
        [removalPid],
      );
      expect(inviteLocks.rows[0].n).toBe(0);

      // The removal finishes, cancelling the open invite (it would wait on acceptance here if acceptance held it).
      await removal.query("UPDATE users SET role = 'customer', updated_at = now() WHERE id = $1", [racerId]);
      await removal.query('DELETE FROM sessions WHERE user_id = $1', [racerId]);
      await removal.query('DELETE FROM team_invites WHERE accepted_at IS NULL AND email = (SELECT email FROM users WHERE id = $1)', [racerId]);
      await removal.query('COMMIT');

      // Acceptance then finds the invite gone: no deadlock, and no access handed back.
      const res = await accepting;
      expect(res.status).toBe(400);
      expect((await pool.query('SELECT role FROM users WHERE id = $1', [racerId])).rows[0].role).toBe('customer');
    } finally {
      await removal.query('ROLLBACK').catch(() => undefined);
      await removal.end();
    }
  });

  it('delivers every queued job (skipping providers that are not configured) without failures', async () => {
    await call('PUT', '/admin/settings', { ...settings, alerts: { ...settings.alerts, dailySummary: true } }, 'owner');
    await pool.query("INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('owner.daily_summary', $1::JSONB, 'daily-summary:test')", [JSON.stringify({ date: today })]);
    await pool.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
    await worker.drain();
    const notDone = await pool.query("SELECT kind, status, last_error FROM jobs WHERE status <> 'done'");
    expect(notDone.rows).toEqual([]);
    const summary = await pool.query("SELECT last_error FROM jobs WHERE kind = 'owner.daily_summary'");
    expect(summary.rows[0].last_error).toMatch(/RESEND_API_KEY/);
    const invites = await pool.query("SELECT payload FROM jobs WHERE kind = 'team.invite'");
    expect(invites.rows.every((r) => Object.keys(r.payload).length === 0)).toBe(true);
  });
});
