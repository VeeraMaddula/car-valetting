import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Queryable } from '../src/db/pool.js';
import { sessionUser } from '../src/domain/users.js';
import { isUuid } from '../src/lib/validate.js';
import { slugify } from '../src/domain/catalog.js';
import { csvCell, customersCsv, customerStats, filterCustomers, type Customer } from '../src/domain/customers.js';
import { processImage } from '../src/domain/media.js';
import { bucketSeries, weekStart } from '../src/domain/overview.js';
import {
  discountAmount,
  discountLabel,
  discountState,
  euros,
  normalizeCode,
  quoteService,
  type DiscountRule,
  type PricedService,
} from '../src/domain/pricing.js';
import { applySettings, baseValues, parseStored, resolveSettings } from '../src/domain/site-settings.js';
import { nextDailySummary } from '../src/jobs/worker.js';

const service = (over: Partial<PricedService> = {}): PricedService => ({
  priceCents: 9000,
  priceLargeCents: 10500,
  priceSuvCents: 12000,
  saleEnabled: false,
  salePriceCents: null,
  saleStartsOn: null,
  saleEndsOn: null,
  ...over,
});

describe('prices', () => {
  it('uses size prices only when pricing by size, falling back to the base price', () => {
    expect(quoteService(service(), 'suv', false, '2026-10-21').priceCents).toBe(9000);
    expect(quoteService(service(), 'suv', true, '2026-10-21').priceCents).toBe(12000);
    expect(quoteService(service({ priceLargeCents: null }), 'large', true, '2026-10-21').priceCents).toBe(9000);
    expect(quoteService(service({ priceCents: null }), null, false, '2026-10-21')).toEqual({ listCents: null, priceCents: null, onSale: false });
  });

  it('applies a sale only inside its dates, and the same percentage to larger sizes', () => {
    const sale = service({ saleEnabled: true, salePriceCents: 7200, saleStartsOn: '2026-10-20', saleEndsOn: '2026-10-31' });
    expect(quoteService(sale, null, false, '2026-10-19')).toMatchObject({ priceCents: 9000, onSale: false });
    expect(quoteService(sale, null, false, '2026-10-20')).toMatchObject({ listCents: 9000, priceCents: 7200, onSale: true });
    expect(quoteService(sale, 'suv', true, '2026-10-31')).toMatchObject({ listCents: 12000, priceCents: 9600, onSale: true }); // 20% off
    expect(quoteService(sale, null, false, '2026-11-01').onSale).toBe(false);
    // A "sale" at or above the normal price is ignored.
    expect(quoteService(service({ saleEnabled: true, salePriceCents: 9000 }), null, false, '2026-10-21').onSale).toBe(false);
  });

  it('formats euros and codes', () => {
    expect(euros(9000)).toBe('€90');
    expect(euros(7650)).toBe('€76.50');
    expect(normalizeCode(' spring 15 ')).toBe('SPRING15');
    expect(slugify('Pet Hair & Odour!')).toBe('pet-hair-odour');
    expect(slugify('Ceramic Coating Élite')).toBe('ceramic-coating-elite');
    expect(slugify('€')).toBe('service');
  });
});

describe('discount codes', () => {
  const rule = (over: Partial<DiscountRule> = {}): DiscountRule => ({
    kind: 'percent',
    value: 15,
    startsOn: '2026-10-01',
    endsOn: '2026-10-31',
    maxUses: 100,
    uses: 0,
    paused: false,
    ...over,
  });

  it('works out the status the dashboard shows', () => {
    expect(discountState(rule(), '2026-10-21')).toBe('active');
    expect(discountState(rule(), '2026-09-30')).toBe('scheduled');
    expect(discountState(rule(), '2026-11-01')).toBe('expired');
    expect(discountState(rule({ uses: 100 }), '2026-10-21')).toBe('used_up');
    expect(discountState(rule({ paused: true }), '2026-10-21')).toBe('paused');
    expect(discountState(rule({ endsOn: null, maxUses: null, uses: 5000 }), '2030-01-01')).toBe('active');
  });

  it('calculates the amount off, never more than the price', () => {
    expect(discountAmount({ kind: 'percent', value: 15 }, 9000)).toBe(1350);
    expect(discountAmount({ kind: 'fixed', value: 1000 }, 9000)).toBe(1000);
    expect(discountAmount({ kind: 'fixed', value: 10000 }, 5000)).toBe(5000);
    expect(discountLabel({ kind: 'percent', value: 15 })).toBe('15% off');
    expect(discountLabel({ kind: 'fixed', value: 1250 })).toBe('€12.50 off');
  });
});

describe('owner settings', () => {
  const config = () =>
    loadConfig({
      DATABASE_URL: 'postgresql://unused',
      PUBLIC_SITE_URL: 'https://www.example.ie',
      PUBLIC_API_URL: 'https://api.example.ie',
      BOOKING_MAX_DAYS_AHEAD: '100',
      OWNER_EMAIL: 'env@example.ie',
    });

  it('keeps the environment values until the owner saves a section', () => {
    const cfg = config();
    const base = baseValues(cfg);
    applySettings(cfg, base, {});
    expect(cfg.BOOKING_MAX_DAYS_AHEAD).toBe(100); // not rounded to whole weeks
    expect(cfg.OWNER_EMAIL).toBe('env@example.ie');
    expect(resolveSettings(base, {}).booking.maxWeeksAhead).toBe(14);
  });

  it('applies saved sections everywhere the config is used', () => {
    const cfg = config();
    const base = baseValues(cfg);
    const stored = parseStored({
      booking: { paused: false, pausedMessage: null, maxWeeksAhead: 4, minNoticeHours: 24, cancelCutoffHours: 48, autoConfirm: true },
      alerts: { ownerEmail: 'owner@example.ie', ownerPhone: null, newBooking: { email: true, sms: false }, customerCancels: { email: true, sms: true }, dailySummary: true },
      pricing: { bySize: true, depositEur: 0 },
    });
    applySettings(cfg, base, stored);
    expect(cfg.BOOKING_MAX_DAYS_AHEAD).toBe(28);
    expect(cfg.BOOKING_MIN_LEAD_MINUTES).toBe(24 * 60);
    expect(cfg.CANCEL_CUTOFF_HOURS).toBe(48);
    expect(cfg.OWNER_EMAIL).toBe('owner@example.ie');
    expect(cfg.OWNER_PHONE).toBeUndefined();
    expect(cfg.DEPOSIT_AMOUNT_EUR).toBe(0);
    expect(cfg.stripeEnabled).toBe(false);
  });

  it('keeps a longer .env cancellation cutoff until booking settings are saved', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgresql://unused', PUBLIC_SITE_URL: 'https://www.example.ie', PUBLIC_API_URL: 'https://api.example.ie', CANCEL_CUTOFF_HOURS: '240' });
    const base = baseValues(cfg);
    applySettings(cfg, base, {});
    expect(cfg.CANCEL_CUTOFF_HOURS).toBe(240);
    // The settings page shows (and would save back) the same 240 hours, not a shortened value.
    const shown = resolveSettings(base, {}).booking;
    expect(shown.cancelCutoffHours).toBe(240);
    applySettings(cfg, base, parseStored({ booking: { ...shown, cancelCutoffHours: 72 } }));
    expect(cfg.CANCEL_CUTOFF_HOURS).toBe(72);
  });

  it('ignores a damaged saved section instead of breaking the site', () => {
    const stored = parseStored({ booking: { maxWeeksAhead: 'lots' }, slideshow: { seconds: 7 }, unknown: { x: 1 } });
    expect(stored).toEqual({ slideshow: { seconds: 7 } });
  });
});

describe('customers', () => {
  const customer = (over: Partial<Customer>): Customer => ({
    key: 'guest:+353871234567',
    type: 'guest',
    userId: null,
    name: 'Aoife Byrne',
    email: 'aoife@example.ie',
    phone: '087 123 4567',
    phoneE164: '+353871234567',
    vehicle: 'VW Golf',
    bookings: 1,
    cancelled: 0,
    spentEur: 90,
    lastValet: '2026-10-01',
    lastBooking: '2026-10-01',
    firstSeen: '2026-10-01T10:00:00.000Z',
    ...over,
  });
  const list = [
    customer({}),
    customer({ key: 'user:1', type: 'account', name: 'Ciarán Walsh', phoneE164: '+353861112222', email: 'c@example.ie', bookings: 4, spentEur: 400, lastValet: '2026-10-15' }),
    customer({ key: 'guest:+353899999999', name: 'Seán Doyle', email: null, phoneE164: '+353899999999', bookings: 0, spentEur: 0, lastValet: null, lastBooking: null, firstSeen: '2025-01-01T00:00:00.000Z' }),
  ];

  it('searches by name, email or phone in either format, and filters and sorts', () => {
    const q = (query: string) => filterCustomers(list, { q: query, type: 'all', sort: 'name' }).map((c) => c.name);
    expect(q('aoife')).toEqual(['Aoife Byrne']);
    expect(q('087 123')).toEqual(['Aoife Byrne']);
    expect(q('+353 86 111')).toEqual(['Ciarán Walsh']);
    expect(filterCustomers(list, { type: 'returning', sort: 'recent' }).map((c) => c.name)).toEqual(['Ciarán Walsh']);
    expect(filterCustomers(list, { type: 'all', sort: 'spent' })[0].name).toBe('Ciarán Walsh');
    expect(filterCustomers(list, { type: 'all', sort: 'recent' }).map((c) => c.name)).toEqual(['Ciarán Walsh', 'Aoife Byrne', 'Seán Doyle']);
  });

  it('summarises customers for the tiles', () => {
    expect(customerStats(list, new Date('2026-10-21T12:00:00Z'))).toEqual({
      total: 3,
      accounts: 1,
      accountsPct: 33,
      guests: 2,
      returning: 1,
      returningPct: 33,
      new30d: 2,
    });
  });

  it('exports CSV that spreadsheets cannot run as formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('Ciarán, "the car man"')).toBe('"Ciarán, ""the car man"""');
    const csv = customersCsv([customer({ name: '@SUM(1+1)' })]);
    expect(csv.startsWith('﻿"Name","Type"')).toBe(true);
    expect(csv).toContain('"\'@SUM(1+1)","Guest","aoife@example.ie","087 123 4567","VW Golf","1","0","90.00","2026-10-01","2026-10-01"');
  });
});

describe('scheduling and charts', () => {
  it('queues the 8am summary for today before 8am (Dublin time) and tomorrow after', () => {
    // 21 Oct 2026 is summer time in Ireland (UTC+1): 8am Dublin is 07:00 UTC.
    expect(nextDailySummary('Europe/Dublin', new Date('2026-10-21T06:30:00Z'))).toEqual({ date: '2026-10-21', runAt: new Date('2026-10-21T07:00:00Z') });
    expect(nextDailySummary('Europe/Dublin', new Date('2026-10-21T07:00:00Z'))).toEqual({ date: '2026-10-22', runAt: new Date('2026-10-22T07:00:00Z') });
    // After the clocks go back (25 Oct), 8am Dublin is 08:00 UTC.
    expect(nextDailySummary('Europe/Dublin', new Date('2026-10-26T09:00:00Z')).runAt).toEqual(new Date('2026-10-27T08:00:00Z'));
  });

  it('fills chart gaps and groups 90-day charts by week (Monday start)', () => {
    expect(weekStart('2026-10-21')).toBe('2026-10-19');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(weekStart('2026-10-25')).toBe('2026-10-19');
    const counts = new Map([['2026-10-20', 2], ['2026-10-26', 1]]);
    expect(bucketSeries('2026-10-19', '2026-10-21', counts, 'day')).toEqual([
      { date: '2026-10-19', count: 0 },
      { date: '2026-10-20', count: 2 },
      { date: '2026-10-21', count: 0 },
    ]);
    expect(bucketSeries('2026-10-19', '2026-10-27', counts, 'week')).toEqual([
      { date: '2026-10-19', count: 2 },
      { date: '2026-10-26', count: 1 },
    ]);
  });
});

describe('sessions and ids', () => {
  afterEach(() => vi.useRealTimers());

  const fakeDb = (answers: unknown[][]) => {
    let calls = 0;
    const db = { query: async () => ({ rows: answers[Math.min(calls++, answers.length - 1)] }) } as unknown as Queryable;
    return { db, calls: () => calls };
  };
  const sessionRow = (expiresAt: string) => ({
    id: '9f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b',
    username: 'cust',
    email: 'cust@example.com',
    full_name: 'Customer',
    phone: '+353871234567',
    role: 'customer',
    expires_at: new Date(expiresAt),
  });

  it('never serves a session from the cache after the session itself has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const { db, calls } = fakeDb([[sessionRow('2026-10-21T12:00:01Z')], []]);
    const token = 'a'.repeat(43);
    expect(await sessionUser(db, token)).toMatchObject({ username: 'cust' });
    vi.setSystemTime(new Date('2026-10-21T12:00:02Z'));
    expect(await sessionUser(db, token)).toBeNull();
    expect(calls()).toBe(2);
  });

  it('rejects a session that expires while the database query is in flight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const db = {
      query: async () => {
        vi.setSystemTime(new Date('2026-10-21T12:00:02Z')); // the reply arrives after the session's expiry
        return { rows: [sessionRow('2026-10-21T12:00:01Z')] };
      },
    } as unknown as Queryable;
    expect(await sessionUser(db, 'c'.repeat(43))).toBeNull();
  });

  it('still caches ordinary sessions for a few seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const { db, calls } = fakeDb([[sessionRow('2026-11-20T12:00:00Z')]]);
    const token = 'b'.repeat(43);
    await sessionUser(db, token);
    vi.setSystemTime(new Date('2026-10-21T12:00:10Z'));
    expect(await sessionUser(db, token)).toMatchObject({ username: 'cust' });
    expect(calls()).toBe(1);
  });

  it('accepts only well-formed UUIDs', () => {
    expect(isUuid('9f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b')).toBe(true);
    expect(isUuid('9F1C2A3B-4D5E-4F60-8A7B-1C2D3E4F5A6B')).toBe(true);
    expect(isUuid('-'.repeat(36))).toBe(false);
    expect(isUuid('9f1c2a3b4d5e4f608a7b1c2d3e4f5a6b----')).toBe(false);
    expect(isUuid('9f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6g')).toBe(false);
  });
});

describe('photo processing', () => {
  const photo = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#335577' } });

  it('makes WebP sizes up to 2400px and strips EXIF/GPS data', async () => {
    const input = await photo(3000, 2000)
      .jpeg()
      .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 15' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 15/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '7/1 6/1 0/1' } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processImage(input);
    expect(out.variants.map((v) => [v.width, v.height])).toEqual([
      [640, 427],
      [1280, 853],
      [2400, 1600],
    ]);
    for (const v of out.variants) {
      const meta = await sharp(v.data).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
    }
  });

  it('never enlarges, and turns phone photos the right way up', async () => {
    const small = await processImage(await photo(900, 600).png().toBuffer());
    expect(small.variants.map((v) => v.width)).toEqual([640, 900]);
    // Stored 1200×800 but tagged "rotate 90°": shown as 800×1200.
    const portrait = await processImage(await photo(1200, 800).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    expect(portrait).toMatchObject({ width: 800, height: 1200 });
  });

  it('rejects files that are not photos, or too small', async () => {
    await expect(processImage(Buffer.from('not an image'))).rejects.toThrow(/JPG, PNG or WebP/);
    await expect(processImage(await photo(200, 200).png().toBuffer())).rejects.toThrow(/too small/);
    await expect(processImage(await photo(800, 600).gif().toBuffer())).rejects.toThrow(/JPG, PNG or WebP/);
  });
});
