import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import {
  ACTIVE_STATUSES,
  adminListBookings,
  adminUpdateBooking,
  bookingIcsEvent,
  feedBookings,
  fetchBookingByReference,
  toAdminView,
  upcomingActiveBookingIds,
} from '../domain/bookings.js';
import { PERIOD_CODES, type PeriodCode } from '../domain/settings.js';
import { enqueue } from '../jobs/queue.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { buildIcs } from '../lib/ics.js';
import { normalizeReference } from '../lib/reference.js';
import { addDays, todayInZone } from '../lib/time.js';
import { isoDate, optionalTrimmed, parse, trimmed } from '../lib/validate.js';
import { ANALYTICS_RANGES, getAnalyticsSummary, isAnalyticsConfigured, type AnalyticsRange } from '../integrations/google-analytics.js';
import { isGoogleCalendarConfigured } from '../notifications/gcal.js';
import { requireAdmin } from '../plugins/auth.js';

const admin = { preHandler: async (req: Parameters<typeof requireAdmin>[0]) => void requireAdmin(req) };

const rangeQuery = z.object({ from: isoDate, to: isoDate });
const analyticsQuery = z.object({
  range: z.coerce
    .number()
    .default(30)
    .refine((v): v is AnalyticsRange => (ANALYTICS_RANGES as readonly number[]).includes(v), 'Use 7, 30 or 90')
    .transform((v) => v as AnalyticsRange),
});
const blockBody = z.object({
  date: isoDate,
  period: z.enum(['all', ...PERIOD_CODES] as ['all', ...PeriodCode[]]).default('all'),
  reason: optionalTrimmed(200, 'Reason'),
});
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM')
  .nullable();
const periodBody = z
  .object({
    label: trimmed(1, 40, 'Label'),
    startTime: time,
    endTime: time,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
    active: z.boolean(),
  })
  .refine((v) => (v.startTime === null) === (v.endTime === null), { path: ['endTime'], message: 'Set both times or neither' })
  .refine((v) => !v.startTime || !v.endTime || v.startTime < v.endTime, { path: ['endTime'], message: 'End must be after start' });

export async function adminRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  const { config, db } = deps;

  app.get('/admin/bookings', admin, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { bookings: await adminListBookings(deps, req.query) };
  });

  app.get('/admin/bookings/:reference', admin, async (req, reply) => {
    const ref = normalizeReference((req.params as { reference: string }).reference);
    const booking = ref ? await fetchBookingByReference(db, ref) : null;
    if (!booking) throw new AppError('NOT_FOUND', 'Booking not found.');
    const { rows } = await db.query<{ type: string; actor: string; note: string | null; created_at: Date }>(
      'SELECT type, actor, note, created_at FROM booking_events WHERE booking_id = $1 ORDER BY created_at',
      [booking.id],
    );
    reply.header('Cache-Control', 'no-store');
    return {
      booking: toAdminView(config, booking),
      events: rows.map((r) => ({ type: r.type, actor: r.actor, note: r.note, at: r.created_at.toISOString() })),
    };
  });

  /** Confirm, cancel, complete, mark no-show, request/record the deposit, or add a note. */
  app.patch('/admin/bookings/:reference', admin, async (req) => {
    const booking = await adminUpdateBooking(deps, (req.params as { reference: string }).reference, req.body, req.user!.id);
    return { booking: toAdminView(config, booking) };
  });

  app.get('/admin/blocks', admin, async (req) => {
    const q = parse(rangeQuery, req.query);
    const { rows } = await db.query(
      'SELECT id, slot_date, period, reason, created_at FROM blocked_slots WHERE slot_date BETWEEN $1 AND $2 ORDER BY slot_date, period',
      [q.from, q.to],
    );
    return { blocks: rows.map((r) => ({ id: r.id, date: r.slot_date, period: r.period, reason: r.reason, createdAt: r.created_at })) };
  });

  /** Close a slot or a whole day (holidays, weather). Existing bookings are left alone and reported back. */
  app.post('/admin/blocks', admin, async (req, reply) => {
    const input = parse(blockBody, req.body);
    const { rows } = await db.query(
      `INSERT INTO blocked_slots (slot_date, period, reason) VALUES ($1, $2, $3)
       ON CONFLICT (slot_date, period) DO UPDATE SET reason = excluded.reason
       RETURNING id, slot_date, period, reason`,
      [input.date, input.period, input.reason],
    );
    const affected = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM bookings WHERE slot_date = $1 AND ($2 = 'all' OR period = $2) AND status = ANY($3::TEXT[])`,
      [input.date, input.period, ACTIVE_STATUSES],
    );
    reply.status(201);
    return {
      block: { id: rows[0].id, date: rows[0].slot_date, period: rows[0].period, reason: rows[0].reason },
      existingBookings: Number(affected.rows[0].n),
    };
  });

  app.delete('/admin/blocks/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('NOT_FOUND', 'Block not found.');
    const res = await db.query('DELETE FROM blocked_slots WHERE id = $1', [id]);
    if (!res.rowCount) throw new AppError('NOT_FOUND', 'Block not found.');
    return { ok: true };
  });

  app.get('/admin/slot-periods', admin, async () => {
    const { periods } = await deps.settings.reload();
    return { periods };
  });

  /** Set slot times (e.g. Morning 09:00–12:00) and which weekdays each slot runs. */
  app.put('/admin/slot-periods/:code', admin, async (req) => {
    const code = (req.params as { code: string }).code as PeriodCode;
    if (!PERIOD_CODES.includes(code)) throw new AppError('NOT_FOUND', 'Unknown slot.');
    const input = parse(periodBody, req.body);
    await db.query(
      'UPDATE slot_periods SET label = $2, start_time = $3, end_time = $4, days_of_week = $5, active = $6 WHERE code = $1',
      [code, input.label, input.startTime, input.endTime, input.daysOfWeek, input.active],
    );
    // Upcoming bookings in this slot get a new calendar version so subscribed calendars pick up the new times.
    const today = todayInZone(config.TIMEZONE);
    const ids = await upcomingActiveBookingIds(db, code, today);
    if (ids.length) {
      await db.query('UPDATE bookings SET sequence = sequence + 1, updated_at = now() WHERE id = ANY($1::UUID[])', [ids]);
      if (isGoogleCalendarConfigured(config)) {
        await enqueue(db, ids.map((bookingId) => ({ kind: 'gcal.sync' as const, payload: { bookingId } })));
        deps.wakeWorker();
      }
    }
    const { periods } = await deps.settings.reload();
    return { periods, updatedBookings: ids.length };
  });

  app.get('/admin/jobs', admin, async (req) => {
    const status = (req.query as { status?: string }).status ?? 'failed';
    if (!['pending', 'running', 'done', 'failed'].includes(status)) throw new AppError('VALIDATION_FAILED', 'Unknown status.');
    const { rows } = await db.query(
      `SELECT id, kind, status, attempts, last_error, run_at, created_at, payload->>'bookingId' AS booking_id, payload->>'channel' AS channel
       FROM jobs WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
      [status],
    );
    return { jobs: rows };
  });

  app.post('/admin/jobs/:id/retry', admin, async (req) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('NOT_FOUND', 'Job not found.');
    const res = await db.query(
      "UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), locked_until = NULL WHERE id = $1 AND status = 'failed' AND kind <> 'auth.password_reset'",
      [id],
    );
    if (!res.rowCount) throw new AppError('NOT_FOUND', 'No failed job with that id can be retried.');
    deps.wakeWorker();
    return { ok: true };
  });

  /**
   * Website visitors from Google Analytics, alongside bookings from our own database for the same period.
   * Returns { configured: false } until GA4_PROPERTY_ID and the service account are set up.
   */
  app.get('/admin/analytics', admin, async (req, reply) => {
    const { range } = parse(analyticsQuery, req.query);
    const since = new Date(Date.now() - range * 86_400_000);
    const { rows } = await db.query<{ n: number }>("SELECT count(*) AS n FROM bookings WHERE created_at >= $1 AND status <> 'cancelled'", [since]);
    const bookings = Number(rows[0].n);
    reply.header('Cache-Control', 'no-store');
    if (!isAnalyticsConfigured(config)) return { configured: false, rangeDays: range, bookings };
    return { ...(await getAnalyticsSummary(config, range)), bookings };
  });

  /**
   * Owner's calendar subscription (iPhone: Settings › Calendar › Accounts › Add Subscribed Calendar).
   * Calendar apps can't send cookies, so this uses a secret key in the URL instead of a session.
   */
  app.get('/admin/calendar.ics', async (req, reply) => {
    const { key } = req.query as { key?: string };
    if (!config.ADMIN_CALENDAR_FEED_KEY || typeof key !== 'string' || !safeEqual(key, config.ADMIN_CALENDAR_FEED_KEY)) {
      throw new AppError('NOT_FOUND', 'Not found.');
    }
    const today = todayInZone(config.TIMEZONE);
    const bookings = await feedBookings(deps, addDays(today, -30), addDays(today, config.BOOKING_MAX_DAYS_AHEAD));
    const ics = buildIcs({
      name: 'St Johns Park bookings',
      refreshMinutes: 15,
      events: bookings.map((b) => bookingIcsEvent(config, b, 'owner')),
    });
    reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Cache-Control', 'private, max-age=300');
    return ics;
  });
}
