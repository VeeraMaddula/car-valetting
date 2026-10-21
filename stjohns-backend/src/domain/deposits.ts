// Deposit payments: creating the Checkout link, and applying what Stripe tells us through the webhook.
import type { Deps } from '../deps.js';
import { withTx, type Queryable } from '../db/pool.js';
import { enqueue, type JobInput } from '../jobs/queue.js';
import { isMobileNumber } from '../lib/phone.js';
import { createDepositSession, expireDepositSession, refundDeposit, type Stripe } from '../payments/stripe.js';
import { ACTIVE_STATUSES, fetchBookingById, type BookingRecord } from './bookings.js';

// ---------- Worker jobs ----------

/** Create the Checkout link, store it, then queue the "pay your deposit" email/SMS that carry it. */
export async function createDepositLink(deps: Deps, bookingId: string): Promise<string> {
  const b = await fetchBookingById(deps.db, bookingId);
  if (!b) return 'skipped: booking not found';
  if (!ACTIVE_STATUSES.includes(b.status)) return `skipped: booking is ${b.status}`;
  if (b.depositStatus !== 'requested') return `skipped: deposit is ${b.depositStatus}`;
  if (b.depositPayUrl && b.depositLinkExpiresAt && b.depositLinkExpiresAt.getTime() > Date.now() + 60_000) {
    return `skipped: live link already exists (${b.depositSessionId})`;
  }
  const link = await createDepositSession(deps.config, b);
  await withTx(deps.db, async (c) => {
    await c.query(
      `UPDATE bookings SET deposit_session_id = $2, deposit_pay_url = $3, deposit_link_expires_at = $4, updated_at = now() WHERE id = $1`,
      [b.id, link.sessionId, link.url, link.expiresAt],
    );
    await c.query("INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, 'deposit_link_sent', 'system')", [b.id]);
    const jobs: JobInput[] = [];
    if (b.customerEmail) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_email', template: 'deposit_requested' } });
    if (isMobileNumber(b.customerPhone)) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_sms', template: 'deposit_requested' } });
    await enqueue(c, jobs);
  });
  deps.wakeWorker();
  return `link ${link.sessionId}`;
}

export async function expireDepositLink(deps: Deps, bookingId: string, sessionId: string): Promise<string> {
  await expireDepositSession(deps.config, sessionId);
  await deps.db.query('UPDATE bookings SET deposit_pay_url = NULL, deposit_link_expires_at = now() WHERE id = $1 AND deposit_session_id = $2', [bookingId, sessionId]);
  return `expired ${sessionId}`;
}

/** Refund the deposit after a cancellation (or when the owner marks it refunded). */
export async function refundDepositForBooking(deps: Deps, bookingId: string): Promise<string> {
  const b = await fetchBookingById(deps.db, bookingId);
  if (!b) return 'skipped: booking not found';
  if (!b.depositPaymentIntentId) return 'skipped: no payment to refund';
  if (b.depositRefundId) return `skipped: already refunded (${b.depositRefundId})`;
  const refund = await refundDeposit(deps.config, b.depositPaymentIntentId, b.id);
  await withTx(deps.db, async (c) => {
    await c.query(
      `UPDATE bookings SET deposit_status = 'refunded', deposit_refund_id = $2, deposit_pay_url = NULL, sequence = sequence + 1, updated_at = now() WHERE id = $1`,
      [b.id, refund.refundId],
    );
    if (refund.amountCents > 0) {
      await c.query(
        `INSERT INTO payments (booking_id, kind, amount_cents, currency, stripe_id, status) VALUES ($1, 'refund', $2, 'eur', $3, $4)
         ON CONFLICT (stripe_id) DO UPDATE SET status = excluded.status`,
        [b.id, refund.amountCents, refund.refundId, refund.status],
      );
    }
    if (b.depositStatus !== 'refunded') {
      await c.query("INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, 'deposit_refunded', 'system')", [b.id]);
    }
    const jobs: JobInput[] = [];
    if (b.customerEmail) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_email', template: 'deposit_refunded' } });
    if (isMobileNumber(b.customerPhone)) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_sms', template: 'deposit_refunded' } });
    await enqueue(c, jobs);
  });
  deps.wakeWorker();
  return `refund ${refund.refundId}`;
}

// ---------- Webhook ----------

export type WebhookOutcome = 'paid' | 'expired' | 'failed' | 'refunded' | 'duplicate' | 'ignored' | 'unknown-booking';

/**
 * Apply one Stripe event. Safe to call for any event type and for redelivered events: the event id is
 * recorded in stripe_events in the same transaction as its effects, so a second delivery is a no-op and
 * a failed attempt rolls back completely (Stripe's retry is then processed, not skipped as a duplicate).
 */
export async function applyStripeEvent(deps: Deps, event: Stripe.Event): Promise<WebhookOutcome> {
  const bookingId = bookingIdOf(event);
  const outcome = await withTx<WebhookOutcome>(deps.db, async (c) => {
    const seen = await c.query('INSERT INTO stripe_events (id, type, booking_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id', [
      event.id,
      event.type,
      bookingId,
    ]);
    if (!seen.rowCount) return 'duplicate';
    if (!bookingId) return 'ignored';
    return applyToBooking(c, deps, event, bookingId);
  });
  if (outcome === 'paid') deps.wakeWorker();
  return outcome;
}

async function applyToBooking(c: Queryable, { config }: Deps, event: Stripe.Event, bookingId: string): Promise<WebhookOutcome> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      if (session.payment_status !== 'paid') return 'ignored';
      const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
      const amount = session.amount_total ?? 0;
      const { rows } = await c.query<{ id: string; deposit_status: string; customer_email: string | null; customer_phone: string }>(
        'SELECT id, deposit_status, customer_email, customer_phone FROM bookings WHERE id = $1 FOR UPDATE',
        [bookingId],
      );
      const b = rows[0];
      if (!b) return 'unknown-booking';
      await c.query(
        `INSERT INTO payments (booking_id, kind, amount_cents, currency, stripe_id, status) VALUES ($1, 'deposit', $2, $3, $4, 'succeeded')
         ON CONFLICT (stripe_id) DO NOTHING`,
        [b.id, amount, session.currency ?? 'eur', intent ?? session.id],
      );
      if (b.deposit_status === 'paid') return 'duplicate';
      await c.query(
        `UPDATE bookings SET deposit_status = 'paid', deposit_payment_intent_id = $2, deposit_paid_at = now(), deposit_pay_url = NULL,
           sequence = sequence + 1, updated_at = now() WHERE id = $1`,
        [b.id, intent],
      );
      await c.query("INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, 'deposit_paid', 'customer')", [b.id]);
      const jobs: JobInput[] = [];
      if (b.customer_email) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_email', template: 'deposit_paid' } });
      if (isMobileNumber(b.customer_phone)) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_sms', template: 'deposit_paid' } });
      if (config.OWNER_EMAIL) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'owner_email', template: 'deposit_paid' } });
      if (config.OWNER_PHONE) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'owner_sms', template: 'deposit_paid' } });
      await enqueue(c, jobs);
      return 'paid';
    }
    case 'checkout.session.expired': {
      const session = event.data.object;
      await c.query(
        `UPDATE bookings SET deposit_pay_url = NULL, deposit_link_expires_at = now(), updated_at = now()
         WHERE id = $1 AND deposit_session_id = $2 AND deposit_status = 'requested'`,
        [bookingId, session.id],
      );
      return 'expired';
    }
    case 'checkout.session.async_payment_failed': {
      await c.query("INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, 'deposit_failed', 'system')", [bookingId]);
      return 'failed';
    }
    case 'charge.refunded': {
      // Owner refunded from the Stripe dashboard: mirror it.
      const charge = event.data.object;
      const intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null;
      if (!intent || !charge.refunded) return 'ignored';
      const res = await c.query(
        `UPDATE bookings SET deposit_status = 'refunded', deposit_refund_id = COALESCE(deposit_refund_id, $3), deposit_pay_url = NULL,
           sequence = sequence + 1, updated_at = now()
         WHERE id = $1 AND deposit_payment_intent_id = $2 AND deposit_status = 'paid'`,
        [bookingId, intent, `dashboard:${charge.id}`],
      );
      if (res.rowCount) await c.query("INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, 'deposit_refunded', 'stripe')", [bookingId]);
      return res.rowCount ? 'refunded' : 'duplicate';
    }
    default:
      return 'ignored';
  }
}

function bookingIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string> | null; client_reference_id?: string | null };
  const id = obj.metadata?.bookingId ?? obj.client_reference_id ?? null;
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export type { BookingRecord };
