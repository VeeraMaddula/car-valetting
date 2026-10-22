# Bugs and proposed fixes

**Current status (2026-10-22, after the recheck below):** findings 1-11 are fixed in code. Findings 6-11 were fixed after the "Latest recheck" section below was written, so its "6-11 remain open" line is superseded; see "Third recheck and fixes" and the **Fix** notes under each finding. **Findings 12-14 are new and still open.**

## Latest recheck: 2026-10-22

Typecheck passes; the existing suite reports **52 passed, 42 skipped**. Findings 6-11 remain open on inspection of the current payment, setup, admin-script, and team code. Findings 1-5 retain their earlier unit-level evidence; database integration and team concurrency tests remain unverified. The historical lock-order safety claim under finding 1 is superseded by finding 11.

Three new mocked diagnostic checks reproduced findings 12-14 below. They exercise application code without contacting Stripe or PostgreSQL; real concurrent database execution was not tested. Temporary probes were removed after recording the results because they asserted the observed bugs. Application code was not changed during this recheck.

### 12. A late payment event can revert a refunded deposit to paid

- **Status/Priority:** Open, P1.
- **Location:** `stjohns-backend/src/domain/deposits.ts`, `applyToBooking`, paid Checkout event branch.
- **Bug:** Only an existing `paid` deposit is treated as a duplicate. An existing `refunded` deposit is overwritten with `paid`, retaining the refund id and creating contradictory state. Event-id deduplication does not protect against a distinct late payment-success event for the same payment.
- **Evidence:** A mocked booking row with `deposit_status = 'refunded'` received a paid Checkout event. The handler returned `paid` and issued the paid-state update.
- **Proposed fix:** Reconcile events against stored session/payment identity and payment history; keep terminal refunded state for the same payment when success events arrive late. Record a genuinely different payment separately instead of silently replacing the booking's payment state.
- **Verification:** Apply success, refund, then a distinct late success event for the original payment. The booking must remain refunded with no duplicate payment-success notification.

### 13. Payment received after cancellation does not queue a refund

- **Status/Priority:** Open, P1.
- **Location:** `stjohns-backend/src/domain/deposits.ts`, paid Checkout event branch; `src/domain/bookings.ts`, `depositJobsOnCancel`.
- **Bug:** Cancellation of a requested deposit queues only Checkout expiration. If payment completes before expiration, or its webhook arrives after cancellation, the success handler marks it paid without reading booking status or queuing a refund. The expiration helper treats a completed session as a no-op, leaving money collected for a cancelled booking despite the application's automatic-refund policy.
- **Evidence:** A mocked cancelled booking with a requested deposit received a paid event. The handler wrote `paid`; no `deposit.refund` job was enqueued. The row-locking SELECT does not retrieve booking status.
- **Proposed fix:** Read booking status under the existing lock, record the payment, and atomically enqueue an idempotent refund when the booking is cancelled. Coordinate with the cancellation path to cover either transaction order.
- **Verification:** Test payment-before-cancellation and cancellation-before-payment processing, including a completed session encountered by expiration. Both orders must produce exactly one refund operation.

### 14. Link creation can finish after cancellation and leave a live Checkout session

- **Status/Priority:** Open, P1.
- **Location:** `stjohns-backend/src/domain/deposits.ts`, `createDepositLink`.
- **Bug:** Booking status is checked before the external provider call. The later transaction unconditionally stores the link by id without checking current booking/deposit state. Cancellation during the provider call can see no session id and therefore queue no expiration, after which the worker stores the new session on the cancelled booking. Hiding its URL locally does not expire the provider session.
- **Evidence:** A mocked provider marked cancellation as having occurred before returning the session. The worker still issued an update guarded only by booking id and never expired the session. This confirms missing revalidation/cleanup; a real transaction interleaving remains untested.
- **Proposed fix:** After provider creation, lock and revalidate current booking/deposit state and request identity before storing the session. If stale or cancelled, durably queue cleanup of the newly created session instead of installing it. Avoid keeping database locks open across provider calls.
- **Verification:** Pause provider creation, commit cancellation, then resume it. Assert no link is installed and the created provider session is expired; repeat with a changed deposit request to check stale-session cleanup.

Reviewed: 2026-10-21. Scope: the five backend files open in the IDE and their immediate callers, schemas, and tests. This is an initial review, not a full repository audit.

Rechecked: 2026-10-21 against the current workspace. All five findings now have implementation changes. Findings 1, 3, 4, and 5 are addressed in code; finding 2 is partially addressed with one reproduced edge case remaining. This recheck changed this report only; existing application changes were preserved. Original bug descriptions below describe the pre-fix behavior.

Second recheck and fixes: 2026-10-21. **All five findings are fixed in code.** The remaining finding-2 edge case is fixed and covered by a unit test. A follow-up from the first recheck (open invites surviving access removal) is also fixed. Unit-level regressions pass. The database-backed regression tests for findings 1 and 4 are written in `stjohns-backend/test/integration/admin.test.ts` but **have not run yet**: they need `TEST_DATABASE_URL` (a Neon dev branch) in `.env`.

Third recheck and fixes: 2026-10-22. **Findings 6-11 are fixed in code** (details under each finding). Typecheck and the unit suite pass (68 tests, including new ones for findings 6-9). New database-backed tests for findings 6-9 and 11 are written in `test/integration/deposits.test.ts` and `admin.test.ts` but **have not run yet**: this workspace has no `TEST_DATABASE_URL`. The owner reported the database suite passing (94/94) on the Neon dev branch after the second recheck, so the "not yet run" notes for findings 1 and 4 below are out of date. Deploying these fixes needs migration `005_deposit_refunds.sql` applied first, and three more Stripe webhook events (see finding 8).

| Finding | Status | Evidence |
| --- | --- | --- |
| 6. Checkout retry parameters | Fixed; unit tests pass; database test written, not yet run | The exact request (key + parameters, including expiry) is saved on the booking before Stripe is called and resent unchanged; Stripe's returned expiry is stored. |
| 7. Expiry hides auth/permission failures | Fixed; unit tests pass; database test written, not yet run | Only expired, completed and missing sessions count as done; everything else fails the job and keeps the link recorded. |
| 8. Pending/failed refunds | Fixed; unit tests pass; database tests written, not yet run | New `deposit_refund_status`; "refunded" and the customer message only once Stripe says succeeded; refund webhooks handled; pending refunds re-checked by the worker; failures revert to paid and alert the owner. |
| 9. Admin script leaves sessions valid | Fixed; unit test passes; database test written, not yet run | `grantAdmin` updates the account and deletes its sessions in one transaction; the API no longer caches staff/admin sessions, so revocation from another process applies at once. |
| 10. db-setup pool leak | Fixed; typecheck only | `pool.end()` in `finally`. |
| 11. Opposite lock order | Fixed; database test written, not yet run | `acceptInvite` now locks the user before the invite, the same users-before-invites order as `removeMember`. |
| 1. Stale role during invite acceptance | Fixed; database test written, not yet run | `acceptInvite` locks and reads the current account (email, role); an existing admin is never downgraded, and a stale session can't restore a revoked role. Follow-up: removing a member now also deletes open invites for their email. Regression in `admin.test.ts` › "invites team members…": the account is promoted in the database while its cached session still says "customer", then accepts an older bookings-only invite and stays admin; removing a member cancels their open invite. Truly interleaved transactions are not exercised. |
| 2. Session expiry | Fixed; verified by unit tests | Cache lifetime capped at session expiry, and a row whose expiry passes while the query is in flight is rejected (cache entry cleared). Tests: expired cache entry → `null`; expiry during the database await → `null`; ordinary sessions still cached. |
| 3. Cancellation cutoff | Fixed; verified by unit tests | Unsaved 240-hour cutoff is preserved; saved 72-hour override applies; schema and defaults allow 720 hours (minimum notice 168 hours, matching `.env` limits). |
| 4. UUID validation | Fixed; validator tests pass; endpoint test written, not yet run | The strict shared `isUuid` is used in all 10 id checks (team, discounts, customers, deposits webhook, media domain and route, blocks, jobs), not only the two in `team.ts`. Endpoint test: 36-hyphen ids sent to the team member, team invite and block delete endpoints and as a customer key → 404 without a database error. |
| 5. Traffic source shares | Fixed; verified by unit test | 100 total sessions with 80 listed produces a 20-session `Other` row and correct shares. |

## 1. Invite acceptance can overwrite a newer account role

- **Recheck:** `acceptInvite` now selects the current account `FOR UPDATE`, checks its current email, and preserves its current admin role. This addresses the stale-session calculation. PostgreSQL concurrency behavior has not been tested. A valid invite still grants its own role; this change does not invalidate outstanding invites after access removal.
- **Second recheck:** Fixed. Follow-up also fixed: `removeMember` now deletes open invites for the removed member's email in the same transaction. Lock order is invite → account in `acceptInvite` and all admins (ordered by id) → target in `removeMember`, which can't form a cycle; `withTx` now also retries deadlocks (`40P01`). Regression tests added to `test/integration/admin.test.ts` (stale cached session plus database promotion before acceptance; removal cancelling an open invite) — not yet run, pending `TEST_DATABASE_URL`.
- **Priority:** P1 (access control).
- **Location:** `stjohns-backend/src/domain/team.ts:85` (`acceptInvite`).
- **Bug:** The new role is calculated from `me.role`, captured before the transaction, rather than the current users row. A concurrent full-access promotion after authentication can therefore be overwritten by an older bookings-only invite. This defeats the explicit protection against downgrading an admin. A stale admin session can also cause an invite acceptance to restore full access after a concurrent demotion.
- **Evidence:** A temporary mocked-transaction probe confirmed that a customer session accepting a staff invite writes `staff` without reading the current users role. The concurrency consequences follow from that unconditional update; they have not been exercised against PostgreSQL.
- **Proposed fix:** Read and lock the current users row inside the transaction, then compute the role from that row. Coordinate lock order with `removeMember`, which locks admins first, and recheck current account email before granting access.
- **Verification:** Interleave a promotion/demotion with invite acceptance; assert that an existing database admin is never downgraded by an older invite and that stale session data cannot restore a revoked role.

## 2. Cached sessions remain authenticated past their expiry

- **Recheck:** The query now selects `s.expires_at`, and the cache lifetime is capped at session expiry. Both new cache tests pass. However, `sessionUser` still returns the fetched user unconditionally after the query. A session valid when PostgreSQL evaluates the query can expire before its response reaches this code.
- **Remaining reproduction:** A temporary fake-clock probe made the database return a row expiring at T+1 second after advancing the application clock to T+2 seconds. `sessionUser` returned the user despite expiry. The probe passed and was then removed because it asserted the observed bug.
- **Remaining fix:** Immediately after the query, calculate the session expiry and reject it if non-finite or `<= Date.now()`, deleting any cached entry. Only map, cache, and return a still-valid session. Add a regression test expecting `null` when expiry occurs during the database await.
- **Second recheck:** Fixed as proposed. `sessionUser` computes the expiry right after the query and returns `null` (deleting any cached entry) when it is missing, non-finite or already past; only then does it map, cache (capped at the expiry) and return the user. Regression test in `test/admin-unit.test.ts` › "rejects a session that expires while the database query is in flight" passes.
- **Priority:** P2.
- **Location:** `stjohns-backend/src/domain/users.ts:148-165` (`sessionUser`).
- **Bug:** Cache entries expire 30 seconds after lookup regardless of the database session's expiry. A token looked up just before expiry remains accepted by the server for up to roughly 30 additional seconds. Browser cookie expiry does not prevent a client from replaying the token directly.
- **Evidence:** A fake-clock probe loaded a session valid for one more second, advanced two seconds, and still received the cached user with only one database read.
- **Proposed fix:** Select `s.expires_at` and set cache expiry to `Math.min(Date.now() + CACHE_MS, sessionExpiry)`. Reject sessions already expired when populating the cache.
- **Verification:** Cache a nearly expired session, advance beyond its actual expiry, and require `null`; also verify normal sessions still benefit from caching.

## 3. Loading unsaved settings changes the environment cancellation cutoff

- **Recheck:** `applySettings` now preserves the base cutoff when booking settings are absent. Both defaults and schema now allow 720 hours. The regression test confirms a 240-hour environment value survives loading and a saved 72-hour value overrides it.
- **Priority:** P2.
- **Location:** `stjohns-backend/src/domain/site-settings.ts:129,174` (`defaultSettings`, `applySettings`).
- **Bug:** Configuration accepts `CANCEL_CUTOFF_HOURS` up to 720, but defaults clamp it to 168 and `applySettings` unconditionally writes that clamped value back. Loading settings changes the live cancellation policy even when no booking settings were saved. Booking cancellation deadlines read the mutated config.
- **Evidence:** A runtime probe called `applySettings(config, baseValues(config), {})` with a 240-hour cutoff and observed 168 hours afterwards.
- **Proposed fix:** Preserve `base.CANCEL_CUTOFF_HOURS` when `stored.booking` is absent, matching the existing max-days and lead-time handling. Reconcile dashboard limits with allowed environment values so merely saving another field does not silently shorten the policy.
- **Verification:** Test an unsaved 240-hour cutoff remains 240 and a deliberately saved cutoff overrides it.

## 4. Team ID validation accepts malformed UUIDs

- **Recheck:** Both delete functions now call `isUuid`, which enforces the 8-4-4-4-12 hexadecimal structure. Unit tests cover valid lowercase/uppercase UUIDs, 36 hyphens, misplaced hyphens, and a non-hex character. Database-backed delete endpoint tests were not run.
- **Second recheck:** The same loose pattern also existed in eight other places (discount update/pause, customer keys, the Stripe webhook booking id, media items and image files, block and job ids); all now use `isUuid`, and no `[0-9a-f-]{36}` pattern remains under `src/`. Endpoint regression added to `test/integration/admin.test.ts` (36-hyphen ids → 404 for team member, team invite and block deletes and a `user:` customer key) — not yet run, pending `TEST_DATABASE_URL`.
- **Priority:** P2.
- **Location:** `stjohns-backend/src/domain/team.ts:96,111` (`removeMember`, `revokeInvite`).
- **Bug:** `/^[0-9a-f-]{36}$/i` only checks characters and length. For example, 36 hyphens pass and reach a UUID database parameter, causing a database conversion error instead of the intended not-found response.
- **Evidence:** Static review of both guards and the UUID database columns; no live database reproduction was performed.
- **Proposed fix:** Validate the UUID structure with the project's UUID validator or a strict UUID schema before issuing queries, preserving the intended API error.
- **Verification:** Send a 36-hyphen ID and other malformed 36-character values to both delete endpoints; require the documented client error and no database query.

## 5. Traffic source shares omit sessions outside the top eight channels

- **Recheck:** Omitted sessions now populate or merge into `Other`, and the denominator includes the remainder. The new 100-total/80-listed regression test passes. The existing fixture with complete source data also continues to pass. No live Analytics API call was made.
- **Priority:** P2 (report accuracy).
- **Location:** `stjohns-backend/src/integrations/google-analytics.ts:52,140,150` (`buildRequests`, `assembleSummary`).
- **Bug:** The report requests at most eight source rows, then computes shares using only those rows. When additional channels exist, displayed percentages describe the returned subset rather than all sessions. For example, 80 returned sessions out of 100 total are presented as 100% of traffic.
- **Evidence:** Static inspection of the report limit and denominator. Existing fixtures return source rows summing to total sessions, so they cannot detect this case.
- **Proposed fix:** Use the current-period total sessions as the denominator. If the UI needs a complete breakdown, include an `Other` remainder for omitted sessions and document the share definition.
- **Verification:** Supply 100 total sessions and source rows summing to 80; require the visible source shares to sum to 80%, or 100% including an explicit 20% remainder.

## New-code review: 2026-10-21

Scope expanded to `scripts/db-setup.ts`, `scripts/create-admin.ts`, `payments/stripe.ts`, deposit jobs/webhooks, and the latest team changes. Findings 6-11 below are **open**. No application fixes were applied during this review. The earlier statement that all five findings are fixed refers only to findings 1-5, not these new findings.

### 6. Checkout retries change parameters while reusing the same idempotency key

- **Priority:** P1 (payment reliability).
- **Location:** `stjohns-backend/src/payments/stripe.ts:51,82,87`.
- **Bug:** Each worker attempt computes a fresh `expires_at`, but uses the same booking/sequence idempotency key. If Stripe creates the session and the response or subsequent database write fails, a later attempt submits different parameters for the same operation. Stripe requires matching parameters for an existing idempotency key. The application also returns its locally calculated expiry instead of the returned session's actual expiry.
- **Evidence:** A mocked-provider/fake-clock probe called the function twice for the same booking/sequence, 60 seconds apart. The key stayed identical while `expires_at` changed by 60 seconds. No live Stripe request was made. API contract: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).
- **Proposed fix:** Persist an immutable deposit-request identifier and request parameters (including amount and expiry) before contacting Stripe; reuse them on retries. Use Stripe's returned `expires_at` for the stored link. A deliberate replacement request needs a new identifier; changing the key on every retry would risk duplicate live sessions.
- **Verification:** Simulate successful provider creation followed by failed database persistence, advance the clock, and retry. Assert identical request parameters/key and storage of the provider's real expiry.
- **Fix (2026-10-22):** `createDepositLink` saves the whole request (`{idempotencyKey: "deposit:<booking>:<uuid>", params}`, expiry included) as JSON **text** in the new `bookings.deposit_checkout_request` column (migration 005) before calling Stripe, and resends it unchanged on retry. It is TEXT rather than JSONB because JSONB reorders keys, and the resend must match the original exactly; an independent review caught this. The column is cleared, by key, once the session is stored. A saved request is reused only while its expiry is more than 35 minutes ahead (Stripe needs 30; links last at most 24 h, which also keeps inside Stripe's 24 h key window). After that a new request with a new key is built. The stored link expiry is Stripe's `session.expires_at`. `StripeIdempotencyError` is now classed as permanent. Tests: unit (`stripe.test.ts`: fixed key/parameters, resend window, replay sends identical arguments and keeps Stripe's expiry, idempotency error is permanent). Database (`deposits.test.ts` › "resends the saved Checkout request after a lost reply"): the fake Stripe enforces same-key/same-parameters like Stripe, loses the first reply, and the retry 1.1 s later gets the same session and stores Stripe's expiry. Not yet run. Remaining risk: if the first reply is lost **and** the saved request goes stale before any retry (more than about 23 h), the new request can create a second session. The first expires on its own within 35 minutes, since the stale threshold guarantees that.

### 7. Checkout expiration hides authentication and permission failures

- **Priority:** P1 (stale payment links).
- **Location:** `stjohns-backend/src/payments/stripe.ts:96-106`; `src/domain/deposits.ts:37-40`.
- **Bug:** `expireDepositSession` suppresses every `PermanentProviderError`, including bad API keys and insufficient permissions. The caller then clears the local URL and reports success even though the remote Checkout session may still accept payment.
- **Evidence:** A mocked `StripeAuthenticationError` from session retrieval was swallowed and the expiration function resolved successfully.
- **Proposed fix:** Suppress only explicitly recognised already-expired/completed or missing-session outcomes. Propagate authentication, permission, and unexpected invalid-request failures so the job is visibly failed rather than marked complete.
- **Verification:** Authentication and permission failures must reject without clearing the database link; confirmed expired/completed sessions should remain safe no-ops.
- **Fix (2026-10-22):** `expireDepositSession` returns `expired`, `already-expired`, `completed` or `not-found` (the `resource_missing` code), and throws everything else. Authentication and permission errors are permanent, so the job is marked failed. Network errors are retried. If Stripe refuses the expire call because the session closed a moment earlier, it is retrieved again; only a session that is still open makes it fail. `expireDepositLink` clears the stored link only after one of those outcomes. Tests: unit (auth and permission failures reject; a network error stays retryable; each recognised outcome; the refuse-then-recheck race). Database (`deposits.test.ts` › "fails the expiry job and keeps the link when Stripe rejects the API key"). Not yet run. Related but separate: a session found `completed` here means the customer paid just before cancelling, which is finding 13 below.

### 8. Pending refunds are reported as completed, and failure events are ignored

- **Priority:** P1 (incorrect payment state and customer messages).
- **Location:** `stjohns-backend/src/domain/deposits.ts:44-71,100-163`.
- **Bug:** The refund worker marks a booking `refunded` and queues confirmation messages regardless of `refund.status`. Once a refund id is stored, subsequent jobs skip it. `refund.updated` and `refund.failed` are not handled, so a pending refund that later fails leaves the booking claiming success.
- **Evidence:** One mocked probe returned a `pending` refund and observed the `refunded` update and confirmation event. A second delivered `refund.failed` with a valid booking id and observed `ignored`. Stripe documents pending refunds and asynchronous refund updates: [refund statuses](https://support.stripe.com/questions/understanding-refund-statuses?locale=en-GB), [event types](https://docs.stripe.com/api/events/types).
- **Proposed fix:** Track the provider refund status separately from completed refund state. Send confirmation only on success; process refund update/failure events idempotently using the refund id and booking metadata. Keep pending refunds reconcilable instead of treating any refund id as completion.
- **Verification:** Exercise pending-to-succeeded and pending-to-failed events, including duplicates. Pending/failed refunds must not generate a success notification; terminal statuses must update both payment and booking records consistently.
- **Fix (2026-10-22):** New `bookings.deposit_refund_status` (`requested`, `pending`, `requires_action`, `succeeded`, `failed`, `canceled`; migration 005 backfills earlier refunds as `succeeded`).
  - **When the deposit counts as refunded:** `deposit_status` only becomes `refunded`, and the customer only gets the "refunded" email/SMS, when Stripe reports **succeeded**. Each refund is kept in `payments` by its Stripe id and current status. The booking follows all of them together (any success wins, then any still in progress, else failed). So late, duplicate or out-of-order events (an old failed refund after a newer successful one) settle on the same answer. `decideRefund` and `overallRefundStatus` are pure and unit-tested.
  - **Webhooks:** `refund.created`, `refund.updated`, `refund.failed` and `charge.refund.updated` are handled. A dashboard refund carries no metadata, so its booking is found by payment intent; it is mirrored without messaging the customer. `charge.refunded` now acts only when no refund is tracked. The job marks the booking `requested` before calling Stripe, so its own `charge.refunded` isn't mistaken for a dashboard refund.
  - **Pending refunds:** while a refund is pending, the worker re-checks it with Stripe after 30 minutes and then every 6 hours, for about 10 days, so it settles even if the webhook is lost.
  - **Failures:** a failed refund (even after succeeding, which Stripe allows) puts the deposit back to `paid`, adds a `deposit_refund_failed` event, and emails/texts the owner a link to the payment in Stripe. The same happens when the refund job fails for good: Stripe refused the refund (a permanent error such as a disputed payment), or the worker gave up after repeated transient errors (`refundGaveUp`, called from the worker). So the booking never sticks on `requested`. Retrying from the dashboard uses a new key, `refund:<pi>:retry:<n>`, counted from earlier failures. Retries of one attempt keep their key, so they can't refund twice.
  - **Partial refunds:** a refund we didn't start that is smaller than the deposit paid (a partial refund in the Stripe dashboard) is ignored and doesn't mark the deposit refunded, matching the old `charge.refunded` behaviour.
  - **Admin flow:** "Refund deposit" (with Stripe on) records `deposit_refund_requested` and leaves the deposit `paid`. A second request gets 409 while Stripe has the refund, or while it's `requested` and its job is still queued or running. The dashboard shows "refund requested/in progress/failed", hides the button while in progress, and offers "Try the refund again" after a failure.
  - **Setup needed:** add `refund.created`, `refund.updated` and `refund.failed` to the Stripe webhook endpoint (README step 9). Without them the worker's follow-up checks still settle refunds, just later.
  - **Tests:** unit (statuses, keys, `already-refunded`, every `decideRefund` transition, owner alert templates). Database (`deposits.test.ts`): pending → webhook succeeded (customer told once, duplicate ignored, follow-up check is a no-op); pending with no webhook → worker check settles it; pending → failed → owner alerted → retry with a new key succeeds → late failure ignored; Stripe refuses → failed and retryable; worker gives up after transient errors → failed and retryable; partial dashboard refund ignored; full dashboard refund mirrored silently. Not yet run.

### 9. Admin password replacement leaves old sessions valid

- **Priority:** P1 (account access).
- **Location:** `stjohns-backend/src/scripts/create-admin.ts:107-116`.
- **Bug:** Updating an existing account's password and promoting it to admin leaves every existing session intact. Someone holding an old session can retain access after the password change and receive admin privileges when their cached customer role refreshes. The normal password-reset flow already deletes sessions, but this script does not.
- **Evidence:** A mocked execution of the actual script, with an existing account and `ADMIN_PASSWORD`, performed the password/role update and no session deletion. No actual credentials or database were used.
- **Proposed fix:** Update the account and revoke its sessions atomically when changing its password or granting admin access. Account for the running API's process-local session cache so revocation applies across the script/API process boundary; calling a cache-clear helper in the script alone is insufficient.
- **Verification:** Create a session before promotion/password replacement, run the operation, then assert the old token cannot authenticate or gain admin privileges; a fresh login must work.
- **Fix (2026-10-22):** New `grantAdmin(db, userId, passwordHash)` in `users.ts`, used by the script. In one transaction it locks the account, sets the role and password, and deletes all its sessions whenever the account gains admin access or a new password. Re-running for an existing admin without a new password changes nothing. The script prints how many sessions were signed out.
  - **Across processes:** `sessionUser` no longer caches staff or admin sessions, so every dashboard request checks the database. A session revoked by the script, or by another API instance's `removeMember` or password reset, stops working on the next request.
  - **Customer sessions:** these are still cached for up to 30 s. An old customer session can therefore keep *customer-level* access that long in a running API after the script runs. Once that entry expires, the deleted session fails to load, so it never picks up the admin role.
  - **Tests:** unit (`admin-unit.test.ts`: staff and admin lookups always hit the database). Database (`admin.test.ts` › "signs an account out everywhere when create-admin promotes it…": the old session is null and can't reach admin, the old password is rejected, the new login works, a re-run revokes nothing; › "stops a staff session at once when another process revokes it"). Not yet run.

### 10. Failed database setup does not close its connection pool

- **Priority:** P2 (setup reliability).
- **Location:** `stjohns-backend/src/scripts/db-setup.ts:63-92`.
- **Bug:** `pool.end()` runs only on the success path. Migration or diagnostic-query failure goes directly to the outer catch, leaving an allocated pool and potentially live connections until idle cleanup. The command can linger after printing its failure.
- **Evidence:** A mocked execution of the actual setup script made `migrate` throw. The script set exit code 1 but never called `pool.end()`. No database was contacted; the test verifies missing cleanup, not an actual elapsed hang duration.
- **Proposed fix:** Put all operations after pool construction inside `try/finally` and always await `pool.end()`, preserving the original error for reporting.
- **Verification:** Inject migration and diagnostic-query failures; require pool cleanup and a failing exit code on both paths.
- **Fix (2026-10-22):** Everything after pool creation is inside `try/finally`, which always awaits `pool.end()` (its own failure is swallowed so it can't hide the original error). The outer `catch` still prints the explanation and sets exit code 1. Verified by typecheck and reading only; no test injects the failure.

### 11. Invite removal introduces opposite row-lock ordering

- **Priority:** P2 (concurrent team operations).
- **Location:** `stjohns-backend/src/domain/team.ts:76,83,105-112`.
- **Bug:** The earlier claim in this report that the lock order cannot cycle is no longer correct with invite deletion included. Acceptance locks an invite then its user. Removal locks users then deletes their open invites, which can wait for that invite lock. Acceptance can wait for removal's user lock while removal waits for acceptance's invite lock.
- **Evidence:** Static lock-order analysis, not a live PostgreSQL reproduction. The existing `40P01` transaction retry mitigates a detected deadlock but does not prevent it or guarantee success after bounded retries.
- **Proposed fix:** Establish consistent lock ordering across invite acceptance and removal, retaining current-role and invite-validity checks after obtaining locks. Correct the conflicting source comments when implementing it.
- **Verification:** Use two database connections and barriers: acceptance holds the invite, removal holds the user, then let both continue. Verify the final implementation completes without a deadlock and cannot restore removed access.
- **Fix (2026-10-22):** `acceptInvite` now locks the account row first and reads and locks the invite afterwards. That is the same users-before-invites order as `removeMember` (admins in id order, then the target, then the invite delete). An acceptance waiting behind a removal holds no invite lock, and then finds the invite deleted. `register()` with an invite token locks only the invite and inserts a new user row, so it can't form a cycle. The source comments are corrected.
  - **Test:** database (`admin.test.ts` › "lets an invite acceptance queue behind a removal instead of deadlocking with it"). A second connection runs `removeMember`'s statements and pauses holding the user rows, while the API accepts the invite. The test asserts the acceptance is waiting on a lock, holds no lock on `team_invites` (from `pg_locks`; the old order would show a RowShareLock), and that the removal then deletes the invite and commits without waiting. The acceptance returns 400 and the account stays a customer. Not yet run.

### Validation after fixing 6-11 (2026-10-22)

- `npx tsc --noEmit` and the build config (`tsconfig.build.json`): passed.
- An independent review of the diff traced the new database tests and SQL by hand. It found three problems, all fixed: JSONB reordering the saved request's keys; a refund that could stick on `requested` after the worker gave up; partial dashboard refunds marking the deposit refunded.
- `npx vitest run`: **68 passed, 53 skipped**. The 53 are the three database integration files, which skip without `TEST_DATABASE_URL`. They include the new tests for findings 6-9 and 11 and migration 005; **run `npm.cmd test` with `TEST_DATABASE_URL` set to the Neon dev branch to execute them.**
- The new session-cache unit test was checked against the previous `users.ts`: it fails there and passes with the fix.
- Deploy order: apply migration 005 (`npm run migrate:prod` / `db:setup`) before starting the new API; add the three `refund.*` webhook events in Stripe.
- No production database, live Stripe call or real notification was used.

### Validation at the 2026-10-21 review

- `npm.cmd run typecheck`: passed.
- `npm.cmd test`: **52 passed, 42 skipped** (three database integration files). This confirms the latest session-expiry regression also passes.
- Six additional temporary diagnostic tests passed: Checkout retry parameters, swallowed expiration authentication error, pending refund state, ignored refund-failure webhook, admin-script session retention, and setup-script pool cleanup. They reproduce current bugs rather than assert desired behavior and were removed after this review. They are not included in the 52-test suite count.
- No database setup/migration, real account changes, live Checkout/refund operations, or external notifications were performed. PostgreSQL integration and concurrency behavior remain unverified.

## Earlier validation history

- `npm.cmd run typecheck`: passed.
- `npm.cmd test` (recheck): 51 passed, 42 skipped across three database integration test files. Database-backed behavior remains unverified.
- Initial review: three temporary Vitest probes reproduced the original findings 1-3. All three passed and were removed after review because they asserted buggy behavior.
- Recheck: one additional temporary Vitest probe reproduced the remaining in-flight session-expiry edge case; it passed and was removed. It is separate from the 51-test suite result above.
- PowerShell blocked the `npm.ps1` launcher; using `npm.cmd` ran checks without changing system policy.
- Second recheck: `npx tsc --noEmit` passed; `npx vitest run`: 52 passed (now including the in-flight session-expiry regression), 42 skipped. The 42 skipped are the three database integration files (`api`, `deposits`, `admin`), which skip until `TEST_DATABASE_URL` points at a Neon dev branch; database-backed behavior, including the regressions for findings 1 and 4, remains unverified until they run.
