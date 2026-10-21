-- Admin dashboard: settings, prices by vehicle size, sale prices, add-ons, discount codes, price snapshots on
-- bookings, customer notes, photos, team access. Plain PostgreSQL / CockroachDB. Every statement is safe to re-run.

-- Owner-editable settings (business details, booking rules, alerts, messages). One JSON document per key.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

-- ---------- Services: size tiers, featured badge, sale price ----------

ALTER TABLE services ADD COLUMN IF NOT EXISTS featured BOOL NOT NULL DEFAULT false;

ALTER TABLE services ADD COLUMN IF NOT EXISTS price_large_cents INT;

ALTER TABLE services ADD COLUMN IF NOT EXISTS price_suv_cents INT;

ALTER TABLE services ADD COLUMN IF NOT EXISTS sale_enabled BOOL NOT NULL DEFAULT false;

ALTER TABLE services ADD COLUMN IF NOT EXISTS sale_price_cents INT;

ALTER TABLE services ADD COLUMN IF NOT EXISTS sale_starts_on DATE;

ALTER TABLE services ADD COLUMN IF NOT EXISTS sale_ends_on DATE;

ALTER TABLE services DROP CONSTRAINT IF EXISTS services_prices_check;

ALTER TABLE services ADD CONSTRAINT services_prices_check CHECK (
  (price_cents IS NULL OR price_cents >= 0) AND (price_large_cents IS NULL OR price_large_cents >= 0)
  AND (price_suv_cents IS NULL OR price_suv_cents >= 0) AND (sale_price_cents IS NULL OR sale_price_cents >= 0)
  AND (sale_starts_on IS NULL OR sale_ends_on IS NULL OR sale_starts_on <= sale_ends_on)
);

-- Extras a customer can add to any service (e.g. pet hair removal).
CREATE TABLE IF NOT EXISTS addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  price_cents INT NOT NULL,
  active BOOL NOT NULL DEFAULT true,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT addons_price_check CHECK (price_cents >= 0)
);

-- ---------- Discount codes ----------

CREATE TABLE IF NOT EXISTS discounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  value INT NOT NULL,
  service_codes TEXT[] NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE,
  max_uses INT,
  uses INT NOT NULL DEFAULT 0,
  paused BOOL NOT NULL DEFAULT false,
  first_booking_only BOOL NOT NULL DEFAULT false,
  one_per_customer BOOL NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discounts_code_key UNIQUE (code),
  CONSTRAINT discounts_kind_check CHECK (kind IN ('percent', 'fixed')),
  CONSTRAINT discounts_value_check CHECK (value > 0 AND (kind <> 'percent' OR value <= 90)),
  CONSTRAINT discounts_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT discounts_uses_check CHECK (uses >= 0 AND (max_uses IS NULL OR max_uses > 0))
);

-- ---------- Price snapshot on each booking (what the customer was quoted) ----------

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vehicle_size TEXT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_cents INT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]';

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons_cents INT NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_id UUID;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_code TEXT;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_cents INT;

-- What was actually charged, set by the owner (e.g. a "from" price that came out higher for a large car).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_price_cents INT;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_vehicle_size_check;

ALTER TABLE bookings ADD CONSTRAINT bookings_vehicle_size_check CHECK (vehicle_size IS NULL OR vehicle_size IN ('small', 'large', 'suv'));

UPDATE bookings SET price_cents = services.price_cents, total_cents = services.price_cents
FROM services WHERE services.code = bookings.service_code AND bookings.price_cents IS NULL;

CREATE INDEX IF NOT EXISTS bookings_customer_phone_idx ON bookings (customer_phone);

CREATE INDEX IF NOT EXISTS bookings_discount_idx ON bookings (discount_id);

CREATE INDEX IF NOT EXISTS bookings_created_idx ON bookings (created_at);

-- ---------- Customers ----------

-- Owner's private notes; key is 'user:<uuid>' for account holders or 'guest:<E.164 phone>' for guests.
CREATE TABLE IF NOT EXISTS customer_notes (
  customer_key TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Photos (stored resized as WebP; originals and their EXIF/GPS data are never kept) ----------

CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  width INT NOT NULL,
  height INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE TABLE IF NOT EXISTS image_variants (
  image_id UUID NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  width INT NOT NULL,
  height INT NOT NULL,
  bytes BYTEA NOT NULL,
  PRIMARY KEY (image_id, width)
);

-- Homepage slides and gallery photos.
CREATE TABLE IF NOT EXISTS gallery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section TEXT NOT NULL,
  image_id UUID NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  caption TEXT,
  alt TEXT,
  category TEXT,
  featured BOOL NOT NULL DEFAULT false,
  visible BOOL NOT NULL DEFAULT true,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gallery_items_section_check CHECK (section IN ('slide', 'photo')),
  CONSTRAINT gallery_items_category_check CHECK (category IS NULL OR category IN ('exterior', 'interior', 'wheels', 'detail'))
);

CREATE INDEX IF NOT EXISTS gallery_items_section_idx ON gallery_items (section, sort);

CREATE TABLE IF NOT EXISTS before_after (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  before_image_id UUID NOT NULL REFERENCES images (id),
  after_image_id UUID NOT NULL REFERENCES images (id),
  published BOOL NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Team access: 'staff' can manage bookings only, 'admin' has full access ----------

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer', 'staff', 'admin'));

CREATE TABLE IF NOT EXISTS team_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  CONSTRAINT team_invites_token_key UNIQUE (token_hash),
  CONSTRAINT team_invites_role_check CHECK (role IN ('staff', 'admin'))
);

-- ---------- Jobs: one-off scheduled jobs (e.g. the 8am daily summary) are de-duplicated by key ----------

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_key_idx ON jobs (dedupe_key);
