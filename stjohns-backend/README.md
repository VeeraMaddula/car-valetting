# St Johns Park — Booking API

Backend for the St Johns Park Car Valeting website: three bookable slots a day (morning, afternoon, evening),
guest or account bookings, tracking by reference, and notifications by email, SMS and calendar.

**Stack:** Node.js 22 · TypeScript · Fastify · CockroachDB · Resend (email) · Sendmode (SMS) · Google Calendar.

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
- **Owner tools (API):** confirm/cancel/complete bookings, request/record the €30 deposit, close a slot or a whole day,
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

Requirements: Node.js 22.9+, and Docker (or the CockroachDB binary).

```bash
cp .env.example .env
docker compose up -d          # CockroachDB on localhost:26257 (console: http://localhost:8089)
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

### 1. CockroachDB (database)

1. Sign in at https://cockroachlabs.cloud and create a **Basic** cluster.
2. Cloud provider **AWS**, region **eu-west-1 (Ireland)**, the closest to Waterford. If your API host has no Ireland
   region, see [Choosing the region](#choosing-the-region).
3. Create a SQL user and copy the connection string. Add a database name, e.g.
   `postgresql://USER:PASSWORD@HOST:26257/stjohns?sslmode=verify-full`, and set it as `DATABASE_URL`.
4. Create the database and tables:
   ```bash
   cockroach sql --url "<connection string with /defaultdb>" -e "CREATE DATABASE IF NOT EXISTS stjohns"
   DATABASE_URL="<connection string with /stjohns>" npm run migrate
   ```
   On deploy, run `node dist/db/migrate.js` as the release/pre-deploy command. It only applies new migrations.

### 2. Host the API

Any Docker host works (`Dockerfile` included). Set the environment variables from `.env.example` with `NODE_ENV=production`.
Health check: `GET /api/v1/health`.

#### Choosing the region

| API host | Put the API in | CockroachDB region |
|---|---|---|
| AWS (App Runner, ECS, Lightsail) | eu-west-1 Ireland | AWS eu-west-1 |
| Google Cloud Run | europe-west2 London | GCP europe-west2 |
| Render | Frankfurt | AWS eu-central-1 Frankfurt |
| Railway / Fly.io | Amsterdam or London | nearest of the above |

### 3. Domain (GoDaddy)

Point two names at your hosts in GoDaddy DNS:

- `www.yourdomain.ie` → where the website is hosted
- `api.yourdomain.ie` → CNAME to the API host

Then set `PUBLIC_SITE_URL=https://www.yourdomain.ie`, `PUBLIC_API_URL=https://api.yourdomain.ie`,
`ALLOWED_ORIGINS=https://www.yourdomain.ie,https://yourdomain.ie` and `COOKIE_DOMAIN=.yourdomain.ie`.
Using one domain for both keeps the login cookie first-party, which Safari on iPhone requires.

### 4. Resend (email)

1. At https://resend.com add your domain, then add the DNS records it shows (SPF/MX and DKIM) in GoDaddy.
2. Once verified, create an API key → `RESEND_API_KEY`.
3. Set `EMAIL_FROM="St Johns Park Valeting <bookings@yourdomain.ie>"` and, optionally, `EMAIL_REPLY_TO`.

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

### 9. Owner account

```bash
ADMIN_PASSWORD='a long password' npm run create-admin -- --username owner --email you@yourdomain.ie --name "Your Name" --phone "089 470 9672"
```

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
| GET/PATCH | `/admin/bookings/:ref` | admin | Details + history / `{status?, depositStatus?, note?}` |
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

## Security notes

- Passwords: argon2id. Sessions: random 256-bit tokens, stored as SHA-256 hashes, in `HttpOnly; SameSite=Lax; Secure` cookies.
- Cross-site writes are rejected by an Origin check on top of SameSite cookies. CORS is limited to `ALLOWED_ORIGINS`.
- Tracking needs the reference **and** the phone number; failed lookups don't reveal which part was wrong.
- Rate limits on booking, tracking, login, registration and password reset. Logs redact cookies.
- Reset tokens are single-use, last 1 hour, and are wiped from the job queue once emailed. A reset signs out all sessions.
