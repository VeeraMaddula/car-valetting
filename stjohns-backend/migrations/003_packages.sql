-- John's real package list and prices (from the printed flyer). Plain PostgreSQL / CockroachDB.

ALTER TABLE services ADD COLUMN IF NOT EXISTS price_from BOOL NOT NULL DEFAULT true;

ALTER TABLE services ADD COLUMN IF NOT EXISTS description TEXT;

UPDATE services SET name = 'Mini Valet', duration_label = 'Approx. 1 hour', price_cents = 5000, price_from = false, sort = 1, active = true,
  description = 'Exterior wash, wheels cleaned, interior vacuum, windows cleaned' WHERE code = 'mini';

INSERT INTO services (code, name, duration_label, price_cents, price_from, sort, active, description) VALUES
  ('standard', 'Standard Valet', 'Approx. 2 hours', 9000, true, 2, true, 'Exterior wash, wheels cleaned, interior vacuum, windows cleaned, dashboard & door shuts wiped')
ON CONFLICT (code) DO UPDATE SET name = excluded.name, duration_label = excluded.duration_label, price_cents = excluded.price_cents,
  price_from = excluded.price_from, sort = excluded.sort, active = excluded.active, description = excluded.description;

UPDATE services SET name = 'Full Valet', duration_label = '3–4 hours', price_cents = 13000, price_from = true, sort = 3, active = true,
  description = 'Exterior wash, wheels cleaned, interior deep clean, seats shampooed, dashboard & door shuts cleaned, windows cleaned' WHERE code = 'full';

INSERT INTO services (code, name, duration_label, price_cents, price_from, sort, active, description) VALUES
  ('polish', 'Machine Polishing', 'Half day', 15000, true, 4, true, 'Paint correction to remove swirls & scratches, machine polish, wax/sealant protection')
ON CONFLICT (code) DO UPDATE SET name = excluded.name, duration_label = excluded.duration_label, price_cents = excluded.price_cents,
  price_from = excluded.price_from, sort = excluded.sort, active = excluded.active, description = excluded.description;

-- Retired: existing bookings keep their reference to it, but it is no longer offered.
UPDATE services SET active = false, sort = 99 WHERE code = 'wheel';
