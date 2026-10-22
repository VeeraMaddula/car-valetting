-- Deposit payments: repeatable Checkout requests and tracked refund status (fix.md findings 6 and 8).
-- Plain PostgreSQL. Every statement is safe to re-run.

-- The exact Checkout request (idempotency key + parameters, as JSON text), saved before Stripe is called so a
-- retried job repeats the same request and gets back the session Stripe already made. TEXT, not JSONB, because
-- JSONB reorders keys and the retry must send exactly what was sent before. Cleared once the session is stored.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_checkout_request TEXT;

-- Where the deposit refund stands. deposit_status only becomes 'refunded' once Stripe says a refund succeeded.
-- 'requested': the refund has been asked for and Stripe hasn't answered yet; the others are Stripe's statuses.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_refund_status TEXT CONSTRAINT bookings_deposit_refund_status_check CHECK (deposit_refund_status IN ('requested', 'pending', 'requires_action', 'succeeded', 'failed', 'canceled'));

-- Refunds recorded before this migration were treated as complete; keep it that way.
UPDATE bookings SET deposit_refund_status = 'succeeded' WHERE deposit_status = 'refunded' AND deposit_refund_id IS NOT NULL AND deposit_refund_status IS NULL;
