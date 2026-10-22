import Stripe from 'stripe';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { depositPayUrl, type BookingRecord } from '../src/domain/bookings.js';
import { decideRefund, overallRefundStatus } from '../src/domain/deposits.js';
import { PermanentProviderError } from '../src/lib/errors.js';
import { customerEmail, customerSms, ownerEmail, ownerSms } from '../src/notifications/templates.js';
import {
  buildDepositRequest,
  canResend,
  createDepositSession,
  depositAmountCents,
  expireDepositSession,
  refundDeposit,
  refundStatusOf,
  setStripeClientForTests,
  verifyWebhook,
} from '../src/payments/stripe.js';

const base = {
  DATABASE_URL: 'postgresql://unused',
  PUBLIC_SITE_URL: 'https://www.example.ie',
  PUBLIC_API_URL: 'https://api.example.ie',
};
const WHSEC = 'whsec_test_secret_0123456789';

function booking(over: Partial<BookingRecord> = {}): BookingRecord {
  return {
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
    status: 'confirmed',
    customerName: 'Mary Smith',
    customerPhone: '+353894709672',
    customerEmail: 'mary@example.com',
    vehicle: 'VW Golf',
    handover: 'drop_off',
    collectionAddress: null,
    notes: null,
    depositStatus: 'requested',
    depositSessionId: 'cs_test_1',
    depositPayUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    depositLinkExpiresAt: new Date(Date.now() + 3_600_000),
    depositPaymentIntentId: null,
    depositPaidAt: null,
    depositRefundId: null,
    depositRefundStatus: null,
    servicePriceFrom: true,
    vehicleSize: null,
    priceCents: 13000,
    addons: [],
    addonsCents: 0,
    discountId: null,
    discountCode: null,
    discountCents: 0,
    totalCents: 13000,
    finalPriceCents: null,
    calendarToken: 'tok',
    sequence: 0,
    googleEventId: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('Stripe configuration', () => {
  it('is off unless both keys are present', () => {
    expect(loadConfig(base).stripeEnabled).toBe(false);
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC }).stripeEnabled).toBe(true);
  });

  it('refuses a test key in production and a malformed key anywhere', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.com/stjohns?sslmode=verify-full', STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC })).toThrow(/test key/);
    const staging = { ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.com/stjohns?sslmode=verify-full', STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_ALLOW_TEST_KEY: 'true' };
    expect(loadConfig(staging).stripeEnabled).toBe(true);
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'pk_live_abc', STRIPE_WEBHOOK_SECRET: WHSEC })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'nope' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('is off when the deposit is zero', () => {
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC, DEPOSIT_AMOUNT_EUR: '0' }).stripeEnabled).toBe(false);
    expect(depositAmountCents(loadConfig({ ...base, DEPOSIT_AMOUNT_EUR: '30' }))).toBe(3000);
    expect(depositAmountCents(loadConfig({ ...base, DEPOSIT_AMOUNT_EUR: '12.5' }))).toBe(1250);
  });
});

describe('deposit pay link visibility', () => {
  it('shows the link only while requested, active and unexpired', () => {
    expect(depositPayUrl(booking())).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(depositPayUrl(booking({ depositStatus: 'paid' }))).toBeNull();
    expect(depositPayUrl(booking({ status: 'cancelled' }))).toBeNull();
    expect(depositPayUrl(booking({ status: 'completed' }))).toBeNull();
    expect(depositPayUrl(booking({ depositLinkExpiresAt: new Date(Date.now() - 1000) }))).toBeNull();
    expect(depositPayUrl(booking({ depositPayUrl: null }))).toBeNull();
  });
});

describe('deposit messages', () => {
  const config = loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC });

  it('carry the Checkout link when there is one, and the manual instructions when not', () => {
    const withLink = customerEmail('deposit_requested', booking(), config)!;
    expect(withLink.html).toContain('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(withLink.html).toContain('Pay €30 deposit');
    expect(withLink.text).toContain('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(customerSms('deposit_requested', booking(), config)).toContain('https://checkout.stripe.com/c/pay/cs_test_1');

    const manual = customerEmail('deposit_requested', booking({ depositPayUrl: null }), config)!;
    expect(manual.html).not.toContain('checkout.stripe.com');
    expect(manual.html).toContain('We will send you a secure link');
    expect(customerSms('deposit_requested', booking({ depositPayUrl: null }), config)).toContain('We will send you a secure link');
  });

  it('confirm payment and refund to the customer and tell the owner', () => {
    expect(customerEmail('deposit_paid', booking({ depositStatus: 'paid' }), config)!.subject).toMatch(/Deposit received/);
    expect(customerSms('deposit_paid', booking(), config)).toContain('€30 deposit received');
    expect(customerEmail('deposit_refunded', booking({ depositStatus: 'refunded' }), config)!.html).toContain('5–10 working days');
    expect(customerSms('deposit_refunded', booking(), config)).toContain('refunded');
    expect(ownerEmail('deposit_paid', booking(), config)!.subject).toContain('Deposit paid');
    expect(ownerSms('deposit_paid', booking())).toContain('Deposit paid: SJP-K7Q4-9XZ2');
    expect(ownerEmail('deposit_refunded', booking(), config)).toBeNull();
  });
});

describe('webhook signature verification', () => {
  const config = loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC });
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_1', object: 'checkout.session' } } });

  it('accepts a correctly signed payload and rejects a tampered or unsigned one', async () => {
    setStripeClientForTests(null);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const event = await verifyWebhook(config, Buffer.from(payload), header);
    expect(event.id).toBe('evt_1');
    expect(event.type).toBe('checkout.session.completed');

    await expect(verifyWebhook(config, Buffer.from(payload.replace('cs_1', 'cs_2')), header)).rejects.toThrow(/signature/i);
    await expect(verifyWebhook(config, Buffer.from(payload), undefined)).rejects.toThrow(/Stripe-Signature/);
    const stale = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(verifyWebhook(config, Buffer.from(payload), stale)).rejects.toThrow(/timestamp|tolerance/i);
  });
});

// ---------- fix.md findings 6-8 ----------

const stripeConfig = loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: WHSEC });
const invalidRequest = (code?: string) => new Stripe.errors.StripeInvalidRequestError({ message: 'Invalid request', type: 'invalid_request_error', code });
const useFake = (fake: object) => setStripeClientForTests(fake as unknown as Stripe);

describe('Checkout requests are saved and resent unchanged (finding 6)', () => {
  afterEach(() => setStripeClientForTests(null));

  it('fixes the key and every parameter, including the expiry, when the request is built', () => {
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    const a = buildDepositRequest(stripeConfig, booking(), now);
    const b = buildDepositRequest(stripeConfig, booking(), now);
    expect(a.idempotencyKey).toMatch(/^deposit:00000000-0000-4000-8000-000000000000:[0-9a-f-]{36}$/);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey); // a new request is a new operation
    expect(a.params.expires_at).toBe(Math.floor(now / 1000) + 24 * 3600);
    expect(a.params.line_items![0].price_data).toMatchObject({ currency: 'eur', unit_amount: 3000 });
  });

  it('resends a saved request only while Stripe will still accept its expiry', () => {
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    const request = buildDepositRequest(stripeConfig, booking(), now);
    expect(canResend(request, now)).toBe(true);
    expect(canResend(request, now + 23 * 3_600_000)).toBe(true); // 60 minutes left
    expect(canResend(request, now + 24 * 3_600_000 - 30 * 60_000)).toBe(false); // 30 minutes left
    expect(canResend(null, now)).toBe(false);
  });

  it('sends the saved request as it is and keeps the expiry Stripe returns', async () => {
    const calls: { params: unknown; key: string }[] = [];
    useFake({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => {
            calls.push({ params, key: opts.idempotencyKey });
            // A replayed request returns the session from the first attempt, with its original expiry.
            return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: 1_790_000_000 };
          },
        },
      },
    });
    const saved = JSON.parse(JSON.stringify(buildDepositRequest(stripeConfig, booking()))); // as read back from JSONB
    const first = await createDepositSession(stripeConfig, saved);
    const retry = await createDepositSession(stripeConfig, saved);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0].key).toBe(saved.idempotencyKey);
    expect(first.expiresAt.getTime()).toBe(1_790_000_000 * 1000);
    expect(retry.sessionId).toBe('cs_1');
  });

  it('treats an idempotency mismatch as permanent instead of retrying it forever', async () => {
    useFake({
      checkout: {
        sessions: {
          create: async () => {
            throw new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests can only be used with the same parameters', type: 'idempotency_error' });
          },
        },
      },
    });
    await expect(createDepositSession(stripeConfig, buildDepositRequest(stripeConfig, booking()))).rejects.toBeInstanceOf(PermanentProviderError);
  });
});

describe('expiring a payment link only succeeds when nothing can be paid on it (finding 7)', () => {
  afterEach(() => setStripeClientForTests(null));

  function fakeSessions(retrieve: () => Promise<unknown>, expire: () => Promise<unknown> = async () => ({ status: 'expired' })) {
    const calls: string[] = [];
    useFake({
      checkout: {
        sessions: {
          retrieve: async () => {
            calls.push('retrieve');
            return retrieve();
          },
          expire: async () => {
            calls.push('expire');
            return expire();
          },
        },
      },
    });
    return calls;
  }

  it('fails on a bad API key or missing permission, without pretending the link is dead', async () => {
    fakeSessions(async () => {
      throw new Stripe.errors.StripeAuthenticationError({ message: 'Invalid API Key provided', type: 'authentication_error' });
    });
    await expect(expireDepositSession(stripeConfig, 'cs_1')).rejects.toThrow(/authentication/i);
    fakeSessions(
      async () => ({ id: 'cs_1', status: 'open' }),
      async () => {
        throw new Stripe.errors.StripePermissionError({ message: 'This key does not have access', type: 'invalid_request_error' });
      },
    );
    await expect(expireDepositSession(stripeConfig, 'cs_1')).rejects.toBeInstanceOf(PermanentProviderError);
  });

  it('leaves network trouble to the worker to retry', async () => {
    fakeSessions(async () => {
      throw new Stripe.errors.StripeConnectionError({ message: 'socket hang up', type: 'api_error' });
    });
    const err = await expireDepositSession(stripeConfig, 'cs_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentProviderError);
  });

  it('is done when Stripe expired it, or it had already expired, been paid or never existed', async () => {
    let calls = fakeSessions(async () => ({ id: 'cs_1', status: 'open' }));
    expect(await expireDepositSession(stripeConfig, 'cs_1')).toBe('expired');
    expect(calls).toEqual(['retrieve', 'expire']);
    calls = fakeSessions(async () => ({ id: 'cs_1', status: 'expired' }));
    expect(await expireDepositSession(stripeConfig, 'cs_1')).toBe('already-expired');
    expect(calls).toEqual(['retrieve']);
    fakeSessions(async () => ({ id: 'cs_1', status: 'complete' }));
    expect(await expireDepositSession(stripeConfig, 'cs_1')).toBe('completed');
    fakeSessions(async () => {
      throw invalidRequest('resource_missing');
    });
    expect(await expireDepositSession(stripeConfig, 'cs_1')).toBe('not-found');
  });

  it('checks again when Stripe refuses to expire, and only fails if the session is still open', async () => {
    let status = 'open';
    const refuse = async () => {
      status = 'complete'; // paid a moment before we tried
      throw invalidRequest();
    };
    fakeSessions(async () => ({ id: 'cs_1', status }), refuse);
    expect(await expireDepositSession(stripeConfig, 'cs_1')).toBe('completed');
    fakeSessions(
      async () => ({ id: 'cs_1', status: 'open' }),
      async () => {
        throw invalidRequest();
      },
    );
    await expect(expireDepositSession(stripeConfig, 'cs_1')).rejects.toBeInstanceOf(PermanentProviderError);
  });
});

describe('refunds only count once Stripe says they succeeded (finding 8)', () => {
  afterEach(() => setStripeClientForTests(null));

  it("passes the caller's idempotency key and reports Stripe's refund status", async () => {
    const keys: string[] = [];
    let status: string | null = 'pending';
    useFake({
      refunds: {
        create: async (_p: unknown, opts: { idempotencyKey: string }) => {
          keys.push(opts.idempotencyKey);
          return { id: 're_1', amount: 3000, status };
        },
      },
    });
    expect(await refundDeposit(stripeConfig, 'pi_1', 'b1', 'refund:pi_1')).toEqual({ refundId: 're_1', amountCents: 3000, status: 'pending' });
    status = null;
    expect((await refundDeposit(stripeConfig, 'pi_1', 'b1', 'refund:pi_1:after:re_0')).status).toBe('pending');
    expect(keys).toEqual(['refund:pi_1', 'refund:pi_1:after:re_0']);
    expect(refundStatusOf('succeeded')).toBe('succeeded');
    expect(refundStatusOf('something_new')).toBe('pending');
  });

  it('treats a charge the owner already refunded in the dashboard as refunded', async () => {
    useFake({
      refunds: {
        create: async () => {
          throw invalidRequest('charge_already_refunded');
        },
      },
    });
    expect(await refundDeposit(stripeConfig, 'pi_9', 'b1', 'refund:pi_9')).toEqual({ refundId: 'already-refunded:pi_9', amountCents: 0, status: 'succeeded' });
  });

  it('works out where several refunds of one deposit stand together', () => {
    expect(overallRefundStatus([])).toBeNull();
    expect(overallRefundStatus(['failed', 'succeeded'])).toBe('succeeded');
    expect(overallRefundStatus(['failed', 'pending'])).toBe('pending');
    expect(overallRefundStatus(['pending', 'requires_action'])).toBe('requires_action');
    expect(overallRefundStatus(['canceled', 'failed'])).toBe('failed');
    expect(overallRefundStatus(['canceled'])).toBe('canceled');
  });

  it('marks the deposit refunded and tells the customer only on success, and only for refunds we started', () => {
    const paid = { depositStatus: 'paid' as const, refundStatus: 'requested' as const };
    expect(decideRefund(paid, 'pending', true)).toMatchObject({
      depositStatus: 'paid',
      refundStatus: 'pending',
      event: 'deposit_refund_pending',
      notifyCustomer: false,
      notifyOwner: false,
      outcome: 'refund_pending',
    });
    expect(decideRefund({ depositStatus: 'paid', refundStatus: 'pending' }, 'requires_action', true)).toMatchObject({ event: null, outcome: 'refund_pending' });
    expect(decideRefund({ depositStatus: 'paid', refundStatus: 'pending' }, 'succeeded', true)).toMatchObject({
      depositStatus: 'refunded',
      refundStatus: 'succeeded',
      event: 'deposit_refunded',
      notifyCustomer: true,
      outcome: 'refunded',
    });
    // A refund made in the Stripe dashboard: mirrored, but the customer isn't messaged by us.
    expect(decideRefund({ depositStatus: 'paid', refundStatus: null }, 'succeeded', false)).toMatchObject({ depositStatus: 'refunded', notifyCustomer: false });
  });

  it('puts a failed refund back to paid and alerts the owner, once', () => {
    expect(decideRefund({ depositStatus: 'paid', refundStatus: 'pending' }, 'failed', true)).toMatchObject({
      depositStatus: 'paid',
      refundStatus: 'failed',
      event: 'deposit_refund_failed',
      notifyCustomer: false,
      notifyOwner: true,
      outcome: 'refund_failed',
    });
    // Stripe can fail a refund after it succeeded.
    expect(decideRefund({ depositStatus: 'refunded', refundStatus: 'succeeded' }, 'failed', true)).toMatchObject({ depositStatus: 'paid', notifyOwner: true });
    expect(decideRefund({ depositStatus: 'paid', refundStatus: 'failed' }, 'canceled', true)).toMatchObject({ outcome: 'duplicate', notifyOwner: false });
    // Trying again after a failure.
    expect(decideRefund({ depositStatus: 'paid', refundStatus: 'failed' }, 'pending', true)).toMatchObject({ event: 'deposit_refund_pending', outcome: 'refund_pending' });
  });

  it('ignores repeats and a late "pending" after a dashboard refund was already mirrored as done', () => {
    expect(decideRefund({ depositStatus: 'refunded', refundStatus: 'succeeded' }, 'succeeded', true)).toMatchObject({ outcome: 'duplicate', event: null, notifyCustomer: false });
    expect(decideRefund({ depositStatus: 'refunded', refundStatus: 'succeeded' }, 'pending', false)).toMatchObject({
      depositStatus: 'refunded',
      refundStatus: 'succeeded',
      outcome: 'duplicate',
    });
  });

  it('alerts the owner by email and text, with a link to the payment in Stripe', () => {
    const b = booking({ depositStatus: 'paid', depositPaymentIntentId: 'pi_42', depositRefundStatus: 'failed' });
    const email = ownerEmail('deposit_refund_failed', b, stripeConfig)!;
    expect(email.subject).toMatch(/refund failed/i);
    expect(email.html).toContain('https://dashboard.stripe.com/test/payments/pi_42');
    expect(ownerSms('deposit_refund_failed', b)).toMatch(/FAILED: SJP-K7Q4-9XZ2/);
    expect(customerEmail('deposit_refund_failed', b, stripeConfig)).toBeNull();
    expect(customerSms('deposit_refund_failed', b, stripeConfig)).toBeNull();
  });
});
