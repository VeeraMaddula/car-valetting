-- My profile: optional details a customer can add to their account. Plain PostgreSQL. Every statement is safe to re-run.
-- Data minimisation (GDPR): all optional, nothing else is collected, and deleting the account deletes the row.

-- Optional; the customer can clear it at any time.
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- Irish postal address, used to fill in the collection address when they ask us to collect the car.
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1 TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2 TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS town TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS county TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS eircode TEXT;
