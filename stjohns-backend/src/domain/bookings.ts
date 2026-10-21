import { z } from 'zod';
import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import { withTx, type Queryable } from '../db/pool.js';
import { enqueue, type JobInput, type NotifyTemplate } from '../jobs/queue.js';
import { randomToken } from '../lib/crypto.js';
import { AppError, isUniqueViolation } from '../lib/errors.js';
import type { IcsEvent } from '../lib/ics.js';
import { displayPhone, isMobileNumber, maskPhone, normalizePhone } from '../lib/phone.js';
import { formatReference, newReference, normalizeReference } from '../lib/reference.js';
import { addDays, longDate, shortTime, zonedTimeToUtc } from '../lib/time.js';
import { isoDate, optionalTrimmed, parse, trimmed } from '../lib/validate.js';
import { isGoogleCalendarConfigured } from '../notifications/gcal.js';
import { currentRules, slotRule, type UnavailableReason } from './availability.js';
import { effectiveEnd, effectiveStart, PERIOD_CODES, type PeriodCode } from './settings.js';

export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type DepositStatus = 'not_requested' | 'requested' | 'paid' | 'refunded' | 'waived';
export const ACTIVE_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed'];

export interface BookingRecord {
  id: string;
  reference: string;
  userId: string | null;
  serviceCode: string;
  serviceName: string;
  slotDate: string;
  period: PeriodCode;
  periodLabel: string;
  startTime: string | null;
  endTime: string | null;
  status: BookingStatus;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  vehicle: string;
  handover: 'drop_off' | 'collection';
  collectionAddress: string | null;
  notes: string | null;
  depositStatus: DepositStatus;
  depositSessionId: string | null;
  depositPayUrl: string | null;
  depositLinkExpiresAt: Date | null;
  depositPaymentIntentId: string | null;
  depositPaidAt: Date | null;
  depositRefundId: string | null;
  calendarToken: string;
  sequence: number;
  googleEventId: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_BOOKING = `
  SELECT b.id, b.reference, b.user_id, b.service_code, s.name AS service_name, b.slot_date, b.period,
         p.label AS period_label, p.start_time, p.end_time, b.status, b.customer_name, b.customer_phone,
         b.customer_email, b.vehicle, b.handover, b.collection_address, b.notes, b.deposit_status,
         b.deposit_session_id, b.deposit_pay_url, b.deposit_link_expires_at, b.deposit_payment_intent_id,
         b.deposit_paid_at, b.deposit_refund_id,
         b.calendar_token, b.sequence, b.google_event_id, b.cancelled_at, b.cancel_reason, b.created_at, b.updated_at
  FROM bookings b
  JOIN services s ON s.code = b.service_code
  JOIN slot_periods p ON p.code = b.period`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(r: any): BookingRecord {
  return {
    id: r.id,
    reference: r.reference,
    userId: r.user_id,
    serviceCode: r.service_code,
    serviceName: r.service_name,
    slotDate: r.slot_date,
    period: r.period,
    periodLabel: r.period_label,
    startTime: r.start_time,
    endTime: r.end_time,
    status: r.status,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    customerEmail: r.customer_email,
    vehicle: r.vehicle,
    handover: r.handover,
    collectionAddress: r.collection_address,
    notes: r.notes,
    depositStatus: r.deposit_status,
    depositSessionId: r.deposit_session_id ?? null,
    depositPayUrl: r.deposit_pay_url ?? null,
    depositLinkExpiresAt: r.deposit_link_expires_at ?? null,
    depositPaymentIntentId: r.deposit_payment_intent_id ?? null,
    depositPaidAt: r.deposit_paid_at ?? null,
    depositRefundId: r.deposit_refund_id ?? null,
    calendarToken: r.calendar_token,
    sequence: Number(r.sequence),
    googleEventId: r.google_event_id,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function fetchBookingById(db: Queryable, id: string): Promise<BookingRecord | null> {
  const { rows } = await db.query(`${SELECT_BOOKING} WHERE b.id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function fetchBookingByReference(db: Queryable, reference: string): Promise<BookingRecord | null> {
  const { rows } = await db.query(`${SELECT_BOOKING} WHERE b.reference = $1`, [reference]);
  return rows[0] ? mapRow(rows[0]) : null;
}

// ---------- Presentation ----------

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Missed',
};

const EVENT_LABELS: Record<string, string> = {
  created: 'Booking requested',
  confirmed: 'Booking confirmed',
  deposit_requested: 'Deposit requested',
  deposit_paid: 'Deposit received',
  deposit_refunded: 'Deposit refunded',
  deposit_waived: 'Deposit waived',
  deposit_link_sent: 'Payment link sent',
  deposit_failed: 'Payment did not go through',
  cancelled: 'Booking cancelled',
  completed: 'Valet completed',
  no_show: 'Marked as missed',
  claimed: 'Added to your account',
};

export function timeLabel(b: Pick<BookingRecord, 'startTime' | 'endTime'>): string {
  return b.startTime ? `${shortTime(b.startTime)}–${shortTime(b.endTime) ?? ''}`.replace(/–$/, '') : 'Time to be confirmed';
}

/** 'Saturday 3 October 2026 · Morning (09:00–12:00)' */
export function whenLabel(b: BookingRecord): string {
  return `${longDate(b.slotDate)} · ${b.periodLabel}${b.startTime ? ` (${timeLabel(b)})` : ''}`;
}

export function trackUrl(config: Config, b: Pick<BookingRecord, 'reference'>): string {
  return `${config.PUBLIC_SITE_URL.replace(/\/$/, '')}/track.html?ref=${encodeURIComponent(formatReference(b.reference))}`;
}

export function calendarUrl(config: Config, b: Pick<BookingRecord, 'reference' | 'calendarToken'>): string {
  return `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/bookings/${formatReference(b.reference)}/calendar.ics?t=${b.calendarToken}`;
}

export function cancelDeadline(config: Config, b: BookingRecord): Date {
  const start = zonedTimeToUtc(b.slotDate, effectiveStart({ code: b.period, startTime: b.startTime }), config.TIMEZONE);
  return new Date(start.getTime() - config.CANCEL_CUTOFF_HOURS * 3_600_000);
}

export function canCustomerCancel(config: Config, b: BookingRecord, now = new Date()): boolean {
  return ACTIVE_STATUSES.includes(b.status) && now < cancelDeadline(config, b);
}

export interface TimelineEntry {
  type: string;
  label: string;
  at: string;
}

async function timeline(db: Queryable, bookingId: string): Promise<TimelineEntry[]> {
  const { rows } = await db.query<{ type: string; created_at: Date }>(
    'SELECT type, created_at FROM booking_events WHERE booking_id = $1 ORDER BY created_at',
    [bookingId],
  );
  return rows
    .filter((r) => EVENT_LABELS[r.type])
    .map((r) => ({ type: r.type, label: EVENT_LABELS[r.type], at: r.created_at.toISOString() }));
}

export interface ViewOptions {
  /** Hide most of the phone number (tracking by reference). */
  maskPhone?: boolean;
  timeline?: TimelineEntry[];
}

/** The Checkout link, if the customer can still use it. */
export function depositPayUrl(b: BookingRecord, now = new Date()): string | null {
  if (b.depositStatus !== 'requested' || !b.depositPayUrl) return null;
  if (!ACTIVE_STATUSES.includes(b.status)) return null;
  if (b.depositLinkExpiresAt && b.depositLinkExpiresAt.getTime() <= now.getTime()) return null;
  return b.depositPayUrl;
}

export function toCustomerView(config: Config, b: BookingRecord, opts: ViewOptions = {}) {
  const now = new Date();
  const deadline = cancelDeadline(config, b);
  return {
    reference: formatReference(b.reference),
    status: b.status,
    statusLabel: STATUS_LABELS[b.status],
    service: { code: b.serviceCode, name: b.serviceName },
    date: b.slotDate,
    dateLabel: longDate(b.slotDate),
    period: { code: b.period, label: b.periodLabel, startTime: shortTime(b.startTime), endTime: shortTime(b.endTime) },
    timeLabel: timeLabel(b),
    customerName: b.customerName,
    phone: opts.maskPhone ? maskPhone(b.customerPhone) : displayPhone(b.customerPhone),
    email: opts.maskPhone ? null : b.customerEmail,
    vehicle: b.vehicle,
    handover: b.handover,
    collectionAddress: opts.maskPhone ? null : b.collectionAddress,
    deposit: {
      status: b.depositStatus,
      amountEur: config.DEPOSIT_AMOUNT_EUR,
      // Only while the link is live and the booking is still active: the customer can pay online.
      payUrl: depositPayUrl(b, now),
      paidAt: b.depositPaidAt?.toISOString() ?? null,
    },
    canCancel: canCustomerCancel(config, b),
    cancelDeadline: deadline.toISOString(),
    calendarUrl: b.status === 'cancelled' ? null : calendarUrl(config, b),
    trackUrl: trackUrl(config, b),
    createdAt: b.createdAt.toISOString(),
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    ...(opts.timeline ? { timeline: opts.timeline } : {}),
  };
}

export function toAdminView(config: Config, b: BookingRecord) {
  return {
    ...toCustomerView(config, b),
    id: b.id,
    phone: displayPhone(b.customerPhone),
    phoneE164: b.customerPhone,
    email: b.customerEmail,
    collectionAddress: b.collectionAddress,
    notes: b.notes,
    userId: b.userId,
    cancelReason: b.cancelReason,
    googleEventId: b.googleEventId,
    depositSessionId: b.depositSessionId,
    depositPaymentIntentId: b.depositPaymentIntentId,
    depositRefundId: b.depositRefundId,
    depositLinkExpiresAt: b.depositLinkExpiresAt?.toISOString() ?? null,
    updatedAt: b.updatedAt.toISOString(),
  };
}

// ---------- Calendar (.ics) ----------

export function bookingIcsEvent(config: Config, b: BookingRecord, audience: 'customer' | 'owner'): IcsEvent {
  const timed = Boolean(b.startTime);
  const location = b.handover === 'collection' && b.collectionAddress ? b.collectionAddress : config.BUSINESS_ADDRESS;
  const summary =
    audience === 'customer'
      ? `${b.serviceName} — St Johns Park Valeting`
      : `${b.periodLabel}: ${b.serviceName} — ${b.customerName}`;
  const description =
    audience === 'customer'
      ? [
          `Booking ${formatReference(b.reference)} (${STATUS_LABELS[b.status]})`,
          `${b.periodLabel} slot${timed ? ` ${timeLabel(b)}` : ' — time to be confirmed'}`,
          `Vehicle: ${b.vehicle}`,
          b.handover === 'collection' ? 'We will collect your car.' : `Drop off at ${config.BUSINESS_ADDRESS}`,
          `Questions? Call ${config.BUSINESS_PHONE}`,
          `Track: ${trackUrl(config, b)}`,
        ].join('\n')
      : [
          `${formatReference(b.reference)} — ${STATUS_LABELS[b.status]}`,
          `Customer: ${b.customerName} ${displayPhone(b.customerPhone)}${b.customerEmail ? ` ${b.customerEmail}` : ''}`,
          `Vehicle: ${b.vehicle}`,
          b.handover === 'collection' ? `Collection from: ${b.collectionAddress ?? ''}` : 'Drop off',
          b.notes ? `Notes: ${b.notes}` : '',
        ]
          .filter(Boolean)
          .join('\n');
  return {
    uid: `${b.id}@stjohnsparkvaleting`,
    sequence: b.sequence,
    summary,
    description,
    location,
    timing: timed
      ? {
          kind: 'timed',
          start: zonedTimeToUtc(b.slotDate, effectiveStart({ code: b.period, startTime: b.startTime }), config.TIMEZONE),
          end: zonedTimeToUtc(b.slotDate, effectiveEnd({ code: b.period, endTime: b.endTime }), config.TIMEZONE),
        }
      : { kind: 'allDay', date: b.slotDate },
    cancelled: b.status === 'cancelled',
    url: trackUrl(config, b),
    updatedAt: b.updatedAt,
  };
}

// ---------- Notification planning ----------

function customerJobs(b: Pick<BookingRecord, 'id' | 'customerEmail' | 'customerPhone'>, template: NotifyTemplate, runAt?: Date): JobInput[] {
  const jobs: JobInput[] = [];
  if (b.customerEmail) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_email', template }, runAt });
  if (isMobileNumber(b.customerPhone)) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_sms', template }, runAt });
  return jobs;
}

function ownerJobs(config: Config, bookingId: string, template: NotifyTemplate): JobInput[] {
  const jobs: JobInput[] = [];
  if (config.OWNER_EMAIL) jobs.push({ kind: 'notify', payload: { bookingId, channel: 'owner_email', template } });
  if (config.OWNER_PHONE) jobs.push({ kind: 'notify', payload: { bookingId, channel: 'owner_sms', template } });
  return jobs;
}

function calendarJobs(config: Config, bookingId: string): JobInput[] {
  return isGoogleCalendarConfigured(config) ? [{ kind: 'gcal.sync', payload: { bookingId } }] : [];
}

/** On cancellation: refund a paid deposit, or kill a live payment link so an old email can't be paid. */
function depositJobsOnCancel(config: Config, b: BookingRecord): JobInput[] {
  if (!config.stripeEnabled) return [];
  if (b.depositStatus === 'paid' && b.depositPaymentIntentId) return [{ kind: 'deposit.refund', payload: { bookingId: b.id } }];
  if (b.depositStatus === 'requested' && b.depositSessionId) return [{ kind: 'deposit.expire', payload: { bookingId: b.id, sessionId: b.depositSessionId } }];
  return [];
}

/** 6pm the evening before the slot, unless that has already passed. */
export function reminderTime(config: Config, slotDate: string, now = new Date()): Date | null {
  const at = zonedTimeToUtc(addDays(slotDate, -1), '18:00', config.TIMEZONE);
  return at.getTime() > now.getTime() + 30 * 60_000 ? at : null;
}

// ---------- Create ----------

const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  past: 'That date has already passed. Please choose another day.',
  beyond_window: 'That date is too far ahead to book online yet.',
  closed: "We're closed for that slot. Please choose another day or slot.",
  blocked: 'That slot is not available. Please choose another.',
  too_soon: 'That slot is too soon to book online. Please choose a later slot or call us.',
};

const emailField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.email('Enter a valid email address').max(254).nullish(),
);

export const createBookingSchema = z
  .object({
    serviceCode: z.string({ error: 'Choose a service' }).min(1, 'Choose a service').max(40),
    date: isoDate,
    period: z.enum(PERIOD_CODES as [PeriodCode, ...PeriodCode[]], { error: 'Choose a slot' }),
    name: trimmed(2, 100, 'Name'),
    phone: trimmed(6, 30, 'Phone number'),
    email: emailField,
    vehicle: trimmed(2, 120, 'Vehicle'),
    handover: z.enum(['drop_off', 'collection']).default('drop_off'),
    collectionAddress: optionalTrimmed(300, 'Collection address'),
    notes: optionalTrimmed(1000, 'Notes'),
  })
  .superRefine((v, ctx) => {
    if (v.handover === 'collection' && !v.collectionAddress) {
      ctx.addIssue({ code: 'custom', path: ['collectionAddress'], message: 'Enter the collection address' });
    }
  });

export type CreateBookingInput = z.output<typeof createBookingSchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'Invalid Idempotency-Key')
  .optional();

export interface CreateContext {
  userId: string | null;
  userEmail: string | null;
  idempotencyKey?: string;
}

/** Create a booking. The partial unique index guarantees one active booking per slot under any concurrency. */
export async function createBooking(deps: Deps, raw: unknown, ctx: CreateContext): Promise<{ booking: BookingRecord; created: boolean }> {
  const input = parse(createBookingSchema, raw);
  const settings = await deps.settings.get();
  const service = settings.services.find((s) => s.code === input.serviceCode && s.active);
  if (!service) throw new AppError('VALIDATION_FAILED', 'Please choose a service.', { serviceCode: 'Choose a service' });
  const period = settings.periods.find((p) => p.code === input.period);
  if (!period) throw new AppError('VALIDATION_FAILED', 'Please choose a slot.', { period: 'Choose a slot' });
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields.', { phone: 'Enter a valid phone number' });

  const rules = await currentRules(deps);
  const rule = slotRule(input.date, period, rules);
  if (rule) throw new AppError('SLOT_UNAVAILABLE', UNAVAILABLE_MESSAGES[rule]);

  const email = input.email ?? ctx.userEmail ?? null;

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await withTx(deps.db, async (c) => {
        if (ctx.idempotencyKey) {
          const existing = await c.query<{ id: string }>('SELECT id FROM bookings WHERE idempotency_key = $1', [ctx.idempotencyKey]);
          if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
        }
        const blocked = await c.query(
          "SELECT 1 FROM blocked_slots WHERE slot_date = $1 AND period IN ($2, 'all') LIMIT 1",
          [input.date, input.period],
        );
        if (blocked.rowCount) throw new AppError('SLOT_UNAVAILABLE', UNAVAILABLE_MESSAGES.blocked);

        const inserted = await c.query<{ id: string }>(
          `INSERT INTO bookings (reference, user_id, service_code, slot_date, period, customer_name, customer_phone,
             customer_email, vehicle, handover, collection_address, notes, calendar_token, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [
            newReference(),
            ctx.userId,
            service.code,
            input.date,
            input.period,
            input.name,
            phone.e164,
            email,
            input.vehicle,
            input.handover,
            input.handover === 'collection' ? input.collectionAddress : null,
            input.notes,
            randomToken(18),
            ctx.idempotencyKey ?? null,
          ],
        );
        const id = inserted.rows[0].id;
        await c.query('INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, $2, $3)', [
          id,
          'created',
          ctx.userId ? 'customer' : 'guest',
        ]);
        const target = { id, customerEmail: email, customerPhone: phone.e164 };
        const reminderAt = reminderTime(deps.config, input.date);
        await enqueue(c, [
          ...customerJobs(target, 'created'),
          ...ownerJobs(deps.config, id, 'created'),
          ...calendarJobs(deps.config, id),
          ...(reminderAt ? customerJobs(target, 'reminder', reminderAt) : []),
        ]);
        return { id, created: true };
      });
      if (result.created) deps.wakeWorker();
      const booking = await fetchBookingById(deps.db, result.id);
      if (!booking) throw new AppError('INTERNAL', 'Booking could not be loaded.');
      return { booking, created: result.created };
    } catch (err) {
      if (isUniqueViolation(err, 'bookings_one_active_per_slot')) {
        throw new AppError('SLOT_UNAVAILABLE', 'Sorry, that slot was just booked by someone else. Please choose another.');
      }
      if (isUniqueViolation(err, 'bookings_idempotency_key') && ctx.idempotencyKey) {
        const { rows } = await deps.db.query<{ id: string }>('SELECT id FROM bookings WHERE idempotency_key = $1', [ctx.idempotencyKey]);
        const booking = rows[0] ? await fetchBookingById(deps.db, rows[0].id) : null;
        if (booking) return { booking, created: false };
      }
      if (isUniqueViolation(err, 'bookings_reference_key') && attempt < 3) continue;
      throw err;
    }
  }
}

// ---------- Tracking (guests and account holders) ----------

export const trackSchema = z.object({
  reference: z.string({ error: 'Enter your booking reference' }).trim().min(1, 'Enter your booking reference').max(40),
  phone: z.string({ error: 'Enter the phone number used to book' }).trim().min(1, 'Enter the phone number used to book').max(40),
});

const NOT_FOUND_MESSAGE = 'We could not find a booking with that reference and phone number.';

/** Find a booking by reference, proven by the phone number used to book it. */
export async function findByReferenceAndPhone(db: Queryable, referenceInput: string, phoneInput: string): Promise<BookingRecord> {
  const reference = normalizeReference(referenceInput);
  const phone = normalizePhone(phoneInput);
  const booking = reference && phone ? await fetchBookingByReference(db, reference) : null;
  if (!booking || booking.customerPhone !== phone!.e164) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
  return booking;
}

export async function trackBooking(deps: Deps, raw: unknown) {
  const input = parse(trackSchema, raw);
  const booking = await findByReferenceAndPhone(deps.db, input.reference, input.phone);
  return toCustomerView(deps.config, booking, { maskPhone: true, timeline: await timeline(deps.db, booking.id) });
}

export async function bookingDetail(deps: Deps, booking: BookingRecord) {
  return toCustomerView(deps.config, booking, { timeline: await timeline(deps.db, booking.id) });
}

// ---------- Cancellation ----------

export async function cancelByCustomer(deps: Deps, bookingId: string, reason: string | null, actor: 'customer' | 'guest'): Promise<BookingRecord> {
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query(`${SELECT_BOOKING} WHERE b.id = $1 FOR UPDATE OF b`, [bookingId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    const b = mapRow(rows[0]);
    if (b.status === 'cancelled') return;
    if (!canCustomerCancel(deps.config, b)) {
      throw new AppError(
        'CANCELLATION_CLOSED',
        ACTIVE_STATUSES.includes(b.status)
          ? `Online cancellation closes ${deps.config.CANCEL_CUTOFF_HOURS} hours before your slot. Please call ${deps.config.BUSINESS_PHONE}.`
          : 'This booking can no longer be cancelled.',
      );
    }
    await c.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, sequence = sequence + 1, updated_at = now()
       WHERE id = $1`,
      [b.id, reason],
    );
    await c.query('INSERT INTO booking_events (booking_id, type, actor, note) VALUES ($1, $2, $3, $4)', [b.id, 'cancelled', actor, reason]);
    await enqueue(c, [
      ...customerJobs(b, 'cancelled'),
      ...ownerJobs(deps.config, b.id, 'cancelled_by_customer'),
      ...calendarJobs(deps.config, b.id),
      ...depositJobsOnCancel(deps.config, b),
    ]);
  });
  deps.wakeWorker();
  const updated = await fetchBookingById(deps.db, bookingId);
  if (!updated) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
  return updated;
}

// ---------- Accounts ----------

export async function listUserBookings(deps: Deps, userId: string) {
  const { rows } = await deps.db.query(
    `${SELECT_BOOKING} WHERE b.user_id = $1 ORDER BY b.slot_date DESC, p.sort DESC LIMIT 200`,
    [userId],
  );
  return rows.map((r) => toCustomerView(deps.config, mapRow(r)));
}

export async function findUserBooking(deps: Deps, userId: string, referenceInput: string): Promise<BookingRecord> {
  const reference = normalizeReference(referenceInput);
  const booking = reference ? await fetchBookingByReference(deps.db, reference) : null;
  if (!booking || booking.userId !== userId) throw new AppError('NOT_FOUND', 'Booking not found.');
  return booking;
}

/** Attach a guest booking to the signed-in account, proven by reference + phone. */
export async function claimBooking(deps: Deps, userId: string, raw: unknown) {
  const input = parse(trackSchema, raw);
  const booking = await findByReferenceAndPhone(deps.db, input.reference, input.phone);
  if (booking.userId && booking.userId !== userId) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
  if (!booking.userId) {
    await withTx(deps.db, async (c) => {
      const res = await c.query('UPDATE bookings SET user_id = $1, updated_at = now() WHERE id = $2 AND user_id IS NULL', [userId, booking.id]);
      if (res.rowCount) {
        await c.query("INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, 'claimed', 'customer')", [booking.id]);
      }
    });
  }
  const updated = await fetchBookingById(deps.db, booking.id);
  return toCustomerView(deps.config, updated!);
}

// ---------- Admin ----------

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: ['completed'],
};

export const adminUpdateSchema = z
  .object({
    status: z.enum(['confirmed', 'completed', 'cancelled', 'no_show']).optional(),
    depositStatus: z.enum(['not_requested', 'requested', 'paid', 'refunded', 'waived']).optional(),
    note: optionalTrimmed(1000, 'Note'),
  })
  .refine((v) => v.status || v.depositStatus || v.note, { message: 'Nothing to update' });

export async function adminUpdateBooking(deps: Deps, referenceInput: string, raw: unknown, adminId: string): Promise<BookingRecord> {
  const input = parse(adminUpdateSchema, raw);
  const reference = normalizeReference(referenceInput);
  if (!reference) throw new AppError('NOT_FOUND', 'Booking not found.');
  let bookingId = '';
  let changed = false;
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query(`${SELECT_BOOKING} WHERE b.reference = $1 FOR UPDATE OF b`, [reference]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Booking not found.');
    const b = mapRow(rows[0]);
    bookingId = b.id;
    const jobs: JobInput[] = [];
    const events: { type: string; note: string | null }[] = [];
    let statusChanged = false;

    if (input.status && input.status !== b.status) {
      if (!TRANSITIONS[b.status].includes(input.status)) {
        throw new AppError('INVALID_TRANSITION', `A ${STATUS_LABELS[b.status].toLowerCase()} booking cannot be marked ${input.status.replace('_', ' ')}.`);
      }
      statusChanged = true;
      events.push({ type: input.status, note: input.status === 'cancelled' ? input.note : null });
      if (input.status === 'confirmed') jobs.push(...customerJobs(b, 'confirmed'));
      if (input.status === 'cancelled') jobs.push(...customerJobs(b, 'cancelled'), ...depositJobsOnCancel(deps.config, b));
      if (input.status === 'completed' && b.customerEmail) {
        jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_email', template: 'completed' } });
      }
      jobs.push(...calendarJobs(deps.config, b.id));
    }
    if (input.depositStatus && input.depositStatus !== b.depositStatus) {
      if (input.depositStatus === 'refunded' && b.depositStatus !== 'paid') {
        throw new AppError('INVALID_TRANSITION', 'Only a paid deposit can be refunded.');
      }
      if (input.depositStatus !== 'not_requested') events.push({ type: `deposit_${input.depositStatus}`, note: null });
      if (input.depositStatus === 'requested') {
        // With Stripe on, the worker creates the Checkout link first and then sends the "pay your deposit" messages.
        // Without it, the messages go straight out with DEPOSIT_INSTRUCTIONS.
        if (deps.config.stripeEnabled) jobs.push({ kind: 'deposit.link', payload: { bookingId: b.id } });
        else jobs.push(...customerJobs(b, 'deposit_requested'));
      }
      if (input.depositStatus === 'refunded' && deps.config.stripeEnabled && b.depositPaymentIntentId) {
        jobs.push({ kind: 'deposit.refund', payload: { bookingId: b.id } });
      }
    }
    if (input.note && !(statusChanged && input.status === 'cancelled')) events.push({ type: 'note', note: input.note });

    await c.query(
      `UPDATE bookings SET
         status = COALESCE($2, status),
         deposit_status = COALESCE($3, deposit_status),
         cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
         cancel_reason = CASE WHEN $2 = 'cancelled' THEN $4 ELSE cancel_reason END,
         sequence = sequence + $5,
         updated_at = now()
       WHERE id = $1`,
      [b.id, statusChanged ? input.status : null, input.depositStatus ?? null, input.note, statusChanged ? 1 : 0],
    );
    for (const e of events) {
      await c.query('INSERT INTO booking_events (booking_id, type, actor, note) VALUES ($1, $2, $3, $4)', [b.id, e.type, `admin:${adminId}`, e.note]);
    }
    await enqueue(c, jobs);
    changed = jobs.length > 0;
  });
  if (changed) deps.wakeWorker();
  return (await fetchBookingById(deps.db, bookingId))!;
}

export const adminListSchema = z.object({
  from: isoDate,
  to: isoDate,
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'no_show']))),
});

export async function adminListBookings(deps: Deps, raw: unknown) {
  const input = parse(adminListSchema, raw);
  const params: unknown[] = [input.from, input.to];
  let filter = '';
  if (input.status.length) {
    params.push(input.status);
    filter = ' AND b.status = ANY($3::TEXT[])';
  }
  const { rows } = await deps.db.query(
    `${SELECT_BOOKING} WHERE b.slot_date BETWEEN $1 AND $2${filter} ORDER BY b.slot_date, p.sort LIMIT 1000`,
    params,
  );
  return rows.map((r) => toAdminView(deps.config, mapRow(r)));
}

/** Bookings for the owner's subscribed calendar feed (iPhone/iCloud "Subscribed Calendar"). */
export async function feedBookings(deps: Deps, from: string, to: string): Promise<BookingRecord[]> {
  const { rows } = await deps.db.query(
    `${SELECT_BOOKING} WHERE b.slot_date BETWEEN $1 AND $2 ORDER BY b.slot_date, p.sort LIMIT 2000`,
    [from, to],
  );
  return rows.map(mapRow);
}

export async function upcomingActiveBookingIds(db: Queryable, period: PeriodCode, fromDate: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM bookings WHERE period = $1 AND slot_date >= $2 AND status IN ('pending', 'confirmed') LIMIT 500",
    [period, fromDate],
  );
  return rows.map((r) => r.id);
}
