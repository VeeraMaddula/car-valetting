-- Stripe Checkout for the deposit. Written for CockroachDB (also valid PostgreSQL).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_session_id TEXT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_pay_url TEXT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_link_expires_at TIMESTAMPTZ;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_payment_intent_id TEXT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_refund_id TEXT;

CREATE INDEX IF NOT EXISTS bookings_deposit_session_idx ON bookings (deposit_session_id);

-- Every Stripe event we act on, keyed by Stripe's event id so a redelivered webhook is a no-op.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  booking_id UUID REFERENCES bookings (id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Money in and out, one row per Stripe payment or refund, for the owner's records.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount_cents INT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  stripe_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_kind_check CHECK (kind IN ('deposit', 'refund')),
  CONSTRAINT payments_stripe_id_key UNIQUE (stripe_id)
);

CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments (booking_id, created_at);
