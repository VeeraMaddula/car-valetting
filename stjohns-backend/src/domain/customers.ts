// Customers for the admin dashboard. A customer is either an account holder ('user:<id>') or a guest, grouped
// by the phone number they booked with ('guest:<E.164>'). Figures come straight from bookings, so they are
// always in step with the bookings screen.
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { withTx } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { AppError } from '../lib/errors.js';
import { displayPhone, ERASED_PHONE } from '../lib/phone.js';
import { todayInZone } from '../lib/time.js';
import { isUuid, optionalTrimmed, parse } from '../lib/validate.js';
import { isGoogleCalendarConfigured } from '../notifications/gcal.js';
import { ACTIVE_STATUSES, findBookings, toAdminView } from './bookings.js';
import { forgetUserSessions, issuePasswordReset } from './users.js';

export type CustomerType = 'account' | 'guest';

export interface Customer {
  key: string;
  type: CustomerType;
  userId: string | null;
  name: string;
  email: string | null;
  phone: string;
  phoneE164: string;
  vehicle: string | null;
  /** Non-cancelled bookings. */
  bookings: number;
  cancelled: number;
  /** Completed bookings: what was charged, or the quote when the owner didn't record it. */
  spentEur: number;
  lastValet: string | null;
  lastBooking: string | null;
  firstSeen: string;
}

interface StatsRow {
  key: string;
  bookings: number;
  cancelled: number;
  spent_cents: number;
  last_valet: string | null;
  last_booking: string | null;
  first_booked: Date;
  name: string;
  phone: string;
  email: string | null;
  vehicle: string | null;
}

export async function loadCustomers(deps: Deps): Promise<Customer[]> {
  const [stats, users] = await Promise.all([
    deps.db.query<StatsRow>(
      `SELECT CASE WHEN user_id IS NOT NULL THEN 'user:' || user_id::TEXT ELSE 'guest:' || customer_phone END AS key,
              count(*) FILTER (WHERE status <> 'cancelled') AS bookings,
              count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
              COALESCE(sum(COALESCE(final_price_cents, total_cents, 0)) FILTER (WHERE status = 'completed'), 0) AS spent_cents,
              max(slot_date) FILTER (WHERE status = 'completed') AS last_valet,
              max(slot_date) FILTER (WHERE status <> 'cancelled') AS last_booking,
              min(created_at) AS first_booked,
              (array_agg(customer_name ORDER BY created_at DESC))[1] AS name,
              (array_agg(customer_phone ORDER BY created_at DESC))[1] AS phone,
              (array_agg(customer_email ORDER BY created_at DESC) FILTER (WHERE customer_email IS NOT NULL))[1] AS email,
              (array_agg(vehicle ORDER BY created_at DESC))[1] AS vehicle
       FROM bookings WHERE customer_phone <> $1
       GROUP BY 1`,
      [ERASED_PHONE],
    ),
    deps.db.query<{ id: string; full_name: string; email: string; phone: string; created_at: Date }>(
      "SELECT id, full_name, email, phone, created_at FROM users WHERE role = 'customer'",
    ),
  ]);
  const byKey = new Map(stats.rows.map((r) => [r.key, r]));
  const build = (key: string, type: CustomerType, userId: string | null, profile: { name: string; email: string | null; phone: string }, s: StatsRow | undefined, joined: Date | null): Customer => {
    const firstSeen = [joined, s?.first_booked].filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime())[0] ?? new Date();
    return {
      key,
      type,
      userId,
      name: profile.name,
      email: profile.email,
      phone: displayPhone(profile.phone),
      phoneE164: profile.phone,
      vehicle: s?.vehicle ?? null,
      bookings: Number(s?.bookings ?? 0),
      cancelled: Number(s?.cancelled ?? 0),
      spentEur: Number(s?.spent_cents ?? 0) / 100,
      lastValet: s?.last_valet ?? null,
      lastBooking: s?.last_booking ?? null,
      firstSeen: firstSeen.toISOString(),
    };
  };
  const customers = users.rows.map((u) =>
    build(`user:${u.id}`, 'account', u.id, { name: u.full_name, email: u.email, phone: u.phone }, byKey.get(`user:${u.id}`), u.created_at),
  );
  for (const r of stats.rows) {
    if (r.key.startsWith('guest:')) customers.push(build(r.key, 'guest', null, { name: r.name, email: r.email, phone: r.phone }, r, null));
  }
  return customers;
}

export const customerQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['all', 'account', 'guest', 'returning']).default('all'),
  sort: z.enum(['recent', 'bookings', 'spent', 'name']).default('recent'),
});

export function filterCustomers(list: Customer[], query: z.output<typeof customerQuerySchema>): Customer[] {
  const q = query.q?.toLowerCase() ?? '';
  // "087 123 4567" and "+353871234567" should both find the same customer.
  const digits = q.replace(/\D/g, '').replace(/^0/, '');
  const matches = (c: Customer) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    (c.email ?? '').includes(q) ||
    (c.vehicle ?? '').toLowerCase().includes(q) ||
    (digits.length >= 3 && c.phoneE164.replace(/\D/g, '').includes(digits));
  const ofType = (c: Customer) =>
    query.type === 'all' || (query.type === 'returning' ? c.bookings >= 2 : c.type === query.type);
  const byDateDesc = (a: string | null, b: string | null) => (b ?? '').localeCompare(a ?? '');
  const sorters: Record<typeof query.sort, (a: Customer, b: Customer) => number> = {
    recent: (a, b) => byDateDesc(a.lastValet ?? a.lastBooking, b.lastValet ?? b.lastBooking) || byDateDesc(a.firstSeen, b.firstSeen),
    bookings: (a, b) => b.bookings - a.bookings || a.name.localeCompare(b.name),
    spent: (a, b) => b.spentEur - a.spentEur || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  };
  return list.filter((c) => matches(c) && ofType(c)).sort(sorters[query.sort]);
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

export function customerStats(list: Customer[], now = new Date()) {
  const accounts = list.filter((c) => c.type === 'account').length;
  const returning = list.filter((c) => c.bookings >= 2).length;
  const since = now.getTime() - 30 * 86_400_000;
  return {
    total: list.length,
    accounts,
    accountsPct: pct(accounts, list.length),
    guests: list.length - accounts,
    returning,
    returningPct: pct(returning, list.length),
    new30d: list.filter((c) => new Date(c.firstSeen).getTime() >= since).length,
  };
}

// ---------- One customer ----------

type CustomerKey = { type: 'account'; userId: string } | { type: 'guest'; phone: string };

export function parseCustomerKey(key: string): CustomerKey {
  const user = /^user:(.+)$/.exec(key);
  if (user && isUuid(user[1])) return { type: 'account', userId: user[1] };
  const guest = /^guest:(\+\d{6,15})$/.exec(key);
  if (guest) return { type: 'guest', phone: guest[1] };
  throw new AppError('NOT_FOUND', 'Customer not found.');
}

function bookingsOf(deps: Deps, k: CustomerKey) {
  return k.type === 'account'
    ? findBookings(deps.db, 'b.user_id = $1', [k.userId])
    : findBookings(deps.db, 'b.user_id IS NULL AND b.customer_phone = $1', [k.phone]);
}

export async function getCustomer(deps: Deps, key: string) {
  const k = parseCustomerKey(key);
  const customer = (await loadCustomers(deps)).find((c) => c.key === key);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found.');
  const [bookings, note] = await Promise.all([
    bookingsOf(deps, k),
    deps.db.query<{ note: string }>('SELECT note FROM customer_notes WHERE customer_key = $1', [key]),
  ]);
  return { customer, bookings: bookings.map((b) => toAdminView(deps.config, b)), note: note.rows[0]?.note ?? '' };
}

async function assertExists(deps: Deps, k: CustomerKey): Promise<void> {
  const { rowCount } =
    k.type === 'account'
      ? await deps.db.query("SELECT 1 FROM users WHERE id = $1 AND role = 'customer'", [k.userId])
      : await deps.db.query('SELECT 1 FROM bookings WHERE user_id IS NULL AND customer_phone = $1 LIMIT 1', [k.phone]);
  if (!rowCount) throw new AppError('NOT_FOUND', 'Customer not found.');
}

export const noteSchema = z.object({ note: optionalTrimmed(5000, 'Note') });

export async function setCustomerNote(deps: Deps, key: string, raw: unknown): Promise<string> {
  const k = parseCustomerKey(key);
  const { note } = parse(noteSchema, raw);
  await assertExists(deps, k);
  if (!note) {
    await deps.db.query('DELETE FROM customer_notes WHERE customer_key = $1', [key]);
    return '';
  }
  await deps.db.query(
    `INSERT INTO customer_notes (customer_key, note, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (customer_key) DO UPDATE SET note = excluded.note, updated_at = now()`,
    [key, note],
  );
  return note;
}

export async function sendCustomerPasswordReset(deps: Deps, key: string): Promise<void> {
  const k = parseCustomerKey(key);
  if (k.type !== 'account') throw new AppError('VALIDATION_FAILED', 'Guests book without a password, so there is nothing to reset.');
  await assertExists(deps, k);
  await issuePasswordReset(deps, k.userId);
}

/**
 * "Delete personal data (GDPR)": the customer's name, contact details, vehicle, addresses and notes are removed
 * and any account is deleted. Bookings stay (as "Deleted customer") so the owner's records and totals still add up.
 */
export async function eraseCustomer(deps: Deps, key: string): Promise<{ erasedBookings: number }> {
  const k = parseCustomerKey(key);
  const today = todayInZone(deps.config.TIMEZONE);
  type Row = { id: string; status: string; slot_date: string; google_event_id: string | null };
  const ids = await withTx(deps.db, async (c) => {
    let rows: Row[];
    const noteKeys = [key];
    if (k.type === 'account') {
      const user = await c.query<{ phone: string; email: string }>("SELECT phone, email FROM users WHERE id = $1 AND role = 'customer' FOR UPDATE", [
        k.userId,
      ]);
      if (!user.rows[0]) throw new AppError('NOT_FOUND', 'Customer not found.');
      const { phone, email } = user.rows[0];
      // Their account bookings, plus guest bookings made with the same phone or email before (or without) signing in.
      ({ rows } = await c.query<Row>(
        `SELECT id, status, slot_date, google_event_id FROM bookings
         WHERE user_id = $1 OR (user_id IS NULL AND (customer_phone = $2 OR customer_email = $3)) FOR UPDATE`,
        [k.userId, phone, email],
      ));
      noteKeys.push(`guest:${phone}`);
    } else {
      ({ rows } = await c.query<Row>(
        'SELECT id, status, slot_date, google_event_id FROM bookings WHERE user_id IS NULL AND customer_phone = $1 FOR UPDATE',
        [k.phone],
      ));
      if (rows.length === 0) throw new AppError('NOT_FOUND', 'Customer not found.');
    }
    if (rows.some((r) => (ACTIVE_STATUSES as readonly string[]).includes(r.status) && r.slot_date >= today)) {
      throw new AppError('CONFLICT', 'This customer has an upcoming booking. Cancel it first, then delete their details.');
    }
    const bookingIds = rows.map((r) => r.id);
    if (bookingIds.length) {
      await c.query(
        `UPDATE bookings SET customer_name = 'Deleted customer', customer_phone = $2, customer_email = NULL, vehicle = 'Removed',
           collection_address = CASE WHEN handover = 'collection' THEN 'Removed' ELSE NULL END,
           notes = NULL, cancel_reason = NULL, user_id = NULL, sequence = sequence + 1, updated_at = now()
         WHERE id = ANY($1::UUID[])`,
        [bookingIds, ERASED_PHONE],
      );
      await c.query('UPDATE booking_events SET note = NULL WHERE booking_id = ANY($1::UUID[])', [bookingIds]);
      // Owner calendar entries carry the customer's name and phone: rewrite them too.
      if (isGoogleCalendarConfigured(deps.config)) {
        const synced = rows.filter((r) => r.google_event_id);
        await enqueue(c, synced.map((r) => ({ kind: 'gcal.sync' as const, payload: { bookingId: r.id } })));
      }
    }
    await c.query('DELETE FROM customer_notes WHERE customer_key = ANY($1::TEXT[])', [noteKeys]);
    if (k.type === 'account') await c.query("DELETE FROM users WHERE id = $1 AND role = 'customer'", [k.userId]);
    return bookingIds;
  });
  if (k.type === 'account') forgetUserSessions(k.userId);
  deps.wakeWorker();
  return { erasedBookings: ids.length };
}

// ---------- CSV export ----------

/** Quote every cell, and stop spreadsheets treating a value like "=HYPERLINK(…)" as a formula. */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function customersCsv(list: Customer[]): string {
  const header = ['Name', 'Type', 'Email', 'Phone', 'Vehicle', 'Bookings', 'Cancelled', 'Spent (EUR)', 'Last valet', 'First seen'];
  const rows = list.map((c) => [
    c.name,
    c.type === 'account' ? 'Account' : 'Guest',
    c.email ?? '',
    c.phone,
    c.vehicle ?? '',
    c.bookings,
    c.cancelled,
    c.spentEur.toFixed(2),
    c.lastValet ?? '',
    c.firstSeen.slice(0, 10),
  ]);
  // The byte-order mark makes Excel open the file as UTF-8 (names like Ciarán stay intact).
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
