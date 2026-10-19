# Website Leads — release readiness, staging gate and controlled-release plan

Date: 19 October 2026 · Branch `development` @ `db3bb44` (= `origin/development`) + 42 uncommitted paths · Nothing committed, pushed, merged or deployed
Follows: `…-website-leads-verification-report.md`

## A. Executive summary

| | |
| --- | --- |
| Branch / commit | `development` @ `db3bb44`. Production runs `main` @ `b90353f` (PR #6, both services, deployed 17 Oct 15:47 UTC); its file tree is **identical** to `db3bb44` |
| Release candidate | `db3bb44` + 36 explicit files (section B). Verified in an isolated checkout with its own dependencies and a clean environment |
| Technical readiness | Code, tests, builds, rollback security: **verified locally**. Deployed-environment evidence: **none yet** |
| Deployment authorization | **None given.** No staging or production action was taken |

**TECHNICAL RELEASE STATUS: NO-GO** (reasons: no staging end-to-end run exists, and two production checks that need production data access have not been run; both are blocked by access and approval, not by code).

What moved in this pass: the last test blockers are explained and cleared (full suite **0 failures**), a **rollback exposure was found and closed**, the production configuration was read (names and non-secret facts only), and the release path and previous release were identified.

## B. Git and release scope

- Clean state at start: nothing staged; `git diff --check` reports only line-ending notices.
- **Release set (36 files)**, byte-identical to the verified candidate:
  - API: `website-form.routes.ts`, `website-form.service.ts`, `website-intake-rejections.ts` (new), `connector.routes.ts`, `connector.service.ts`, `hub-catalogue.ts`, `hub-state.ts`, `hub.routes.ts`, `hub.service.ts`, `website-leads-rules.ts` (new), `website-leads.service.ts` (new), `website-intake-audit.ts` (new), `scripts/audit-website-intake.ts` (new), `package.json` (one script), `.env.example` (comments).
  - Shared: `packages/types/src/index.ts`, `packages/api-client/src/index.ts`.
  - Web: `WebsiteLeadsPanel.tsx` (new), `websiteLeadsDocs.ts` (new), `IntegrationDetailSheet.tsx`, `IntegrationCardView.tsx`.
  - Tests: 5 new or extended Website Leads files, plus 5 updated pre-existing files (section C).
  - Docs: `NAMOKAR_WEBSITE_INTAKE.md`, two audit reports (and this one).
  - No migration, no schema change, no dependency change.
- **Excluded (not mine; left untouched):** `apps/api/src/domain/ads/google-ads.ts` and `apps/api/src/__tests__/ads.test.ts` (Google Ads API v26, **and it now also ignores the per-tenant `apiVersion` setting**: a behaviour change belonging to someone else), `apps/web/.env.example` (deleted), `apps/web/app/globals.css` and `layout.tsx` (Inter font removal), `docs/website-leads-webhook-integration-report.md`.
- Other integrations: the diff touches no Runo, CCS adapter, WhatsNexus, Google or Meta Ads, outbound-webhook, patient-identity, appointment or follow-up source. The only shared-code edits are `touchConnectorError` (a `DISABLED` connector stays disabled) and the connector `PATCH` route (refuses writes to the website connector's typed settings), both covered by tests.
- Risks to handle at commit time: commit by **explicit paths**, never `git add -A` (the working tree holds the unrelated changes above); five pre-existing test files changed and deserve the release owner's eye (section C).

## C. Test results

All run against a throwaway local PostgreSQL 16 (loopback, own port), in **isolated checkouts with their own installed dependencies and a clean environment** (throwaway secrets, no `.env`). This corrects the earlier limitation where the baseline still resolved shared packages from the live tree.

| Run | Result |
| --- | --- |
| **Baseline**: clean `HEAD`, full API suite | 155 files; 1700 tests: **1680 passed, 6 failed**, 14 skipped |
| **Candidate**: `HEAD` + release set, full API suite | 159 files; 1760 tests: **1746 passed, 0 failed**, 14 skipped |
| Candidate web: `vitest` / `eslint` / `tsc --noEmit` | 53 files, **414 passed** / clean / clean |
| Candidate API: `tsc --noEmit` and `tsc -p tsconfig.json` (build) | clean; `dist/server.js` produced |
| Candidate web: `next build` | **exit 0**, 22 routes incl. `/integrations`. (Needed a 3 GB Node heap on this machine; the default heap ran out.) |
| API `eslint src` | 3 errors, 2 warnings, **all in lines committed by others** (`connector/adapters/ccs.ts:53`, `integration/hub.service.ts:191`, seed file) |
| Real browser, final code (Chrome → proxy → candidate API → database) | 2/2 passed |
| Rollback drill (old API vs new data) | 18/18 passed (section G) |

### The eight earlier failures

| Failing test | Root cause | Pre-existing? | Fix | Final |
| --- | --- | --- | --- | --- |
| `capabilities.test.ts` | CCS IVR became a V1 default (commit `fb5bfdf`, 5 Oct); the test still expects it off | Yes (fails on clean `HEAD`) | Test expectation updated | Pass |
| `capabilities.integration.test.ts` | CCS IVR is now an operational capability an Admin may switch | Yes | Expected list gains `CCS_IVR` | Pass |
| `edition-access.integration.test.ts` | V1 bundle now includes `CCS_IVR` | Yes | Expected list updated | Pass |
| `notifications.integration.test.ts` (reschedule) | A reschedule now queues an immediate **change notice** (commits of 12–13 Oct); the planner's minimum-gap rule then drops a second immediate confirmation, so 3 rows follow, not 4 | Yes | Expectation 4 → 3, with the reason in a comment | Pass |
| `notification-reconcile.integration.test.ts` | Same feature: after a reschedule there is one extra pending row (the change notice) | Yes | Expectations updated (4 rows; 3 old cancelled + 1 notice) | Pass |
| `tenant-branding…`, `signup…` (session cookie) | `COOKIE_SAMESITE=none` in the local env file (correct for web and API on different domains); the tests assume the default `lax` | **Not a defect: environment.** Pass in a clean environment on `HEAD` | None | Pass |
| `whatsnexus-provider-matrix` (full run only) | Counts sends across the whole database; the two aborted notification tests left due rows behind | Yes (reproduced on clean `HEAD`; passes alone) | None needed; passes in the candidate full run once the two tests above pass | Pass |

None of these affects Website Leads. The five test updates follow intentional, committed product behaviour (not changes to behaviour), but they are other people's tests: **release owner to confirm** (they can be split into their own commit).

## D. Staging verification

**Staging end-to-end: NOT VERIFIED. No staging environment exists.**

- Railway project `prolific-integrity` (the PulseOS one) has **one environment: `production`** (services `@pulseos/api`, `@pulseos/web`, `Postgres`). A second project, `remarkable-success`, has the same service names, also as "production"; its purpose is unknown and it was **not assumed to be staging** and not touched.
- No CI workflow, Dockerfile or Railway config file is in the repository: deployment is configured on the hosting side. Services deploy from the **`main`** branch when a pull request is merged (PRs #4, #5, #6); **API and web deploy together from the same commit**.
- **Checkpoint A (staging deployment): not requested yet, nothing deployed.** Staging plan (needs your approval and an environment you choose):
  1. A separate Railway environment (or project) with its **own Postgres**, its **own `CONNECTOR_ENCRYPTION_KEY` and `SESSION_SECRET`** (do **not** use "duplicate production", which would copy production's keys), deploying from `development` or a `staging` branch, `COOKIE_SAMESITE=none`, `NODE_ENV=production`, `TRUST_PROXY=1`, `PUBLIC_API_BASE_URL` = its own API origin, `WEB_ORIGIN` = its own web origin only, web `NEXT_PUBLIC_API_URL` = its API.
  2. Migrate, seed fictional data, create a Super Admin test account.
  3. Run section D's scenarios from a server outside the platform against the HTTPS API.

| Stage (to verify on staging) | Status |
| --- | --- |
| Public HTTPS routing of the intake URL | NOT VERIFIED on staging. **Production routing was probed read-only:** `POST /forms/website/<unknown id>` on the public API origin answers `404 {"error":"not_found"}` (route reachable, no write) |
| Website form setup in the real UI, token, HTTP submission, patient, journey, attribution, timeline, task, idempotency, connector activity | NOT VERIFIED on staging. **PASS on the local equivalent** (real Chrome, real API and database): see the earlier reports and the final run in section C |
| Rate limit behind the real proxy, forged forwarding headers | NOT VERIFIED on staging. PASS locally (hardening suite) |

## E. Security verification

| Check | Result |
| --- | --- |
| Token encrypted at rest, shown once, never returned, never in logs, DOM or caches | PASS (suites + browser) |
| Rotation (old token dead at once; concurrent rotations leave one) | PASS |
| Tenant isolation, role enforcement on the server | PASS |
| Origin allow-list (https, no path, no `*`), not authentication | PASS |
| Proxy-header spoof resistance | PASS locally (default trusts nobody). **Production has `TRUST_PROXY=1`; behaviour behind the real Railway proxy is unverified** |
| Validation, rate limit, rejection visibility (sanitized, bounded) | PASS |
| Secret redaction in responses, events, Activity | PASS |
| **Rollback exposure** (new) | Found and closed, section G |
| Hygiene finding | The developer's local `apps/api/.env` holds the **production** `CONNECTOR_ENCRYPTION_KEY` and `SESSION_SECRET` (fingerprints match), plus a database tunnel. Not a release defect; keep that file out of anything shared, and treat the machine accordingly |

## F. Configuration verification (production, read-only; values never shown)

Source: Railway CLI (logged in, linked to `prolific-integrity` / `production`); variables filtered so only names and non-secret facts were printed. Fingerprints are truncated hashes.

| Variable (service) | Present | Format | Action | Risk if wrong |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` (api) | Yes | Valid; private-network host | None | Outage |
| `CONNECTOR_ENCRYPTION_KEY` (api) | Yes (fp `239f854f`) | n/a | **None. Never rotate or regenerate.** This release changes no variable | Stored connector secrets (including tokens) unreadable |
| `SESSION_SECRET` (api) | Yes (fp `6c429dce`) | n/a | None | Everyone signed out |
| `WEB_ORIGIN` (api) | Yes: custom domain, Railway web origin, **and `http://localhost:3310`** | Valid list (the deployed code supports a list; production already echoes the caller's origin with `Vary: Origin`) | **Checkpoint B (recommended):** remove `http://localhost:3310` from production | A page served on someone's `localhost:3310` is treated as an allowed web origin (credentialed `SameSite=None` cookies) |
| `PUBLIC_API_BASE_URL` (api) | Yes | **Valid**: https, public host, no trailing slash, not local/internal | None | Wrong address shown to developers |
| `TRUST_PROXY` (api) | Yes, `1` | Valid | Confirm on staging | `1` is right for one reverse proxy; wrong count = shared or spoofable rate-limit identity |
| `FORM_INTAKE_MAX_PER_MINUTE` (api) | No | n/a | None (default 20) | n/a |
| `NODE_ENV` (api, web) | `production` | Valid | None | n/a |
| `PORT` | api `4310`, web `8080` | Valid | None | n/a |
| `COOKIE_SAMESITE` (api) | `none` | Valid for web and API on different domains | None | n/a |
| `ENABLE_DEV_LOGIN`, `DEMO_PASSWORD` (api) | **Absent** | Correct for production | None | n/a |
| `NEXT_PUBLIC_API_URL` (web) | Yes, same API origin | Valid | None (baked in at build) | Web calls the wrong API |

Not accessible / not verified: whether every **stored production secret decrypts** with this key (needs database access: use `pnpm audit:website-intake` from an operator shell on the API service); the Railway edge's actual proxy hop count; any firewall or edge-level rate limiting.

## G. Rollback verification

**ROLLBACK SECURITY: PASS** (local drill against the exact previous release; staging drill and production audit not yet performed).

- **Previous release:** `main` @ `b90353f` (deployed), file-identical to `db3bb44`. It does **not** read `requireToken`.
- **The exposure (confirmed):** the earlier design saved a Hub form with no token as an ordinary "enabled" connector. The previous release treats any status except `DISABLED` as open and enforces a token only if one exists, so rolling back would have accepted **anonymous submissions** on every Hub-saved form without a token. The drill reproduced it as a control (status 200).
- **The fix (smallest, no change to other integrations):** a Hub-managed form with no token is stored **`DISABLED`** (`connectorStatusFor`); the admin's own on/off choice moves to a separate `formEnabled` setting so the screen still reads "enabled, waiting for a token". The previous release then refuses it too. Creating a token opens it (verification restarts); switching off survives token changes.
- **Drill (new API creates state, previous API serves it, same database):** tokenless form refused by the old API (403); guessed token refused; old API enforces the token once one exists and **decrypts what the new API stored** (key continuity across versions, 200 with the right token, 401 without or wrong); the pre-rollback audit lists a tokenless enabled form and does not list protected or held-closed ones; it also reports every stored secret decryptable (21/21 in the drill database) and prints only ids and kinds. **18/18.**
- **Tool:** `pnpm audit:website-intake` (read-only; exit 1 means act). It also found 2 tokenless enabled intakes in the **demo seed**, which is expected for demo data.
- Remaining: run the audit against **production** before any rollback (and once before release) and the **staging rollback drill**.
- Note: connectors that existed before this feature and have no token (for example demo seeds) behave exactly as before, in both versions; the audit lists them.

## H. Existing integrations regression

The candidate's full suite (158 files, 1746 tests, 0 failures) includes: Runo (webhook, endpoints), CCS IVR, WhatsNexus (adapter, callbacks, provider matrix, templates), Google and Meta Ads (unit and integration, with the other developer's v26 change present in the live tree but **not** in the candidate), outbound webhooks, patients, journeys, appointments, follow-ups, calls, lead intake, campaigns, connector retry, Integration Hub. All **PASS**. Not exercised against real providers or real data.

## I. Files changed during this task

- `apps/api/src/domain/integration/website-leads-rules.ts`: `connectorStatusFor`, `formEnabled`.
- `…/website-leads.service.ts`: connectors start `DISABLED`; status follows the rule on save and token creation.
- `…/hub-state.ts`, `…/hub.service.ts`: "enabled" reads the admin's choice; status check explains "no token yet".
- `…/website-intake-audit.ts` (new), `apps/api/src/scripts/audit-website-intake.ts` (new), `apps/api/package.json` (`audit:website-intake`).
- `apps/web/components/integrations/websiteLeadsDocs.ts`: 403 text now mentions "no token yet".
- Tests: `website-leads-rules.test.ts` (+4), `website-leads-hardening.integration.test.ts` (+2), `website-intake-audit.integration.test.ts` (new, 2); updated stale expectations in `capabilities.test.ts`, `capabilities.integration.test.ts`, `edition-access.integration.test.ts`, `notifications.integration.test.ts`, `notification-reconcile.integration.test.ts`.
- This report. Temporary checkouts, scratch scripts, databases and servers were removed or stopped.

## J. Remaining blockers

| # | Sev | Evidence | Required action | Owner / access | Approval |
| --- | --- | --- | --- | --- | --- |
| 1 | **P1** | No staging environment; the only Railway environment is `production` | Create an isolated staging, deploy, run the full external end-to-end (section D) and the rollback drill there | You: choose and authorize the environment (Checkpoint A) | **Pending** |
| 2 | **P1** | Production secrets' decryptability and open-intake audit not run (needs production database access) | Run `pnpm audit:website-intake` read-only from an operator shell on the API service; expect exit 0 apart from any known legacy connectors | Operator with Railway shell access | Pending |
| 3 | P2 | `WEB_ORIGIN` in production includes `http://localhost:3310` | Remove that entry | Operator (Checkpoint B) | Pending |
| 4 | P2 | `TRUST_PROXY=1` unverified behind the real proxy | Verify on staging with forged headers and two client addresses | Staging | Pending |
| 5 | P2 | Five pre-existing tests were updated | Release owner reviews (separate commit if preferred) | Release owner | Pending |
| 6 | P2 | The other developer's Google Ads change is uncommitted and drops per-tenant `apiVersion` | Resolve separately; excluded from this release | Its author | n/a |
| 7 | P3 | Local `.env` holds production keys; `next build` needs ~3 GB heap locally | Hygiene; confirm the Railway build has enough memory (it builds today) | Developer | n/a |
| 8 | P3 | 3 pre-existing lint errors; 429 refusals not recorded in Activity; limiter is per process | Track separately | n/a | n/a |

## K. Production deployment runbook (not executed)

Facts this plan rests on: Railway deploys **both services from `main` on merge**; there is no CI; deployments are listed with `railway deployment list`; the currently deployed commit is `b90353f`; older deployments show as removed, so a rollback is a **revert on `main`**, not a redeploy of an old build.

**Before (needs Checkpoints A, B and C):**
1. Staging end-to-end and staging rollback drill pass.
2. Remove `http://localhost:3310` from production `WEB_ORIGIN` (Checkpoint B). No other variable changes; never touch `CONNECTOR_ENCRYPTION_KEY`.
3. Run `pnpm audit:website-intake` against production (read-only) and keep the output (ids only).
4. Confirm a database backup/restore point exists (no migration in this release).
5. Commit **the 36 release files by explicit path** on a branch; PR to `development`; PR `development` → `main`.

**Deploy (merge to `main`):** both services build and roll out together (no ordering is possible; the old web works with the new API and the new web simply lacks the card on the old API, so the short mismatch is harmless).
1. Watch `railway deployment list --service "@pulseos/api"` and `"@pulseos/web"` until both show SUCCESS on the new commit.
2. `GET /health` → 200; Integration Hub loads; existing integration cards unchanged; deployment logs show no decryption or authentication errors.
3. Read-only smoke as a Super Admin: Integrations → Ads & Attribution → Website Leads (card visible; address shown; token controls Super Admin only).
4. Only with explicit authorization and an internal test tenant: configure, create a token, send **one** synthetic lead from a server, confirm patient, journey, task, Healthy and Activity. Creating a lead sends nothing to anyone.

**Monitor (first day):** API 5xx; Integration Activity for "submission rejected" and failures; connector health of Runo, CCS and WhatsNexus; duplicate leads or tasks.

## L. Rollback runbook (not executed)

**Triggers:** anonymous intake accepted; cross-tenant access; credential-decryption errors; widespread lead-ingestion failures; patient or journey corruption; duplicate task creation; a serious regression in an existing integration.
**Steps:**
1. **Contain first:** in the Hub switch Website Leads off (or set the connector `DISABLED`). With this release a form with no token is already held closed.
2. Run `pnpm audit:website-intake`; it must list nothing the team did not already know about. Check the key still opens every secret (its `secrets.failed` must be empty).
3. Revert the merge on `main` (a revert PR); Railway redeploys both services from `main`.
4. Verify both deployments SUCCESS, `/health`, sign-in, Integrations, Runo/CCS/WhatsNexus health; a tokenless Hub form stays refused (403), a tokened one needs its token.
5. Record the incident (time, trigger, audit output). There is no database change to undo.
Do **not** redeploy an older build blindly: only the current `b90353f` is retained, and it is the version the drill proved safe **only because** forms are held `DISABLED` until a token exists.

## Final release verdict

**TECHNICAL RELEASE STATUS: NO-GO**
**PRODUCTION DEPLOYMENT: NOT AUTHORIZED**
**STAGING E2E: NOT VERIFIED**
**ROLLBACK SECURITY: PASS** (local drill; staging drill and production audit pending)
**REMAINING P0: 0**
**REMAINING P1: 2** (no staging end-to-end; production audit and decryptability check not yet run)

Becomes **GO** when: staging end-to-end and rollback drill pass; the production audit is clean; `TRUST_PROXY` behaviour is confirmed; production `WEB_ORIGIN` is tidied; and the release owner explicitly authorizes the release. GO would still not authorize executing the deployment.
