import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import {
  ACTIVE_STATUSES,
  bookingIcsEvent,
  feedBookings,
  fetchBookingById,
  timeLabel,
  type BookingRecord,
} from '../domain/bookings.js';
import { effectiveEnd, effectiveStart } from '../domain/settings.js';
import { PermanentProviderError } from '../lib/errors.js';
import { buildIcs } from '../lib/ics.js';
import { isMobileNumber, normalizePhone } from '../lib/phone.js';
import { formatReference } from '../lib/reference.js';
import { addDays, todayInZone, zonedTimeToUtc } from '../lib/time.js';
import { isGoogleCalendarConfigured, upsertCalendarEvent, type CalendarEventBody } from '../notifications/gcal.js';
import { sendEmail, type SendResult } from '../notifications/resend.js';
import { sendSms } from '../notifications/sendmode.js';
import {
  customerEmail,
  customerSms,
  ownerDailySummaryEmail,
  ownerEmail,
  ownerSms,
  passwordResetEmail,
  teamInviteEmail,
  type RenderedEmail,
} from '../notifications/templates.js';
import { createDepositLink, expireDepositLink, refundDepositForBooking } from '../domain/deposits.js';
import type { JobInput, NotifyTemplate } from './queue.js';

interface ClaimedJob {
  id: string;
  kind: JobInput['kind'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  attempts: number;
  max_attempts: number;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const CLAIM_SQL = `
  UPDATE jobs
  SET status = 'running', locked_until = now() + INTERVAL '2 minutes', attempts = attempts + 1, updated_at = now()
  WHERE id IN (
    SELECT id FROM jobs
    WHERE status IN ('pending', 'running') AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
    ORDER BY run_at
    LIMIT $1
  )
  RETURNING id, kind, payload, attempts, max_attempts`;

// Payloads holding secrets (reset and invite tokens) are wiped once the job finishes.
const SCRUB = "payload = CASE WHEN kind IN ('auth.password_reset', 'team.invite') THEN '{}'::JSONB ELSE payload END";

const siteUrl = (config: Config, path: string) => `${config.PUBLIC_SITE_URL.replace(/\/$/, '')}/${path}`;

/** When the next 8am (business time zone) daily summary is due: today if it's before 8am, otherwise tomorrow. */
export function nextDailySummary(timeZone: string, now = new Date()): { date: string; runAt: Date } {
  const today = todayInZone(timeZone, now);
  const todayAt = zonedTimeToUtc(today, '08:00', timeZone);
  if (todayAt.getTime() > now.getTime()) return { date: today, runAt: todayAt };
  const tomorrow = addDays(today, 1);
  return { date: tomorrow, runAt: zonedTimeToUtc(tomorrow, '08:00', timeZone) };
}

const ACTIVE_ONLY: NotifyTemplate[] = ['created', 'confirmed', 'reminder', 'deposit_requested', 'deposit_paid'];

function describe(result: SendResult): string {
  return result.sent ? `sent ${result.id}` : `skipped: ${result.reason}`;
}

function withCalendar(config: Config, b: BookingRecord, email: RenderedEmail) {
  if (!email.attachCalendar) return undefined;
  // DTSTAMP uses updatedAt so a retried email is byte-identical (keeps Resend's idempotency key valid).
  const ics = buildIcs({ name: config.BUSINESS_NAME, events: [bookingIcsEvent(config, b, 'customer')] }, b.updatedAt);
  return [{ filename: 'valet-booking.ics', content: Buffer.from(ics).toString('base64') }];
}

function calendarBody(config: Config, b: BookingRecord): CalendarEventBody {
  const ics = bookingIcsEvent(config, b, 'owner');
  const timed = Boolean(b.startTime);
  const tz = config.TIMEZONE;
  return {
    summary: `${ics.summary} (${formatReference(b.reference)})`,
    description: ics.description,
    location: ics.location,
    start: timed ? { dateTime: `${b.slotDate}T${effectiveStart({ code: b.period, startTime: b.startTime })}:00`, timeZone: tz } : { date: b.slotDate },
    end: timed ? { dateTime: `${b.slotDate}T${effectiveEnd({ code: b.period, endTime: b.endTime })}:00`, timeZone: tz } : { date: addDays(b.slotDate, 1) },
    status: b.status === 'cancelled' ? 'cancelled' : b.status === 'pending' ? 'tentative' : 'confirmed',
    colorId: { pending: '5', confirmed: '10', completed: '8', cancelled: '8', no_show: '11' }[b.status],
  };
}

export async function handleJob(deps: Deps, job: ClaimedJob): Promise<string> {
  const { config, db } = deps;
  switch (job.kind) {
    case 'notify': {
      const { bookingId, channel, template } = job.payload as { bookingId: string; channel: string; template: NotifyTemplate };
      const b = await fetchBookingById(db, bookingId);
      if (!b) return 'skipped: booking not found';
      if (ACTIVE_ONLY.includes(template) && !ACTIVE_STATUSES.includes(b.status)) return `skipped: booking is ${b.status}`;
      // Owner switches are checked at send time too, so turning them off also stops messages already queued.
      const { site } = await deps.settings.get();
      if (template === 'reminder' && !site.messages.reminder) return 'skipped: reminders are turned off';
      if (template === 'review_request') {
        if (!site.messages.reviewRequest || !site.messages.googleReviewUrl) return 'skipped: review requests are turned off';
        if (b.status !== 'completed') return `skipped: booking is ${b.status}`;
      }
      switch (channel) {
        case 'customer_email': {
          if (!b.customerEmail) return 'skipped: no email';
          if (template === 'deposit_requested' && config.stripeEnabled && !b.depositPayUrl) return 'skipped: no payment link yet';
          const email = customerEmail(template, b, config, { reviewUrl: site.messages.googleReviewUrl });
          if (!email) return 'skipped: no template';
          return describe(await sendEmail(config, { to: b.customerEmail, ...email, attachments: withCalendar(config, b, email) }, job.id));
        }
        case 'customer_sms': {
          if (template === 'deposit_requested' && config.stripeEnabled && !b.depositPayUrl) return 'skipped: no payment link yet';
          const text = customerSms(template, b, config);
          if (!text) return 'skipped: no template';
          if (!isMobileNumber(b.customerPhone)) return 'skipped: not a mobile number';
          return describe(await sendSms(config, b.customerPhone, text, formatReference(b.reference)));
        }
        case 'owner_email': {
          if (!config.OWNER_EMAIL) return 'skipped: OWNER_EMAIL not set';
          const email = ownerEmail(template, b, config);
          if (!email) return 'skipped: no template';
          return describe(await sendEmail(config, { to: config.OWNER_EMAIL, ...email }, job.id));
        }
        case 'owner_sms': {
          const owner = config.OWNER_PHONE ? normalizePhone(config.OWNER_PHONE) : null;
          if (!owner) return 'skipped: OWNER_PHONE not set or invalid';
          const text = ownerSms(template, b);
          if (!text) return 'skipped: no template';
          return describe(await sendSms(config, owner.e164, text, formatReference(b.reference)));
        }
        default:
          throw new PermanentProviderError(`unknown channel ${channel}`);
      }
    }
    case 'gcal.sync': {
      if (!isGoogleCalendarConfigured(config)) return 'skipped: Google Calendar not configured';
      const b = await fetchBookingById(db, job.payload.bookingId);
      if (!b) return 'skipped: booking not found';
      const eventId = await upsertCalendarEvent(config, b.id, calendarBody(config, b));
      if (b.googleEventId !== eventId) await db.query('UPDATE bookings SET google_event_id = $2 WHERE id = $1', [b.id, eventId]);
      return `synced ${eventId}`;
    }
    case 'deposit.link':
      if (!config.stripeEnabled) return 'skipped: Stripe not configured';
      return createDepositLink(deps, job.payload.bookingId);
    case 'deposit.expire':
      if (!config.stripeEnabled) return 'skipped: Stripe not configured';
      return expireDepositLink(deps, job.payload.bookingId, job.payload.sessionId);
    case 'deposit.refund':
      if (!config.stripeEnabled) return 'skipped: Stripe not configured';
      return refundDepositForBooking(deps, job.payload.bookingId);
    case 'auth.password_reset': {
      const { userId, token } = job.payload as { userId: string; token: string };
      const { rows } = await db.query<{ email: string; full_name: string }>('SELECT email, full_name FROM users WHERE id = $1', [userId]);
      if (!rows[0] || !token) return 'skipped: user not found';
      const link = `${config.PUBLIC_SITE_URL.replace(/\/$/, '')}/reset-password.html?token=${encodeURIComponent(token)}`;
      return describe(await sendEmail(config, { to: rows[0].email, ...passwordResetEmail(config, rows[0].full_name, link) }, job.id));
    }
    case 'owner.daily_summary': {
      const { site } = await deps.settings.get();
      if (!site.alerts.dailySummary) return 'skipped: daily summary is turned off';
      if (!config.OWNER_EMAIL) return 'skipped: OWNER_EMAIL not set';
      const date = String(job.payload.date);
      const day = (await feedBookings(deps, date, date)).filter((b) => ACTIVE_STATUSES.includes(b.status));
      const lines = day.map((b) => ({
        period: `${b.periodLabel}${b.startTime ? ` ${timeLabel(b)}` : ''}`,
        customer: b.customerName,
        detail: `${b.serviceName} · ${b.vehicle}${b.status === 'pending' ? ' · awaiting confirmation' : ''}`,
      }));
      const { rows } = await db.query<{ pending: number; deposits: number }>(
        `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
                count(*) FILTER (WHERE deposit_status = 'requested' AND status IN ('pending', 'confirmed')) AS deposits
         FROM bookings WHERE slot_date >= $1`,
        [date],
      );
      const counts = { pending: Number(rows[0].pending), depositsOutstanding: Number(rows[0].deposits) };
      const email = ownerDailySummaryEmail(config, date, lines, counts, siteUrl(config, 'admin.html'));
      return describe(await sendEmail(config, { to: config.OWNER_EMAIL, ...email }, job.id));
    }
    case 'team.invite': {
      const { inviteId, token } = job.payload as { inviteId: string; token: string };
      const { rows } = await db.query<{ email: string; role: 'staff' | 'admin'; inviter: string | null; has_account: boolean }>(
        `SELECT i.email, i.role, u.full_name AS inviter, EXISTS (SELECT 1 FROM users a WHERE a.email = i.email) AS has_account
         FROM team_invites i LEFT JOIN users u ON u.id = i.invited_by
         WHERE i.id = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
        [inviteId],
      );
      const invite = rows[0];
      if (!invite || !token) return 'skipped: invite no longer open';
      const link = siteUrl(config, `account.html?invite=${encodeURIComponent(token)}`);
      const email = teamInviteEmail(config, invite.inviter ?? config.BUSINESS_NAME, invite.role, link, invite.has_account);
      return describe(await sendEmail(config, { to: invite.email, ...email }, job.id));
    }
    default:
      throw new PermanentProviderError(`unknown job kind ${String(job.kind)}`);
  }
}

/** Exponential backoff: 1, 2, 4, 8 … minutes, capped at 6 hours. */
export function backoffMs(attempt: number): number {
  return Math.min(6 * 3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Polls the jobs table. New bookings call wake() so notifications go out within milliseconds;
 * the poll interval only matters for scheduled jobs (reminders) and retries.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private stopped = false;
  private lastHousekeeping = 0;
  private lastSummaryCheck = 0;

  constructor(
    private readonly deps: Deps,
    private readonly log: Logger,
    private readonly idleMs = 5_000,
    private readonly batchSize = 10,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  wake(): void {
    if (this.stopped) return;
    if (this.running) this.wakeRequested = true;
    else this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = null;
      });
    }, ms);
  }

  /** Process every job that is due right now. Returns how many ran. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.processBatch();
      total += n;
      if (n === 0) return total;
    }
  }

  private async processBatch(): Promise<number> {
    const { rows } = await this.deps.db.query<ClaimedJob>(CLAIM_SQL, [this.batchSize]);
    await Promise.allSettled(rows.map((job) => this.run(job)));
    return rows.length;
  }

  private async tick(): Promise<void> {
    let processed = 0;
    try {
      processed = await this.processBatch();
      await this.scheduleDailySummary();
      await this.housekeeping();
    } catch (err) {
      this.log.error({ err }, 'job worker tick failed');
    }
    if (this.stopped) return;
    const again = processed > 0 || this.wakeRequested;
    this.wakeRequested = false;
    this.schedule(again ? 0 : this.idleMs);
  }

  private async run(job: ClaimedJob): Promise<void> {
    const db = this.deps.db;
    try {
      const note = await handleJob(this.deps, job);
      await db.query(`UPDATE jobs SET status = 'done', locked_until = NULL, last_error = $2, updated_at = now(), ${SCRUB} WHERE id = $1`, [job.id, note]);
      this.log.info({ jobId: job.id, kind: job.kind, note }, 'job done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentProviderError || job.attempts >= job.max_attempts;
      if (permanent) {
        await db.query(`UPDATE jobs SET status = 'failed', locked_until = NULL, last_error = $2, updated_at = now(), ${SCRUB} WHERE id = $1`, [job.id, message]);
        this.log.error({ jobId: job.id, kind: job.kind, err: message }, 'job failed permanently');
      } else {
        await db.query("UPDATE jobs SET status = 'pending', locked_until = NULL, run_at = $2, last_error = $3, updated_at = now() WHERE id = $1", [
          job.id,
          new Date(Date.now() + backoffMs(job.attempts)),
          message,
        ]);
        this.log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, err: message }, 'job failed, will retry');
      }
    }
  }

  /** Keep the next 8am summary queued while the owner has it turned on (checked every 10 minutes, de-duplicated by date). */
  private async scheduleDailySummary(): Promise<void> {
    if (Date.now() - this.lastSummaryCheck < 10 * 60_000) return;
    this.lastSummaryCheck = Date.now();
    const { config, db } = this.deps;
    const { site } = await this.deps.settings.get();
    if (!site.alerts.dailySummary || !config.OWNER_EMAIL) return;
    const { date, runAt } = nextDailySummary(config.TIMEZONE);
    await db.query(
      `INSERT INTO jobs (kind, payload, run_at, dedupe_key) VALUES ('owner.daily_summary', $1::JSONB, $2, $3)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [JSON.stringify({ date }), runAt, `daily-summary:${date}`],
    );
  }

  /** Hourly clean-up of finished jobs, expired sessions, used reset tokens, abandoned photo uploads and old invites. */
  private async housekeeping(): Promise<void> {
    if (Date.now() - this.lastHousekeeping < 3_600_000) return;
    this.lastHousekeeping = Date.now();
    const db = this.deps.db;
    await db.query("DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE status = 'done' AND updated_at < now() - INTERVAL '30 days' LIMIT 1000)");
    await db.query('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < now() LIMIT 1000)');
    await db.query(
      "DELETE FROM password_reset_tokens WHERE token_hash IN (SELECT token_hash FROM password_reset_tokens WHERE expires_at < now() - INTERVAL '1 day' LIMIT 1000)",
    );
    // Photos uploaded but never added to the slideshow, gallery or a before/after pair.
    await db.query(
      `DELETE FROM images WHERE id IN (
         SELECT i.id FROM images i
         WHERE i.created_at < now() - INTERVAL '1 day'
           AND NOT EXISTS (SELECT 1 FROM gallery_items g WHERE g.image_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM before_after p WHERE p.before_image_id = i.id OR p.after_image_id = i.id)
         LIMIT 200)`,
    );
    await db.query("DELETE FROM team_invites WHERE id IN (SELECT id FROM team_invites WHERE expires_at < now() - INTERVAL '30 days' LIMIT 500)");
  }
}
