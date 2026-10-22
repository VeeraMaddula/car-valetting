import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { splitStatements } from '../src/db/migrate.js';
import { computeAvailability, slotRule, type Rules } from '../src/domain/availability.js';
import type { BookingRecord } from '../src/domain/bookings.js';
import type { PeriodDef } from '../src/domain/settings.js';
import { backoffMs } from '../src/jobs/worker.js';
import { buildIcs } from '../src/lib/ics.js';
import { displayPhone, maskPhone, normalizePhone } from '../src/lib/phone.js';
import { formatReference, newReference, normalizeReference } from '../src/lib/reference.js';
import { addDays, dayOfWeek, diffDays, longDate, minutesNowInZone, todayInZone, zonedTimeToUtc } from '../src/lib/time.js';
import { customerEmail, customerSms, ownerSms } from '../src/notifications/templates.js';

const TZ = 'Europe/Dublin';

describe('booking references', () => {
  it('are 8 Crockford base32 characters and practically unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const ref = newReference();
      expect(ref).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      seen.add(ref);
    }
    expect(seen.size).toBe(20_000);
  });

  it('accept whatever a customer types', () => {
    expect(formatReference('K7Q49XZ2')).toBe('SJP-K7Q4-9XZ2');
    expect(normalizeReference('SJP-K7Q4-9XZ2')).toBe('K7Q49XZ2');
    expect(normalizeReference(' sjp k7q4 9xz2 ')).toBe('K7Q49XZ2');
    expect(normalizeReference('k7q49xz2')).toBe('K7Q49XZ2');
    expect(normalizeReference('SJP-K7Q4-9XZO')).toBe('K7Q49XZ0'); // O read as zero
    expect(normalizeReference('SJP-K7Q4-9XZI')).toBe('K7Q49XZ1'); // I read as one
    expect(normalizeReference('SJP-123')).toBeNull();
    expect(normalizeReference('')).toBeNull();
    expect(normalizeReference("'; DROP TABLE bookings;--")).toBeNull();
  });
});

describe('time zone helpers (Europe/Dublin)', () => {
  it('knows the local date across midnight in summer and winter', () => {
    expect(todayInZone(TZ, new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02'); // IST, UTC+1
    expect(todayInZone(TZ, new Date('2026-12-01T23:30:00Z'))).toBe('2026-12-01'); // GMT
    expect(minutesNowInZone(TZ, new Date('2026-07-01T08:15:00Z'))).toBe(9 * 60 + 15);
  });

  it('converts local slot times to UTC, including DST changeover days', () => {
    expect(zonedTimeToUtc('2026-07-01', '09:00', TZ).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', '09:00', TZ).toISOString()).toBe('2026-12-01T09:00:00.000Z');
    expect(zonedTimeToUtc('2026-03-29', '12:00', TZ).toISOString()).toBe('2026-03-29T11:00:00.000Z'); // clocks went forward
    expect(zonedTimeToUtc('2026-10-25', '12:00', TZ).toISOString()).toBe('2026-10-25T12:00:00.000Z'); // clocks went back
  });

  it('does calendar arithmetic on plain dates', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-02', '2026-10-05')).toBe(3);
    expect(diffDays('2026-10-25', '2026-10-26')).toBe(1);
    expect(dayOfWeek('2026-10-04')).toBe(0); // Sunday
    expect(longDate('2026-10-03')).toBe('Saturday 3 October 2026');
  });
});

describe('phone numbers', () => {
  it('normalizes Irish numbers typed locally', () => {
    expect(normalizePhone('089 470 9672')).toEqual({ e164: '+353894709672', isMobile: true });
    expect(normalizePhone('+353 89 470 9672')?.e164).toBe('+353894709672');
    expect(normalizePhone('00353894709672')?.e164).toBe('+353894709672');
  });

  it('recognises landlines (no SMS) and rejects junk', () => {
    expect(normalizePhone('051 123 456')?.isMobile).toBe(false);
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });

  it('formats for display and masking', () => {
    expect(displayPhone('+353894709672')).toBe('089 470 9672');
    expect(maskPhone('+353894709672')).toBe('••• ••• •672');
  });
});

const periods: PeriodDef[] = [
  { code: 'morning', label: 'Morning', startTime: null, endTime: null, daysOfWeek: [1, 2, 3, 4, 5, 6], sort: 1, active: true },
  { code: 'afternoon', label: 'Afternoon', startTime: null, endTime: null, daysOfWeek: [1, 2, 3, 4, 5, 6], sort: 2, active: true },
  { code: 'evening', label: 'Evening', startTime: '17:00:00', endTime: '19:00:00', daysOfWeek: [1, 2, 3, 4, 5], sort: 3, active: true },
];

// Monday 5 October 2026, 10:00 local.
const rules: Rules = { today: '2026-10-05', nowMinutes: 600, maxDaysAhead: 84, minLeadMinutes: 120, periods };

describe('availability rules', () => {
  it('blocks past dates, Sundays, slots too soon and dates beyond the window', () => {
    expect(slotRule('2026-10-04', periods[0], rules)).toBe('past');
    expect(slotRule('2026-10-11', periods[0], rules)).toBe('closed'); // Sunday
    expect(slotRule('2026-10-10', periods[2], rules)).toBe('closed'); // no evening slot on Saturdays
    expect(slotRule('2026-10-05', periods[0], rules)).toBe('too_soon'); // morning (09:00) already started
    expect(slotRule('2026-10-05', periods[2], rules)).toBeNull(); // 17:00 is 7h away
    expect(slotRule('2026-10-06', periods[0], rules)).toBeNull(); // tomorrow
    expect(slotRule(addDays('2026-10-05', 85), periods[1], rules)).toBe('beyond_window');
  });

  it('marks booked and blocked slots and summarises each day', () => {
    const taken = new Set(['2026-10-06|morning']);
    const blocked = new Map([
      ['2026-10-07', new Set(['all'])],
      ['2026-10-08', new Set(['afternoon'])],
    ]);
    const days = computeAvailability('2026-10-04', '2026-10-11', rules, taken, blocked);
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    expect(days).toHaveLength(8);
    expect(byDate['2026-10-04'].reason).toBe('past');
    expect(byDate['2026-10-05'].isToday).toBe(true);
    expect(byDate['2026-10-05'].available).toBe(2); // afternoon + evening still bookable today
    expect(byDate['2026-10-06'].slots.map((s) => s.status)).toEqual(['booked', 'available', 'available']);
    expect(byDate['2026-10-07']).toMatchObject({ open: false, reason: 'blocked', available: 0 });
    expect(byDate['2026-10-08'].slots[1]).toMatchObject({ status: 'unavailable', reason: 'blocked' });
    expect(byDate['2026-10-10'].available).toBe(2); // Saturday: no evening
    expect(byDate['2026-10-11']).toMatchObject({ open: false, reason: 'closed' });
    expect(byDate['2026-10-06'].slots[2]).toMatchObject({ startTime: '17:00', endTime: '19:00' });
  });
});

describe('calendar files', () => {
  it('produce valid, folded, escaped iCalendar text', () => {
    const ics = buildIcs(
      {
        name: 'Test',
        events: [
          {
            uid: 'abc@test',
            sequence: 2,
            summary: 'Full Valet, St Johns Park; Waterford',
            description: `Line one\nLine two ${'x'.repeat(120)} € end`,
            location: '19 Saint Lawrence Terrace, Waterford',
            timing: { kind: 'allDay', date: '2026-12-31' },
            updatedAt: new Date('2026-10-01T10:00:00Z'),
          },
        ],
      },
      new Date('2026-10-01T10:00:00Z'),
    );
    const lines = ics.split('\r\n');
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(lines.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics).toContain('SUMMARY:Full Valet\\, St Johns Park\\; Waterford');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('BEGIN:VALARM');
    // Unfolding restores the original text, including the multi-byte euro sign.
    expect(ics.replace(/\r\n /g, '')).toContain(`Line one\\nLine two ${'x'.repeat(120)} € end`);
  });

  it('marks cancelled events and drops their alarm', () => {
    const ics = buildIcs({
      name: 'Test',
      events: [
        {
          uid: 'x@test',
          sequence: 1,
          summary: 'S',
          description: 'D',
          location: 'L',
          timing: { kind: 'timed', start: new Date('2026-10-06T08:00:00Z'), end: new Date('2026-10-06T11:00:00Z') },
          cancelled: true,
          updatedAt: new Date(),
        },
      ],
    });
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('DTSTART:20261006T080000Z');
    expect(ics).not.toContain('VALARM');
  });
});

describe('notification templates', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://unused',
    PUBLIC_SITE_URL: 'https://www.example.ie',
    PUBLIC_API_URL: 'https://api.example.ie',
  });
  const booking: BookingRecord = {
    id: '00000000-0000-4000-8000-000000000000',
    reference: 'K7Q49XZ2',
    userId: null,
    serviceCode: 'full',
    serviceName: 'Full Valet',
    slotDate: '2026-10-06',
    period: 'morning',
    periodLabel: 'Morning',
    startTime: null,
    endTime: null,
    status: 'pending',
    customerName: '<script>alert(1)</script> Smith',
    customerPhone: '+353894709672',
    customerEmail: 'test@example.com',
    vehicle: 'VW Golf <b>',
    handover: 'drop_off',
    collectionAddress: null,
    notes: null,
    depositStatus: 'not_requested',
    depositSessionId: null,
    depositPayUrl: null,
    depositLinkExpiresAt: null,
    depositPaymentIntentId: null,
    depositPaidAt: null,
    depositRefundId: null,
    depositRefundStatus: null,
    servicePriceFrom: true,
    vehicleSize: 'large',
    priceCents: 10500,
    addons: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Pet hair <removal>', priceCents: 1500 }],
    addonsCents: 1500,
    discountId: null,
    discountCode: 'SPRING15',
    discountCents: 1575,
    totalCents: 10425,
    finalPriceCents: null,
    calendarToken: 'tok',
    sequence: 0,
    googleEventId: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('escapes customer-supplied text in HTML emails', () => {
    const email = customerEmail('created', booking, config)!;
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('VW Golf <b>');
    expect(email.subject).toContain('SJP-K7Q4-9XZ2');
    expect(email.attachCalendar).toBe(true);
  });

  it('keeps SMS short and includes the reference', () => {
    const sms = customerSms('confirmed', booking, config)!;
    expect(sms).toContain('SJP-K7Q4-9XZ2');
    expect(sms).toContain('https://api.example.ie/api/v1/bookings/SJP-K7Q4-9XZ2/calendar.ics?t=tok');
    expect(ownerSms('created', booking)).toContain('089 470 9672');
    expect(customerSms('completed', booking, config)).toBeNull();
  });
});

describe('infrastructure helpers', () => {
  it('splits migration files into statements', () => {
    const sql = '-- comment; ignored\nCREATE TABLE a (x INT);\n\nINSERT INTO a VALUES (1),\n  (2);\n';
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (x INT)', 'INSERT INTO a VALUES (1),\n  (2)']);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(50)).toBe(6 * 3_600_000);
  });

  it('rejects incomplete configuration with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('requires a certificate-checked database connection in production', () => {
    const prod = { NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://www.example.ie', PUBLIC_API_URL: 'https://api.example.ie' };
    const host = 'postgresql://app:pw@stjohns-1234.j77.aws-eu-west-1.cockroachlabs.cloud:26257/stjohns';
    expect(() => loadConfig({ ...prod, DATABASE_URL: host })).toThrow(/verify-full/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: `${host}?sslmode=require` })).toThrow(/verify-full/);
    expect(loadConfig({ ...prod, DATABASE_URL: `${host}?sslmode=verify-full` }).isProduction).toBe(true);
    // Local development may connect without TLS.
    expect(loadConfig({ ...prod, NODE_ENV: 'development', DATABASE_URL: 'postgresql://root@localhost:26257/stjohns?sslmode=disable' }).isProduction).toBe(false);
  });
});

describe('email sender by purpose', async () => {
  const { fromFor } = await import('../src/notifications/resend.js');
  const { loadConfig } = await import('../src/config.js');
  const base = { DATABASE_URL: 'postgresql://unused', PUBLIC_SITE_URL: 'https://www.example.ie', PUBLIC_API_URL: 'https://api.example.ie', EMAIL_FROM: 'Biz <bookings@example.ie>' };

  it('falls back to EMAIL_FROM when the purpose-specific sender is not set', () => {
    const config = loadConfig(base);
    for (const p of ['bookings', 'reminders', 'payments', 'accounts'] as const) expect(fromFor(config, p)).toBe('Biz <bookings@example.ie>');
  });

  it('uses the purpose-specific sender when set', () => {
    const config = loadConfig({ ...base, EMAIL_FROM_REMINDERS: 'Biz <reminders@example.ie>', EMAIL_FROM_PAYMENTS: 'Biz <payments@example.ie>', EMAIL_FROM_ACCOUNTS: 'Biz <accounts@example.ie>' });
    expect(fromFor(config, 'bookings')).toBe('Biz <bookings@example.ie>');
    expect(fromFor(config, 'reminders')).toBe('Biz <reminders@example.ie>');
    expect(fromFor(config, 'payments')).toBe('Biz <payments@example.ie>');
    expect(fromFor(config, 'accounts')).toBe('Biz <accounts@example.ie>');
  });
});
