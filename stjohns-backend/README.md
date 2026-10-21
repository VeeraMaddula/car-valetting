# St Johns Park — Booking API

Backend for the St Johns Park Car Valeting website: three bookable slots a day (morning, afternoon, evening),
guest or account bookings, tracking by reference, and notifications by email, SMS and calendar.

**Stack:** Node.js 22 · TypeScript · Fastify · PostgreSQL (Neon) · Resend (email) · Sendmode (SMS) · Google Calendar · Stripe (deposit).

## What it does

- **Slots that can't be double-booked.** Each date has a Morning, Afternoon and Evening slot. A partial unique index in the
  database allows only one active booking per slot, so two people pressing *Confirm* at the same moment can never both get it
  (tested with 10 simultaneous requests). Cancelling frees the slot immediately.
- **Book as a guest or with an account.** Accounts use username or email + password (argon2id hashes, httpOnly session cookies).
  Guests get a tracking reference like `SJP-K7Q4-9XZ2`.
- **Track any booking** with the reference + the phone number used to book; cancel online up to 24 hours before the slot.
  Signed-in customers see all their bookings and can add earlier guest bookings to their account.
- **Notifications:** email via Resend, SMS via Sendmode, and calendar entries:
  - customers get an `.ics` attachment and an *Add to calendar* link that opens straight into Apple Calendar on iPhone/iCloud
    (and works with Google/Outlook);
  - the owner gets an email + SMS for every new booking or cancellation, a Google Calendar event per booking, and an
    iPhone/iCloud subscribed calendar of all bookings;
  - a reminder goes out at 6pm the evening before each slot.
- **Deposit paid online (Stripe Checkout).** When the owner requests the deposit, the customer gets a secure Stripe link
  by email and SMS (card, Apple Pay, Google Pay). Stripe's webhook marks the booking paid; a cancellation refunds it
  automatically, and cancelling an unpaid booking kills the link. Without Stripe keys the old manual message is used.
- **Owner tools (API):** confirm/cancel/complete bookings, request/record/refund the €30 deposit, close a slot or a whole day,
  set slot times and weekdays, see and retry failed notifications.

## Why it's fast

- Emails, SMS and Google Calendar calls run in a background worker (transactional outbox), so a booking request only waits
  for the database: about 30 ms in local tests, typically 15–40 ms in production when the API and database share a region.
- Availability for a whole fortnight is two indexed queries run in parallel (≈5 ms locally).
- Services and slot settings are cached in memory; session lookups are cached for 30 s.
- Database connections are opened before the server takes traffic; CORS preflights are cached by browsers for 24 h.
- Every response carries a `Server-Timing` header, so the browser's network panel shows time spent on the server.

**Keep the API in the same cloud region as the database.** That matters more than anything else for response times.
See [Choosing the region](#choosing-the-region).

## Local development

Requirements: Node.js 22.9+, and either Docker or a local PostgreSQL.

```bash
cp .env.example .env
docker compose up -d          # CockroachDB on localhost:26257 (or point DATABASE_URL at any local PostgreSQL)
npm install
npm run migrate               # creates tables and seeds services + slots
npm run dev                   # API on http://localhost:8080/api/v1
```

Without Docker, download CockroachDB for your OS from https://www.cockroachlabs.com/docs/releases/ and run
`cockroach start-single-node --insecure --listen-addr=127.0.0.1:26257`.

Tests:

```bash
npm test                                   # unit tests
TEST_DATABASE_URL="postgresql://root@127.0.0.1:26257/defaultdb?sslmode=disable" npm test   # + end-to-end API tests
npm run typecheck
```

The end-to-end suite creates and drops its own database. It covers booking, double-booking races, idempotent retries,
validation, tracking, cancellation, accounts, claiming guest bookings, admin actions, slot closures, calendar files,
password reset and the notification worker.

## Production setup

### 1. Database (Neon PostgreSQL)

The API runs on any PostgreSQL 14+ (Neon, Supabase, RDS, a VPS) and still on CockroachDB. Neon is the default:
free tier, scales to zero when idle and wakes on the next connection, nothing to maintain.

1. Sign in at https://neon.tech → **New project** → name `stjohns`, Postgres 17, region **AWS Europe (London) eu-west-2**
   (closest to Waterford; Frankfurt is fine too).
2. On the project page click **Connect** → copy the **pooled** connection string (host contains `-pooler`). Set it as
   `DATABASE_URL`, keeping `?sslmode=verify-full` and dropping `&channel_binding=require`:
   ```
   postgresql://neondb_owner:npg_…@ep-…-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=verify-full
   ```
3. Create the tables, seed the packages and check the connection:
   ```bash
   npm run db:setup
   ```
   It creates the database if the role is allowed to (on Neon, `neondb` already exists), applies every pending migration
   (`migrations/*.sql`, tracked in `schema_migrations`), then prints the server version, TLS mode, the active packages and
   the round-trip time. Safe to run again at any time. On deploy, run `node dist/scripts/db-setup.js` (or
   `node dist/db/migrate.js`) as the release/pre-deploy command.

Packages and prices live in the `services` table (`003_packages.sql`): Mini Valet €50, Standard Valet from €90,
Full Valet from €130, Machine Polishing from €150. Change them with SQL or, later, the admin UI; the website reads them
from `GET /config`.

### 2. Host the API

Any Docker host works (`Dockerfile` included). Set the environment variables from `.env.example` with `NODE_ENV=production`.
Health check: `GET /api/v1/health`.

#### Choosing the region

| API host | Put the API in | Neon region |
|---|---|---|
| Render | Frankfurt | AWS eu-central-1 Frankfurt |
| Railway / Fly.io | London or Amsterdam | AWS eu-west-2 London |
| AWS (App Runner, ECS, Lightsail) | eu-west-2 London | AWS eu-west-2 London |
| Google Cloud Run | europe-west2 London | AWS eu-west-2 London |

### 3. Domain (GoDaddy)

Point two names at your hosts in GoDaddy DNS:

- `www.yourdomain.ie` → where the website is hosted
- `api.yourdomain.ie` → CNAME to the API host

Then set `PUBLIC_SITE_URL=https://www.yourdomain.ie`, `PUBLIC_API_URL=https://api.yourdomain.ie`,
`ALLOWED_ORIGINS=https://www.yourdomain.ie,https://yourdomain.ie` and `COOKIE_DOMAIN=.yourdomain.ie`.
Using one domain for both keeps the login cookie first-party, which Safari on iPhone requires.

### 4. Resend (email)

1. **API keys** › create a key named `stjohns-api` with **Sending access** and paste it into `.env` as
   `RESEND_API_KEY` (never in chat, screenshots or git; if one leaks, delete it and create another).
2. Test right away: `npm run email:test` sends to `OWNER_EMAIL`. Until a domain is verified, Resend only delivers
   to the address you signed up with, from `EMAIL_FROM="St Johns Park Valeting <onboarding@resend.dev>"`.
3. **Domains** › add your domain, region **Ireland (eu-west-1)**, then add the DNS records it shows (DKIM `TXT`,
   SPF `MX` + `TXT` on the `send` subdomain) in GoDaddy › DNS. Verification usually takes minutes.
4. Once verified, set `EMAIL_FROM="St Johns Park Valeting <bookings@yourdomain.ie>"` and, optionally,
   `EMAIL_REPLY_TO` (e.g. the owner's inbox, so customer replies reach a person), then run `npm run email:test` again.
   You can now restrict the API key to that domain.

### 5. Sendmode (SMS)

1. At https://www.sendmode.com create an account and an **API access key** → `SENDMODE_ACCESS_KEY`.
2. Set `SENDMODE_SENDER_ID` (up to 11 characters, e.g. `StJohnsPark`).
3. Send one test booking to your own mobile. If Sendmode rejects the number format, set `SENDMODE_NUMBER_FORMAT=national`.

SMS go only to mobile numbers; landlines are skipped automatically.

### 6. Google Calendar

1. In https://console.cloud.google.com create a project, enable the **Google Calendar API**, create a **service account**
   and download a JSON key.
2. In Google Calendar → *Settings and sharing* of the calendar you want bookings in → *Share with specific people* →
   add the service account's email with **Make changes to events**.
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (the JSON, or base64 of it) and `GOOGLE_CALENDAR_ID` (shown under
   *Integrate calendar*, often your Gmail address).

Events are yellow while pending, green when confirmed, grey when done or cancelled. If the Google account is added
to the owner's iPhone, they appear there too.

### 7. iPhone / iCloud calendar

- **Customers:** confirmation emails include a calendar attachment, and emails and texts include an *Add to calendar* link.
  On iPhone either one opens Apple Calendar directly. Cancellations update the same event.
- **Owner:** set `ADMIN_CALENDAR_FEED_KEY` to a long random string, then on the iPhone go to
  *Settings › Apps › Calendar › Calendar Accounts › Add Account › Other › Add Subscribed Calendar* (on older iOS:
  *Settings › Calendar › Accounts*) and enter
  `https://api.yourdomain.ie/api/v1/admin/calendar.ics?key=<ADMIN_CALENDAR_FEED_KEY>`.
  Every booking appears and stays in sync. Choose iCloud as the account to sync it to the Mac and iPad as well.

### 8. Google Analytics (website visitors)

1. At https://analytics.google.com create a **GA4 property** for the website and a **Web data stream** for your domain.
   Copy the **Measurement ID** (`G-…`).
2. **Website:** put it on the `<html>` tag of every page: `<html lang="en" data-ga-id="G-XXXXXXXXXX">`. `analytics.js`
   then shows a cookie banner and loads Google Analytics only for visitors who choose *Allow analytics*, as Irish/EU
   rules require. Visitors who decline aren't tracked, and the footer's *Cookie settings* link lets them change their mind.
   It also records `begin_booking` and `click_to_call` events.
3. **Admin dashboard:** in the Google Cloud project used for Calendar, enable the **Google Analytics Data API**. In GA go
   to *Admin › Property access management* and add the service account's email as a **Viewer**. Then set
   `GA4_PROPERTY_ID` (the numeric ID from *Admin › Property settings*) and `GA4_MEASUREMENT_ID`.
4. `GET /api/v1/admin/analytics?range=7|30|90` now returns visitors, visits, page views, time on site, daily visitors,
   traffic sources, devices, towns, top pages, people on the site right now, and bookings for the same period.
   Results are cached for 5 minutes to stay within Google's quotas.

### 9. Stripe (deposit payments)

1. Create the account at https://dashboard.stripe.com in the business's name (the owner should own it; payouts go to his bank).
   Complete *Activate your account* (business details, bank account) before going live.
2. **Developers › API keys** → copy the **Secret key** → `STRIPE_SECRET_KEY`. Use the `sk_test_…` key until launch.
3. **Developers › Webhooks › Add endpoint** → URL `https://api.yourdomain.ie/api/v1/webhooks/stripe` → select the events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired` and `charge.refunded` → copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`.
4. **Settings › Payment methods**: cards are on by default; turn on Apple Pay / Google Pay (Checkout shows them automatically).
   **Settings › Public details**: set the statement descriptor so the card statement reads e.g. `ST JOHNS PARK VALET`.
5. Redeploy with both variables set. `GET /api/v1/config` now reports `booking.onlineDeposit: true` and the website shows
   *Pay deposit* buttons on the tracking and My bookings pages.

How it works: `PATCH /admin/bookings/:ref {depositStatus:"requested"}` queues a `deposit.link` job. The worker creates a
Checkout Session (idempotent per booking), stores the URL, and only then queues the "pay your deposit" email + SMS. Stripe
calls the webhook when the customer pays; the handler is idempotent on Stripe's event id, so retries never double-count.
`PATCH … {depositStatus:"refunded"}` or any cancellation of a paid booking queues `deposit.refund`. A refund done in the Stripe
dashboard is mirrored by the `charge.refunded` event. Money in/out is recorded in the `payments` table.

Local testing with the Stripe CLI (https://docs.stripe.com/stripe-cli):

```bash
stripe login
stripe listen --forward-to localhost:8080/api/v1/webhooks/stripe   # prints a whsec_… for STRIPE_WEBHOOK_SECRET
# request a deposit through the admin API, open the link from the jobs table or the customer email,
# pay with test card 4242 4242 4242 4242 (any future date, any CVC)
```

The end-to-end suite covers the whole flow with a stubbed Stripe client and real signed webhooks (`test/integration/deposits.test.ts`).

### 10. Owner account

```bash
npm run create-admin
```

It asks for a username, email, name, mobile number and password (hidden as you type, entered twice). Running it with
an existing username makes that account an admin and optionally resets its password.

On a server without a terminal, pass everything up front (the password only through the environment):

```bash
ADMIN_PASSWORD='a long password' node dist/scripts/create-admin.js --username owner --email you@yourdomain.ie --name "Your Name" --phone "089 470 9672"
```

In PowerShell, `npm run create-admin -- --flags` loses the `--`; use `npm.cmd run create-admin -- --flags` instead.

## API

Base URL: `/api/v1`. JSON in and out. Errors look like `{"error":{"code","message","fields"?}}`.
Browsers must call with `credentials: 'include'` for accounts to work.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/health` | anyone | Liveness + DB latency |
| GET | `/config` | anyone | Services, slot labels/times, booking rules |
| GET | `/availability?from=&to=` | anyone | Slots per day (`available` / `booked` / `unavailable`), max 62 days |
| POST | `/bookings` | guest or signed in | Create a booking. Send an `Idempotency-Key` header (random UUID) so retries never double-book |
| POST | `/bookings/track` | anyone | `{reference, phone}` → booking + timeline |
| POST | `/bookings/track/cancel` | anyone | `{reference, phone, reason?}` |
| GET | `/bookings/:ref/calendar.ics?t=` | link holder | Apple/Google calendar file |
| POST | `/auth/register` | anyone | `{username, email, password, fullName, phone}` |
| POST | `/auth/login` | anyone | `{login, password}` (login = username or email) |
| POST | `/auth/logout` | signed in | |
| GET | `/auth/me` | anyone | `{user}` or `{user: null}` |
| POST | `/auth/password/forgot` | anyone | `{email}` → reset link by email |
| POST | `/auth/password/reset` | link holder | `{token, password}` |
| GET | `/me/bookings` | signed in | Own bookings |
| GET | `/me/bookings/:ref` | signed in | One booking + timeline |
| POST | `/me/bookings/:ref/cancel` | signed in | `{reason?}` |
| POST | `/me/bookings/claim` | signed in | `{reference, phone}` adds a guest booking to the account |
| GET | `/admin/bookings?from=&to=&status=` | admin | Bookings with full details |
| GET/PATCH | `/admin/bookings/:ref` | admin | Details + history / `{status?, depositStatus?, note?}`. `depositStatus: requested` sends a Stripe link; `refunded` refunds a paid deposit |
| POST | `/webhooks/stripe` | Stripe | Signed webhook: marks deposits paid/refunded, expires links |
| GET/POST/DELETE | `/admin/blocks` | admin | Close a slot or day: `{date, period: all\|morning\|afternoon\|evening, reason?}` |
| GET/PUT | `/admin/slot-periods/:code` | admin | `{label, startTime, endTime, daysOfWeek, active}` (times `HH:MM` or null) |
| GET | `/admin/jobs?status=failed`, POST `/admin/jobs/:id/retry` | admin | Notification delivery problems |
| GET | `/admin/analytics?range=7\|30\|90` | admin | Website visitors from Google Analytics + bookings for the period |
| GET | `/admin/calendar.ics?key=` | feed key | Owner's subscribed calendar |

Booking body: `{serviceCode: mini|full|wheel, date: YYYY-MM-DD, period, name, phone, email?, vehicle, handover?: drop_off|collection, collectionAddress?, notes?}`.

## Booking rules (env-configurable)

- Open Monday–Saturday; Sunday closed (`days_of_week` per slot).
- Bookable up to `BOOKING_MAX_DAYS_AHEAD` (84) days ahead and at least `BOOKING_MIN_LEAD_MINUTES` (120) before the slot starts.
- Slot times show as "Time to be confirmed" until set with `PUT /admin/slot-periods/:code`. Until then, rules use
  09:00 / 13:00 / 16:30 as start times.
- Customers can cancel online until `CANCEL_CUTOFF_HOURS` (24) before the slot; after that they're asked to phone.
- Status flow: `pending → confirmed → completed`, plus `cancelled` and `no_show`.
- Deposit flow: `not_requested → requested → paid → refunded` (or `waived`). Deposit links expire after `DEPOSIT_LINK_HOURS` (24).

## Security notes

- Passwords: argon2id. Sessions: random 256-bit tokens, stored as SHA-256 hashes, in `HttpOnly; SameSite=Lax; Secure` cookies.
- Cross-site writes are rejected by an Origin check on top of SameSite cookies. CORS is limited to `ALLOWED_ORIGINS`.
- Tracking needs the reference **and** the phone number; failed lookups don't reveal which part was wrong.
- Rate limits on booking, tracking, login, registration and password reset. Logs redact cookies.
- Reset tokens are single-use, last 1 hour, and are wiped from the job queue once emailed. A reset signs out all sessions.
