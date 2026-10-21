// Stripe Checkout for the booking deposit.
// The customer never enters card details on our site: we create a hosted Checkout Session and send its URL
// in the "deposit requested" email/SMS. Stripe tells us the outcome through the webhook in routes/webhooks.ts.
import Stripe from 'stripe';
import type { Config } from '../config.js';
import type { BookingRecord } from '../domain/bookings.js';
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
 * Create a hosted Checkout Session for the deposit. Idempotent on the booking id + sequence so a retried
 * job never creates a second live session for the same request.
 */
export async function createDepositSession(config: Config, b: BookingRecord): Promise<DepositLink> {
  const stripe = stripeClient(config);
  const expiresAt = new Date(Date.now() + config.DEPOSIT_LINK_HOURS * 3_600_000);
  const ref = formatReference(b.reference);
  try {
    const session = await stripe.checkout.sessions.create(
      {
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
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        // Payment methods come from the Stripe Dashboard settings (cards + Apple/Google Pay by default).
        submit_type: 'pay',
        locale: 'en-GB',
      },
      { idempotencyKey: `deposit:${b.id}:${b.sequence}` },
    );
    if (!session.url) throw new PermanentProviderError('Stripe returned a Checkout Session without a URL');
    return { sessionId: session.id, url: session.url, expiresAt };
  } catch (err) {
    throw classify(err);
  }
}

/** Expire an unpaid session so a stale link in an old email stops working (e.g. after a cancellation). */
export async function expireDepositSession(config: Config, sessionId: string): Promise<void> {
  const stripe = stripeClient(config);
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'open') await stripe.checkout.sessions.expire(sessionId);
  } catch (err) {
    // Already expired/complete or gone: nothing to do.
    const e = classify(err);
    if (!(e instanceof PermanentProviderError)) throw e;
  }
}

/** Refund the deposit in full. Idempotent on the payment intent, so a retry can't refund twice. */
export async function refundDeposit(config: Config, paymentIntentId: string, bookingId: string): Promise<{ refundId: string; amountCents: number; status: string }> {
  const stripe = stripeClient(config);
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntentId, reason: 'requested_by_customer', metadata: { bookingId } },
      { idempotencyKey: `refund:${paymentIntentId}` },
    );
    return { refundId: refund.id, amountCents: refund.amount, status: refund.status ?? 'pending' };
  } catch (err) {
    const e = classify(err);
    // Stripe says "charge_already_refunded" when the owner refunded it in the dashboard first.
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'charge_already_refunded') {
      return { refundId: 'already-refunded', amountCents: 0, status: 'succeeded' };
    }
    throw e;
  }
}

/** Verify a webhook came from Stripe. Works on the raw request body (routes/webhooks.ts keeps it unparsed). */
export async function verifyWebhook(config: Config, rawBody: Buffer | string, signature: string | undefined): Promise<Stripe.Event> {
  if (!config.STRIPE_WEBHOOK_SECRET) throw new PermanentProviderError('STRIPE_WEBHOOK_SECRET missing');
  if (!signature) throw new Stripe.errors.StripeSignatureVerificationError('', rawBody, { message: 'Missing Stripe-Signature header' });
  return stripeClient(config).webhooks.constructEventAsync(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
}

/** 4xx from Stripe (bad key, bad params) won't fix itself; anything else (rate limit, network) is retried by the worker. */
function classify(err: unknown): Error {
  if (err instanceof Stripe.errors.StripeError) {
    const permanent =
      err instanceof Stripe.errors.StripeAuthenticationError ||
      err instanceof Stripe.errors.StripePermissionError ||
      err instanceof Stripe.errors.StripeInvalidRequestError ||
      err instanceof Stripe.errors.StripeCardError;
    const message = `Stripe ${err.type}${err.code ? ` (${err.code})` : ''}: ${err.message}`;
    return permanent ? new PermanentProviderError(message) : new Error(message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export type { Stripe };
