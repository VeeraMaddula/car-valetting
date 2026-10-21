# Bugs and proposed fixes

Reviewed: 2026-10-21. Scope: the five backend files open in the IDE and their immediate callers, schemas, and tests. This is an initial review, not a full repository audit.

Rechecked: 2026-10-21 against the current workspace. All five findings now have implementation changes. Findings 1, 3, 4, and 5 are addressed in code; finding 2 is partially addressed with one reproduced edge case remaining. This recheck changed this report only; existing application changes were preserved. Original bug descriptions below describe the pre-fix behavior.

Second recheck and fixes: 2026-10-21. **All five findings are fixed in code.** The remaining finding-2 edge case is fixed and covered by a unit test. A follow-up from the first recheck (open invites surviving access removal) is also fixed. Unit-level regressions pass. The database-backed regression tests for findings 1 and 4 are written in `stjohns-backend/test/integration/admin.test.ts` but **have not run yet**: they need `TEST_DATABASE_URL` (a Neon dev branch) in `.env`.

| Finding | Status | Evidence |
| --- | --- | --- |
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

## Validation performed

- `npm.cmd run typecheck`: passed.
- `npm.cmd test` (recheck): 51 passed, 42 skipped across three database integration test files. Database-backed behavior remains unverified.
- Initial review: three temporary Vitest probes reproduced the original findings 1-3. All three passed and were removed after review because they asserted buggy behavior.
- Recheck: one additional temporary Vitest probe reproduced the remaining in-flight session-expiry edge case; it passed and was removed. It is separate from the 51-test suite result above.
- PowerShell blocked the `npm.ps1` launcher; using `npm.cmd` ran checks without changing system policy.
- Second recheck: `npx tsc --noEmit` passed; `npx vitest run`: 52 passed (now including the in-flight session-expiry regression), 42 skipped. The 42 skipped are the three database integration files (`api`, `deposits`, `admin`), which skip until `TEST_DATABASE_URL` points at a Neon dev branch; database-backed behavior, including the regressions for findings 1 and 4, remains unverified until they run.
