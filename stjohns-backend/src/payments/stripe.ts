// Stripe Checkout for the booking deposit.
// The customer never enters card details on our site: we create a hosted Checkout Session and send its URL
// in the "deposit requested" email/SMS. Stripe tells us the outcome through the webhook in routes/webhooks.ts.
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { Config } from '../config.js';
import type { BookingRecord, DepositRefundStatus } from '../domain/bookings.js';
import { PermanentProviderError } from '../lib/errors.js';
import { formatReference } from '../lib/reference.js';
import { longDate } from '../lib/time.js';

let client: Stripe | null = null;

export function stripeClient(config: Config): Stripe {
  if (!config.STRIPE_SECRET_KEY) throw new PermanentProviderError('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  client ??= new Stripe(config.STRIPE_SECRET_KEY, {
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: 'stjohns-booking-api', version: '1.0.0' },
  });
  return client;
}

/** Test seam: swap the client (used by the unit tests). */
export function setStripeClientForTests(c: Stripe | null): void {
  client = c;
}

export function depositAmountCents(config: Config): number {
  return Math.round(config.DEPOSIT_AMOUNT_EUR * 100);
}

export interface DepositLink {
  sessionId: string;
  url: string;
  expiresAt: Date;
}

/** Where Stripe sends the customer afterwards: back to their tracking page with a flag the page understands. */
function returnUrl(config: Config, b: BookingRecord, outcome: 'paid' | 'cancelled'): string {
  const base = config.PUBLIC_SITE_URL.replace(/\/$/, '');
  return `${base}/track.html?ref=${encodeURIComponent(formatReference(b.reference))}&deposit=${outcome}`;
}

/**
 * A Checkout request as saved on the booking (deposit_checkout_request) before it is sent. A retried job sends
 * exactly this again: Stripe requires the same parameters with the same idempotency key, and answers with the
 * session it already created if an earlier attempt's reply (or our save afterwards) was lost.
 */
export interface CheckoutRequest {
  idempotencyKey: string;
  params: Stripe.Checkout.SessionCreateParams;
}

/** Stripe only accepts a session expiry at least 30 minutes ahead; keep a margin for a slow retry. */
const MIN_REMAINING_MS = 35 * 60_000;

/** A new deposit request: a fresh idempotency key, and every parameter fixed now, including the link's expiry. */
export function buildDepositRequest(config: Config, b: BookingRecord, now = Date.now()): CheckoutRequest {
  const ref = formatReference(b.reference);
  return {
    idempotencyKey: `deposit:${b.id}:${randomUUID()}`,
    params: {
      mode: 'payment',
      currency: 'eur',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: depositAmountCents(config),
            product_data: {
              name: `Booking deposit — ${b.serviceName}`,
              description: `${ref} · ${longDate(b.slotDate)} · ${b.periodLabel}. Deducted from the price on the day.`,
            },
          },
        },
      ],
      ...(b.customerEmail ? { customer_email: b.customerEmail } : {}),
      client_reference_id: b.id,
      metadata: { bookingId: b.id, reference: ref },
      payment_intent_data: {
        description: `${config.BUSINESS_NAME} deposit ${ref}`,
        metadata: { bookingId: b.id, reference: ref },
        // The owner's bank statement line for the customer; Stripe truncates to 22 chars.
        statement_descriptor_suffix: 'DEPOSIT',
      },
      success_url: returnUrl(config, b, 'paid'),
      cancel_url: returnUrl(config, b, 'cancelled'),
      expires_at: Math.floor((now + config.DEPOSIT_LINK_HOURS * 3_600_000) / 1000),
      // Payment methods come from the Stripe Dashboard settings (cards + Apple/Google Pay by default).
      submit_type: 'pay',
      locale: 'en-GB',
    },
  };
}

/**
 * Whether a saved request can still be sent unchanged: its expiry must be far enough ahead for Stripe to accept.
 * Links last at most 24 hours, so this also keeps us inside the 24 hours Stripe honours an idempotency key.
 */
export function canResend(request: CheckoutRequest | null | undefined, now = Date.now()): request is CheckoutRequest {
  const expiresAt = request?.params.expires_at;
  return typeof expiresAt === 'number' && expiresAt * 1000 - now > MIN_REMAINING_MS;
}

/** Create the hosted Checkout Session from a saved request (safe to repeat; see CheckoutRequest). */
export async function createDepositSession(config: Config, request: CheckoutRequest): Promise<DepositLink> {
  const stripe = stripeClient(config);
  try {
    const session = await stripe.checkout.sessions.create(request.params, { idempotencyKey: request.idempotencyKey });
    if (!session.url) throw new PermanentProviderError('Stripe returned a Checkout Session without a URL');
    // Stripe's own expiry, not one worked out here: they differ when this is a replay of an earlier attempt.
    return { sessionId: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
  } catch (err) {
    throw classify(err);
  }
}

export type ExpireOutcome = 'expired' | 'already-expired' | 'completed' | 'not-found';

/**
 * Expire an unpaid session so a stale link in an old email stops working (e.g. after a cancellation).
 * Only outcomes that leave nothing to expire count as done: Stripe expired it, it had already expired or been
 * paid, or it doesn't exist. Anything else (a bad API key, missing permission, an unexpected error) is thrown,
 * so the job fails visibly instead of the link being treated as dead while it can still take payments.
 */
export async function expireDepositSession(config: Config, sessionId: string): Promise<ExpireOutcome> {
  const stripe = stripeClient(config);
  const closed = (s: Stripe.Checkout.Session): ExpireOutcome | null =>
    s.status === 'complete' ? 'completed' : s.status === 'expired' ? 'already-expired' : null;
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (isMissing(err)) return 'not-found';
    throw classify(err);
  }
  const done = closed(session);
  if (done) return done;
  try {
    await stripe.checkout.sessions.expire(sessionId);
    return 'expired';
  } catch (err) {
    // Stripe won't expire a session that closed a moment ago (paid or timed out), so look again before failing.
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw classify(err);
    let again: Stripe.Checkout.Session;
    try {
      again = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (retryErr) {
      throw classify(retryErr);
    }
    const nowDone = closed(again);
    if (nowDone) return nowDone;
    throw classify(err);
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing';
}

/** Stripe's refund statuses (ours adds 'requested', before Stripe has answered). */
export type RefundStatus = Exclude<DepositRefundStatus, 'requested'>;
const REFUND_STATUSES: readonly RefundStatus[] = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'];

/** A refund's status as Stripe reports it; anything unknown (or missing) counts as still pending. */
export function refundStatusOf(status: string | null | undefined): RefundStatus {
  return REFUND_STATUSES.includes(status as RefundStatus) ? (status as RefundStatus) : 'pending';
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
  status: RefundStatus;
}

/**
 * Refund the deposit in full. The caller chooses the idempotency key: the same one for every retry of a refund
 * (so a retry can't refund twice), and a new one only for another attempt after a refund failed.
 */
export async function refundDeposit(config: Config, paymentIntentId: string, bookingId: string, idempotencyKey: string): Promise<RefundResult> {
  const stripe = stripeClient(config);
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntentId, reason: 'requested_by_customer', metadata: { bookingId } },
      { idempotencyKey },
    );
    return { refundId: refund.id, amountCents: refund.amount, status: refundStatusOf(refund.status) };
  } catch (err) {
    // Stripe says "charge_already_refunded" when the owner refunded it in the dashboard first.
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'charge_already_refunded') {
      return { refundId: `already-refunded:${paymentIntentId}`, amountCents: 0, status: 'succeeded' };
    }
    throw classify(err);
  }
}

/** How a refund stands now, for checking on one Stripe still had pending. */
export async function retrieveRefund(config: Config, refundId: string): Promise<RefundResult> {
  const stripe = stripeClient(config);
  try {
    const refund = await stripe.refunds.retrieve(refundId);
    return { refundId: refund.id, amountCents: refund.amount, status: refundStatusOf(refund.status) };
  } catch (err) {
    throw classify(err);
  }
}

/** Verify a webhook came from Stripe. Works on the raw request body (routes/webhooks.ts keeps it unparsed). */
export async function verifyWebhook(config: Config, rawBody: Buffer | string, signature: string | undefined): Promise<Stripe.Event> {
  if (!config.STRIPE_WEBHOOK_SECRET) throw new PermanentProviderError('STRIPE_WEBHOOK_SECRET missing');
  if (!signature) throw new Stripe.errors.StripeSignatureVerificationError('', rawBody, { message: 'Missing Stripe-Signature header' });
  return stripeClient(config).webhooks.constructEventAsync(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
}

/**
 * 4xx from Stripe (bad key, bad params, a reused idempotency key with different parameters) won't fix itself;
 * anything else (rate limit, network) is retried by the worker.
 */
function classify(err: unknown): Error {
  if (err instanceof Stripe.errors.StripeError) {
    const permanent =
      err instanceof Stripe.errors.StripeAuthenticationError ||
      err instanceof Stripe.errors.StripePermissionError ||
      err instanceof Stripe.errors.StripeInvalidRequestError ||
      err instanceof Stripe.errors.StripeIdempotencyError ||
      err instanceof Stripe.errors.StripeCardError;
    const message = `Stripe ${err.type}${err.code ? ` (${err.code})` : ''}: ${err.message}`;
    return permanent ? new PermanentProviderError(message) : new Error(message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export type { Stripe };
