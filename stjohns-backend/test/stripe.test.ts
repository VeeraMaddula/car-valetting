import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { depositPayUrl, type BookingRecord } from '../src/domain/bookings.js';
import { customerEmail, customerSms, ownerEmail, ownerSms } from '../src/notifications/templates.js';
import { depositAmountCents, setStripeClientForTests, verifyWebhook } from '../src/payments/stripe.js';

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
