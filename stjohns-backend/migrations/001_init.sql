-- Initial schema. Written for CockroachDB (also valid PostgreSQL).
-- One statement per ';' line ending; the migration runner executes them in order.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_role_check CHECK (role IN ('customer', 'admin'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS services (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_label TEXT,
  price_cents INT,
  active BOOL NOT NULL DEFAULT true,
  sort INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS slot_periods (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  start_time TIME,
  end_time TIME,
  days_of_week INT[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5, 6],
  sort INT NOT NULL DEFAULT 0,
  active BOOL NOT NULL DEFAULT true,
  CONSTRAINT slot_periods_code_check CHECK (code IN ('morning', 'afternoon', 'evening')),
  CONSTRAINT slot_periods_times_check CHECK (start_time IS NULL OR end_time IS NULL OR start_time < end_time)
);

CREATE TABLE IF NOT EXISTS blocked_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_date DATE NOT NULL,
  period TEXT NOT NULL DEFAULT 'all',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blocked_slots_unique UNIQUE (slot_date, period),
  CONSTRAINT blocked_slots_period_check CHECK (period IN ('all', 'morning', 'afternoon', 'evening'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL,
  user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  service_code TEXT NOT NULL REFERENCES services (code),
  slot_date DATE NOT NULL,
  period TEXT NOT NULL REFERENCES slot_periods (code),
  status TEXT NOT NULL DEFAULT 'pending',
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  vehicle TEXT NOT NULL,
  handover TEXT NOT NULL DEFAULT 'drop_off',
  collection_address TEXT,
  notes TEXT,
  deposit_status TEXT NOT NULL DEFAULT 'not_requested',
  calendar_token TEXT NOT NULL,
  idempotency_key TEXT,
  google_event_id TEXT,
  sequence INT NOT NULL DEFAULT 0,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookings_reference_key UNIQUE (reference),
  CONSTRAINT bookings_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
  CONSTRAINT bookings_handover_check CHECK (handover IN ('drop_off', 'collection')),
  CONSTRAINT bookings_collection_address_check CHECK (handover <> 'collection' OR collection_address IS NOT NULL),
  CONSTRAINT bookings_deposit_check CHECK (deposit_status IN ('not_requested', 'requested', 'paid', 'refunded', 'waived'))
);

-- The guarantee behind "a booked slot is blocked": at most one non-cancelled booking per date + period,
-- enforced by the database even when two customers press Confirm at the same instant.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_slot ON bookings (slot_date, period) WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id, slot_date);

CREATE INDEX IF NOT EXISTS bookings_slot_date_idx ON bookings (slot_date, status);

CREATE TABLE IF NOT EXISTS booking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_events_booking_idx ON booking_events (booking_id, created_at);

-- Transactional outbox: notifications and calendar syncs are written in the same transaction as the
-- booking and delivered by the background worker, so API responses never wait on email/SMS/Google.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 8,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_check CHECK (status IN ('pending', 'running', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, run_at);

INSERT INTO services (code, name, duration_label, sort) VALUES
  ('mini', 'Mini Valet', 'Approx. 2 hours', 1),
  ('full', 'Full Valet', '4+ hours', 2),
  ('wheel', 'Wheel & Finish Care', 'Precision finish', 3)
ON CONFLICT (code) DO NOTHING;

INSERT INTO slot_periods (code, label, sort) VALUES
  ('morning', 'Morning', 1),
  ('afternoon', 'Afternoon', 2),
  ('evening', 'Evening', 3)
ON CONFLICT (code) DO NOTHING;
