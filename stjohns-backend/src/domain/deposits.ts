// Deposit payments: creating the Checkout link, refunds, and applying what Stripe tells us through the webhook.
import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import { withTx, type Queryable } from '../db/pool.js';
import { enqueue, type JobInput } from '../jobs/queue.js';
import { isMobileNumber } from '../lib/phone.js';
import { isUuid } from '../lib/validate.js';
import {
  buildDepositRequest,
  canResend,
  createDepositSession,
  expireDepositSession,
  refundDeposit,
  refundStatusOf,
  retrieveRefund,
  type CheckoutRequest,
  type RefundResult,
  type RefundStatus,
  type Stripe,
} from '../payments/stripe.js';
import { ACTIVE_STATUSES, fetchBookingById, type BookingRecord, type DepositRefundStatus, type DepositStatus } from './bookings.js';

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
  // Save the exact request before calling Stripe. If Stripe creates the session but its reply or our save below
  // is lost, the retry sends the same key with the same parameters and gets that session back, not a second one.
  // Kept as text (not JSONB, which reorders keys) so the retry sends exactly what was sent before.
  const request = await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ deposit_checkout_request: string | null }>('SELECT deposit_checkout_request FROM bookings WHERE id = $1 FOR UPDATE', [b.id]);
    const raw = rows[0]?.deposit_checkout_request;
    const saved = raw ? (JSON.parse(raw) as CheckoutRequest) : null;
    if (canResend(saved)) return saved;
    const fresh = buildDepositRequest(deps.config, b);
    await c.query('UPDATE bookings SET deposit_checkout_request = $2 WHERE id = $1', [b.id, JSON.stringify(fresh)]);
    return fresh;
  });
  const link = await createDepositSession(deps.config, request);
  await withTx(deps.db, async (c) => {
    await c.query(
      `UPDATE bookings SET deposit_session_id = $2, deposit_pay_url = $3, deposit_link_expires_at = $4,
         deposit_checkout_request = CASE WHEN deposit_checkout_request::jsonb ->> 'idempotencyKey' = $5 THEN NULL ELSE deposit_checkout_request END,
         updated_at = now()
       WHERE id = $1`,
      [b.id, link.sessionId, link.url, link.expiresAt, request.idempotencyKey],
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

/** Kill a payment link. Fails (and leaves the link recorded) unless Stripe confirms nothing can be paid on it. */
export async function expireDepositLink(deps: Deps, bookingId: string, sessionId: string): Promise<string> {
  const outcome = await expireDepositSession(deps.config, sessionId);
  await deps.db.query('UPDATE bookings SET deposit_pay_url = NULL, deposit_link_expires_at = now() WHERE id = $1 AND deposit_session_id = $2', [bookingId, sessionId]);
  return `${outcome} ${sessionId}`;
}

/** Refund ids we make up for refunds Stripe gave us no id for (a dashboard refund, or one that already happened). */
const isPlaceholder = (refundId: string) => refundId.startsWith('dashboard:') || refundId.startsWith('already-refunded:');
const MAX_REFUND_CHECKS = 40; // a check after 30 minutes, then every 6 hours: about ten days
const stillPending = (status: DepositRefundStatus | null) => status === 'pending' || status === 'requires_action';

/**
 * Refund the deposit (after a cancellation, or when the owner asks), or check on a refund Stripe still has
 * pending. The deposit only counts as refunded, and the customer is only told, once Stripe says it succeeded.
 */
export async function refundDepositForBooking(deps: Deps, bookingId: string, check = 0): Promise<string> {
  const b = await fetchBookingById(deps.db, bookingId);
  if (!b) return 'skipped: booking not found';
  const intent = b.depositPaymentIntentId;
  if (!intent) return 'skipped: no payment to refund';
  if (b.depositRefundStatus === 'succeeded') return `skipped: already refunded (${b.depositRefundId})`;

  let refund: RefundResult;
  if (stillPending(b.depositRefundStatus) && b.depositRefundId && !isPlaceholder(b.depositRefundId)) {
    // A refund is under way: ask Stripe how it's going, in case its webhook is late or not set up.
    refund = await retrieveRefund(deps.config, b.depositRefundId);
  } else {
    // Every retry of one refund attempt reuses its idempotency key, so the refund can't be made twice; each new
    // attempt after a failed one (counted by its failure events) gets a new key.
    const failures = await deps.db.query<{ n: number }>("SELECT count(*)::int AS n FROM booking_events WHERE booking_id = $1 AND type = 'deposit_refund_failed'", [b.id]);
    const key = failures.rows[0].n ? `refund:${intent}:retry:${failures.rows[0].n}` : `refund:${intent}`;
    // Note that we're refunding before asking Stripe, so this refund's charge.refunded event isn't mistaken for
    // one made in the Stripe dashboard.
    await deps.db.query("UPDATE bookings SET deposit_refund_status = 'requested', updated_at = now() WHERE id = $1 AND deposit_refund_status IS DISTINCT FROM 'succeeded'", [b.id]);
    // If Stripe refuses, or keeps failing until the worker gives up, the worker calls refundGaveUp.
    refund = await refundDeposit(deps.config, intent, b.id, key);
  }
  const outcome = await withTx(deps.db, (c) => recordRefund(c, deps.config, b.id, refund, true, 'system'));
  if (stillPending(refund.status) && check < MAX_REFUND_CHECKS) {
    const runAt = new Date(Date.now() + (check === 0 ? 30 : 360) * 60_000);
    await enqueue(deps.db, [{ kind: 'deposit.refund', payload: { bookingId: b.id, check: check + 1 }, runAt }]);
  }
  deps.wakeWorker();
  return `${outcome} ${refund.refundId}`;
}

// ---------- Refund state (pure, so the rules are unit-tested) ----------

/** Where all the refunds of one deposit stand together: a success wins, then one still in progress, else failed. */
export function overallRefundStatus(statuses: RefundStatus[]): RefundStatus | null {
  if (statuses.length === 0) return null;
  if (statuses.includes('succeeded')) return 'succeeded';
  if (statuses.includes('requires_action')) return 'requires_action';
  if (statuses.includes('pending')) return 'pending';
  return statuses.includes('failed') ? 'failed' : 'canceled';
}

export type RefundOutcome = 'refunded' | 'refund_pending' | 'refund_failed' | 'duplicate';

export interface RefundChange {
  depositStatus: DepositStatus;
  refundStatus: DepositRefundStatus;
  event: 'deposit_refunded' | 'deposit_refund_pending' | 'deposit_refund_failed' | null;
  notifyCustomer: boolean;
  notifyOwner: boolean;
  outcome: RefundOutcome;
}

const failure = (s: DepositRefundStatus | null) => s === 'failed' || s === 'canceled';

/**
 * What the refunds' overall status means for the booking. The deposit is refunded only once a refund succeeded;
 * the customer hears about it then, but only for refunds we started (a dashboard refund is the owner's own doing).
 * A refund that fails, even after succeeding (Stripe allows that), puts the deposit back to paid and alerts the owner.
 */
export function decideRefund(before: { depositStatus: DepositStatus; refundStatus: DepositRefundStatus | null }, overall: RefundStatus, ours: boolean): RefundChange {
  const unchanged = { depositStatus: before.depositStatus, event: null, notifyCustomer: false, notifyOwner: false, outcome: 'duplicate' as const };
  if (overall === before.refundStatus || (failure(overall) && failure(before.refundStatus))) return { ...unchanged, refundStatus: overall };
  // A dashboard refund mirrored from charge.refunded can be followed by its own refund.created (still pending).
  if (before.refundStatus === 'succeeded' && stillPending(overall)) return { ...unchanged, refundStatus: 'succeeded' };
  if (overall === 'succeeded') {
    return { depositStatus: 'refunded', refundStatus: overall, event: 'deposit_refunded', notifyCustomer: ours, notifyOwner: false, outcome: 'refunded' };
  }
  if (stillPending(overall)) {
    return { ...unchanged, refundStatus: overall, event: stillPending(before.refundStatus) ? null : 'deposit_refund_pending', outcome: 'refund_pending' };
  }
  return {
    depositStatus: before.depositStatus === 'refunded' ? 'paid' : before.depositStatus,
    refundStatus: overall,
    event: 'deposit_refund_failed',
    notifyCustomer: false,
    notifyOwner: true,
    outcome: 'refund_failed',
  };
}

/**
 * Apply one refund's latest status to its booking, inside the caller's transaction. Every refund is kept in
 * payments (by Stripe id), and the booking follows all of them together, so events arriving late, twice or out
 * of order (an old failed refund after a newer one) settle on the same answer.
 */
async function recordRefund(c: Queryable, config: Config, bookingId: string, refund: RefundResult, ours: boolean, actor: 'system' | 'stripe'): Promise<RefundOutcome | 'unknown-booking'> {
  const { rows } = await c.query<{ id: string; deposit_status: DepositStatus; deposit_refund_status: DepositRefundStatus | null; customer_email: string | null; customer_phone: string }>(
    'SELECT id, deposit_status, deposit_refund_status, customer_email, customer_phone FROM bookings WHERE id = $1 FOR UPDATE',
    [bookingId],
  );
  const b = rows[0];
  if (!b) return 'unknown-booking';
  await c.query(
    `INSERT INTO payments (booking_id, kind, amount_cents, currency, stripe_id, status) VALUES ($1, 'refund', $2, 'eur', $3, $4)
     ON CONFLICT (stripe_id) DO UPDATE SET status = excluded.status`,
    [b.id, refund.amountCents, refund.refundId, refund.status],
  );
  const all = await c.query<{ status: string }>("SELECT status FROM payments WHERE booking_id = $1 AND kind = 'refund'", [b.id]);
  const overall = overallRefundStatus(all.rows.map((r) => refundStatusOf(r.status)))!;
  const change = decideRefund({ depositStatus: b.deposit_status, refundStatus: b.deposit_refund_status }, overall, ours);
  await c.query(
    `UPDATE bookings SET deposit_status = $2, deposit_refund_status = $3,
       deposit_refund_id = CASE WHEN $4 THEN $5 ELSE deposit_refund_id END,
       deposit_pay_url = CASE WHEN $2 = 'refunded' THEN NULL ELSE deposit_pay_url END,
       sequence = sequence + $6, updated_at = now()
     WHERE id = $1`,
    // The booking points at the refund that decided its status (not an older one reporting late).
    [b.id, change.depositStatus, change.refundStatus, refund.status === overall, refund.refundId, change.depositStatus === b.deposit_status ? 0 : 1],
  );
  if (change.event) await c.query('INSERT INTO booking_events (booking_id, type, actor) VALUES ($1, $2, $3)', [b.id, change.event, actor]);
  const jobs: JobInput[] = [];
  if (change.notifyCustomer) {
    if (b.customer_email) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_email', template: 'deposit_refunded' } });
    if (isMobileNumber(b.customer_phone)) jobs.push({ kind: 'notify', payload: { bookingId: b.id, channel: 'customer_sms', template: 'deposit_refunded' } });
  }
  if (change.notifyOwner) jobs.push(...ownerRefundAlerts(config, b.id));
  await enqueue(c, jobs);
  return change.outcome;
}

function ownerRefundAlerts(config: Config, bookingId: string): JobInput[] {
  const jobs: JobInput[] = [];
  if (config.OWNER_EMAIL) jobs.push({ kind: 'notify', payload: { bookingId, channel: 'owner_email', template: 'deposit_refund_failed' } });
  if (config.OWNER_PHONE) jobs.push({ kind: 'notify', payload: { bookingId, channel: 'owner_sms', template: 'deposit_refund_failed' } });
  return jobs;
}

/**
 * The refund job failed for good: Stripe refused (e.g. the payment is disputed) or kept failing until the worker
 * gave up. A refund still only "requested" is recorded as failed (the deposit stays paid) and the owner is alerted,
 * so the booking never sticks on "requested" and can be refunded again. One Stripe already has under way is left.
 */
export async function refundGaveUp(deps: Deps, bookingId: string, reason: string): Promise<void> {
  await withTx(deps.db, async (c) => {
    const res = await c.query(
      "UPDATE bookings SET deposit_refund_status = 'failed', updated_at = now() WHERE id = $1 AND deposit_refund_status = 'requested'",
      [bookingId],
    );
    if (!res.rowCount) return;
    await c.query("INSERT INTO booking_events (booking_id, type, actor, note) VALUES ($1, 'deposit_refund_failed', 'system', $2)", [bookingId, reason.slice(0, 500)]);
    await enqueue(c, ownerRefundAlerts(deps.config, bookingId));
  });
}

// ---------- Webhook ----------

export type WebhookOutcome = 'paid' | 'expired' | 'failed' | RefundOutcome | 'ignored' | 'unknown-booking';

const REFUND_EVENTS: ReadonlySet<string> = new Set(['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated']);

/**
 * Apply one Stripe event. Safe to call for any event type and for redelivered events: the event id is
 * recorded in stripe_events in the same transaction as its effects, so a second delivery is a no-op and
 * a failed attempt rolls back completely (Stripe's retry is then processed, not skipped as a duplicate).
 */
export async function applyStripeEvent(deps: Deps, event: Stripe.Event): Promise<WebhookOutcome> {
  const outcome = await withTx<WebhookOutcome>(deps.db, async (c) => {
    const bookingId = bookingIdOf(event) ?? (await bookingForRefund(c, event));
    const seen = await c.query('INSERT INTO stripe_events (id, type, booking_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id', [
      event.id,
      event.type,
      bookingId,
    ]);
    if (!seen.rowCount) return 'duplicate';
    if (!bookingId) return 'ignored';
    return applyToBooking(c, deps, event, bookingId);
  });
  if (outcome === 'paid' || outcome === 'refunded' || outcome === 'refund_failed') deps.wakeWorker();
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
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated': {
      const refund = event.data.object;
      const intent = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id ?? null;
      // Only refunds of this booking's deposit payment.
      const owns = await c.query('SELECT 1 FROM bookings WHERE id = $1 AND deposit_payment_intent_id = $2', [bookingId, intent]);
      if (!intent || !owns.rowCount) return 'ignored';
      const ours = Boolean(refund.metadata?.bookingId);
      if (!ours) {
        // A partial refund made in the Stripe dashboard (ours are always in full) doesn't make the deposit refunded.
        const paid = await c.query<{ amount_cents: number }>("SELECT amount_cents FROM payments WHERE booking_id = $1 AND kind = 'deposit' AND stripe_id = $2", [bookingId, intent]);
        if (refund.amount < (paid.rows[0]?.amount_cents ?? Math.round(config.DEPOSIT_AMOUNT_EUR * 100))) return 'ignored';
      }
      return recordRefund(c, config, bookingId, { refundId: refund.id, amountCents: refund.amount, status: refundStatusOf(refund.status) }, ours, 'stripe');
    }
    case 'charge.refunded': {
      // A refund made in the Stripe dashboard, when its refund.* events aren't sent. Refunds we start (and
      // dashboard refunds whose refund.* events arrive) are tracked by refund status instead, so this only
      // fills in when nothing is tracked yet.
      const charge = event.data.object;
      const intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null;
      if (!intent || !charge.refunded) return 'ignored';
      const res = await c.query(
        `UPDATE bookings SET deposit_status = 'refunded', deposit_refund_id = COALESCE(deposit_refund_id, $3), deposit_refund_status = 'succeeded',
           deposit_pay_url = NULL, sequence = sequence + 1, updated_at = now()
         WHERE id = $1 AND deposit_payment_intent_id = $2 AND deposit_status = 'paid' AND deposit_refund_status IS NULL`,
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
  return id && isUuid(id) ? id : null;
}

/** A refund made in the Stripe dashboard carries none of our metadata: find its booking by the payment instead. */
async function bookingForRefund(c: Queryable, event: Stripe.Event): Promise<string | null> {
  if (!REFUND_EVENTS.has(event.type)) return null;
  const refund = event.data.object as Stripe.Refund;
  const intent = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
  if (!intent) return null;
  const { rows } = await c.query<{ id: string }>('SELECT id FROM bookings WHERE deposit_payment_intent_id = $1', [intent]);
  return rows[0]?.id ?? null;
}

export type { BookingRecord };
