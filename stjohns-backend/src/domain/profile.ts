// My profile: a signed-in customer's own details, and their GDPR rights over them (a copy of their data, erasure).
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { withTx } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { AppError, isUniqueViolation } from '../lib/errors.js';
import { displayPhone, normalizePhone } from '../lib/phone.js';
import { todayInZone } from '../lib/time.js';
import { isoDate, optionalTrimmed, parse, trimmed } from '../lib/validate.js';
import { isGoogleCalendarConfigured } from '../notifications/gcal.js';
import { ACTIVE_STATUSES, listUserBookings } from './bookings.js';
import { eraseCustomer } from './customers.js';
import { checkPassword, forgetUserSessions, type SessionUser } from './users.js';

export interface Profile {
  username: string;
  email: string;
  fullName: string;
  phone: string;
  dateOfBirth: string | null;
  address: { line1: string | null; line2: string | null; town: string | null; county: string | null; eircode: string | null };
  memberSince: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProfile(r: any): Profile {
  return {
    username: r.username,
    email: r.email,
    fullName: r.full_name,
    phone: displayPhone(r.phone),
    dateOfBirth: r.date_of_birth ?? null,
    address: { line1: r.address_line1 ?? null, line2: r.address_line2 ?? null, town: r.town ?? null, county: r.county ?? null, eircode: r.eircode ?? null },
    memberSince: r.created_at.toISOString(),
  };
}

export async function getProfile(deps: Deps, userId: string): Promise<Profile> {
  const { rows } = await deps.db.query(
    'SELECT username, email, full_name, phone, date_of_birth, address_line1, address_line2, town, county, eircode, created_at FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
  return toProfile(rows[0]);
}

/** Irish Eircode: a routing key (letter + two digits, or D6W) and a four-character identifier, e.g. X91 H79Y. */
const EIRCODE = /^([AC-FHKNPRTV-Y]\d{2}|D6W) ?([0-9AC-FHKNPRTV-Y]{4})$/i;

export const profileSchema = z.object({
  fullName: trimmed(2, 100, 'Name'),
  email: z.string({ error: 'Email is required' }).trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254)),
  phone: trimmed(6, 30, 'Phone number'),
  dateOfBirth: isoDate
    .nullish()
    .transform((v) => v ?? null)
    .refine((v) => v === null || (v >= '1900-01-01' && v <= new Date().toISOString().slice(0, 10)), 'Enter your real date of birth'),
  addressLine1: optionalTrimmed(120, 'Address'),
  addressLine2: optionalTrimmed(120, 'Address line 2'),
  town: optionalTrimmed(60, 'Town or city'),
  county: optionalTrimmed(40, 'County'),
  eircode: optionalTrimmed(8, 'Eircode')
    .refine((v) => v === null || EIRCODE.test(v), 'Enter a valid Eircode, e.g. X91 H79Y')
    .transform((v) => (v ? v.toUpperCase().replace(EIRCODE, '$1 $2') : null)),
  /** Needed only when the email changes. */
  currentPassword: z.string().max(200).optional(),
});

export async function updateProfile(deps: Deps, me: SessionUser, raw: unknown): Promise<Profile> {
  const input = parse(profileSchema, raw);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields.', { phone: 'Enter a valid phone number' });
  const today = todayInZone(deps.config.TIMEZONE);
  try {
    await withTx(deps.db, async (c) => {
      const { rows } = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1 FOR UPDATE', [me.id]);
      if (!rows[0]) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
      if (input.email !== rows[0].email) {
        // The email signs them in and receives password resets, so changing it needs the password: a session left
        // open on a shared computer can't be used to take the account over.
        if (!input.currentPassword || !(await checkPassword(c, me.id, input.currentPassword))) {
          const message = input.currentPassword ? "That password isn't right" : 'Enter your current password to change your email';
          throw new AppError('VALIDATION_FAILED', message, { currentPassword: message });
        }
      }
      await c.query(
        `UPDATE users SET full_name = $2, email = $3, phone = $4, date_of_birth = $5, address_line1 = $6, address_line2 = $7,
           town = $8, county = $9, eircode = $10, updated_at = now()
         WHERE id = $1`,
        [me.id, input.fullName, input.email, phone.e164, input.dateOfBirth, input.addressLine1, input.addressLine2, input.town, input.county, input.eircode],
      );
      // Upcoming bookings take the new name and contact details, so confirmations and reminders reach them.
      const changed = await c.query<{ id: string }>(
        `UPDATE bookings SET customer_name = $2, customer_email = $3, customer_phone = $4, sequence = sequence + 1, updated_at = now()
         WHERE user_id = $1 AND status = ANY($5::TEXT[]) AND slot_date >= $6
           AND (customer_name, customer_email, customer_phone) IS DISTINCT FROM ($2, $3, $4)
         RETURNING id`,
        [me.id, input.fullName, input.email, phone.e164, [...ACTIVE_STATUSES], today],
      );
      // The owner's calendar entries show the customer's name and phone: refresh them too.
      if (isGoogleCalendarConfigured(deps.config)) await enqueue(c, changed.rows.map((r) => ({ kind: 'gcal.sync' as const, payload: { bookingId: r.id } })));
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('CONFLICT', 'That email belongs to another account.', { email: 'That email belongs to another account' });
    throw err;
  }
  forgetUserSessions(me.id);
  deps.wakeWorker();
  return getProfile(deps, me.id);
}

/** GDPR right of access: everything held about this account, as one JSON document. */
export async function exportMyData(deps: Deps, me: SessionUser) {
  const [profile, bookings] = await Promise.all([getProfile(deps, me.id), listUserBookings(deps, me.id)]);
  return {
    exportedAt: new Date().toISOString(),
    controller: { name: deps.config.BUSINESS_NAME, phone: deps.config.BUSINESS_PHONE, address: deps.config.BUSINESS_ADDRESS },
    account: { ...profile, accountType: me.role },
    bookings,
  };
}

export const deleteAccountSchema = z.object({
  password: z.string({ error: 'Enter your password' }).min(1, 'Enter your password').max(200),
});

/**
 * GDPR right to erasure: deletes the account and removes their personal details from past bookings (which stay in
 * the business's records as "Deleted customer"), the same as the owner's delete in the dashboard.
 */
export async function deleteMyAccount(deps: Deps, me: SessionUser, raw: unknown): Promise<{ erasedBookings: number }> {
  const { password } = parse(deleteAccountSchema, raw);
  if (me.role !== 'customer') {
    throw new AppError('FORBIDDEN', "Team accounts can't be deleted here. Ask the owner to remove your dashboard access first.");
  }
  if (!(await checkPassword(deps.db, me.id, password))) {
    throw new AppError('VALIDATION_FAILED', "That password isn't right.", { password: "That password isn't right" });
  }
  try {
    return await eraseCustomer(deps, `user:${me.id}`);
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFLICT') {
      throw new AppError('CONFLICT', `You have an upcoming booking. Cancel it first (or call us on ${deps.config.BUSINESS_PHONE}), then delete your account.`);
    }
    throw err;
  }
}
