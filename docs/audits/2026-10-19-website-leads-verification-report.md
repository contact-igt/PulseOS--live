# Website Leads — post-implementation verification, hardening and readiness

Date: 19 October 2026 · Branch `development` @ `db3bb44` + uncommitted work (nothing committed, pushed or deployed)
Follows: `2026-10-19-pulseos-website-leads-implementation-audit.md`

**Revision 2 (same day, 19:00).** Re-verified on the current working tree after the earlier report. Nothing in the Website Leads code changed; the re-run is green, and two files changed by someone else (a Google Ads API version bump) were noticed, classified as unrelated and included in the regression run. The conclusions below are unchanged. Counts in section H are the latest.

## A. Executive verdict

**BLOCKED for production. Ready for staging.**

The previous blocker is closed: the database-backed suites now run and pass on a disposable PostgreSQL, a real browser was driven against a real API and database, and the verification found and fixed **eight defects** (none P0, two P2) that unit tests and mocks had not shown. Production is blocked only by items that need people or environments this session did not have: a staging end-to-end run through the real deployment, confirmation of the production configuration (`PUBLIC_API_BASE_URL`, `TRUST_PROXY`), and triage of seven pre-existing test failures that are unrelated to this feature.

## B. Verification matrix

| Area | Previous state | Current verified state | Evidence |
| --- | --- | --- | --- |
| No migration needed | Claimed | **Confirmed.** `src/db/migrations` unchanged; all 50 existing migrations apply cleanly to an empty database | `git status` on `src/db`; `pnpm db:migrate` on disposable DB |
| Catalogue / connector | Claimed | One `website_form` connector per tenant, type `ACQUISITION`, capability `RECEIVE_FORM`; unique (tenant, provider) holds; generic configure refused with `409 use_website_form_endpoint` | `website-leads-hub` (14), `integration-hub` (11) |
| Routes and authorization | Claimed | PUT form: Admin and Super Admin; POST token: Super Admin only (API 403 for Admin); status check read-only; strict body (tenant id rejected) | hub + hardening suites; browser run |
| Typed configuration | Claimed | Booleans and arrays persist as such; **generic `PATCH /connectors/:id` could bypass this: fixed** | hardening test (was red, now green) |
| Token handling | Claimed | Stored encrypted; returned once with `no-store`; never in detail, list, logs, activity log or DOM after dismissal; old token rejected at once; 6 concurrent replacements leave exactly one working token; token in query string refused | hub + hardening suites; browser run |
| Tenant isolation | Claimed | Other hospital cannot read, patch, rotate or see events; its token does not open mine; unknown, malformed and foreign ids all give the same 404 | hardening suite |
| Rate limit and proxy | Not tested | Forged `X-Forwarded-For`, `Forwarded`, `X-Real-IP` do not change the limit (`TRUST_PROXY` unset = trust nobody) | hardening test |
| Ingestion pipeline | Reused | **Was not atomic: fixed for this source.** Failure leaves nothing; retry creates one patient, journey, task | hardening test (was red) |
| Idempotency / duplicates | Existing | Same `submissionId` is a no-op; same phone reuses patient and journey | existing suites + hub suite |
| Status honesty | Claimed | **Seeded or stale "connected" flag showed "Receiving submissions · Never": fixed.** Healthy now requires a real accepted submission; error never re-enables a disabled form | state unit tests; hardening; browser |
| Public address | Claimed | **Trailing slashes, scheme-less and production-unset values mis-handled: fixed.** Production without a valid origin shows a clear banner and no address | unit tests; hardening; browser |
| Rejected requests | Invisible | Auth, origin, validation and disabled rejections appear in Activity: fixed wording only, one per kind per connector per minute, unknown ids write nothing, health untouched | hardening; browser screenshot |
| Escape layering | Defect noted | Confirm dialog and API dialog close alone; sheet stays; focus returns to the opener | real browser run |
| Browser UI (real API) | Mock only | Desktop and 390px phone width, keyboard Tab trap and Escape, Admin vs Super Admin | Chrome run (temporary spec, removed) |
| Regression | Baseline numbers | Web 414/414; API full suite 1730 pass, 8 fail, all 8 explained (section H) | commands in section H |
| Staging end-to-end | Not done | **NOT VERIFIED** (no staging environment available) | n/a |

## C. Confirmed bugs

| # | Sev | Where | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | P2 | `acquisition/website-form.service.ts` `processWebsiteFormSubmission` | Shared pipeline writes patient, journey, timeline, task, touchpoint without a transaction. A failure part-way left a half-made lead; the retry reused the journey so the follow-up task could never be created and timeline rows duplicated | Website path wraps the call in `db.transaction` (repo's existing `tx as unknown as Db` pattern). Shared pipeline and other lead sources untouched; no external side effects inside it (checked) | "a failed ingestion leaves nothing behind… retry creates exactly one patient, journey and follow-up task" |
| 2 | P2 | `integration/hub-state.ts`, `hub.service.ts` `card()` | A connector flagged `CONNECTED` (seed, stale) with no accepted submission was shown Healthy, Connected, "Receiving submissions · Never" | Verified = `CONNECTED` **and** a real last-event time; otherwise judged "waiting for first submission". Status check uses the same rule | 2 state unit tests; browser run (was visible there) |
| 3 | P3 | `connector/connector.service.ts` `touchConnectorError` | Forced `ERROR` even on a `DISABLED` connector: a failure from a request in flight at disable time re-enabled the form | `CASE` keeps `DISABLED` (mirrors `touchConnectorSuccess`) | "status follows the latest real outcome… never re-enables a disabled form" |
| 4 | P3 | `connector/connector.routes.ts` `PATCH /connectors/:id` | Any Admin could merge arbitrary configuration into the website connector (`requireService:"true"`, `allowedOrigins:"x"`, `requireToken:false`), skipping validation; the intake silently ignores malformed values | `configuration` writes to a `website_form` connector return `409 use_website_form_endpoint`. The intake token (secret) still follows the existing Super-Admin-only rule | "the generic connector PATCH cannot write the typed website settings…" (was 200, now 409) |
| 5 | P3 | `integration/hub.service.ts`, new `resolvePublicApiBase` | Trailing `///` kept; production with no value showed a relative path; a scheme-less value shown as an address | One resolver: strips slashes, keeps a path prefix, localhost only outside production, invalid or unset in production = no address plus banner | 4 unit tests + 3 integration tests |
| 6 | P3 | `website-form.routes.ts`, new `website-intake-rejections.ts` | 401, 403 and 422 outcomes left no trace | Sanitized, bounded events (design in section G); Activity summary "submission rejected (kind)" | hardening (2 tests) + browser |
| 7 | P4 | `WebsiteLeadsPanel.tsx` | Escape on the confirm dialog also closed the integration sheet | Capture-phase handler local to the panel (only dialog in that sheet; shared dialog code unchanged) | real browser run |
| 8 | P4 | `WebsiteLeadsPanel.tsx` | The plain token stayed in the query client's mutation cache after dismissal | `gcTime: 0` and `reset()` on dismissal | browser run (DOM and flow) |

Also changed for honesty: the failure text stored on events and the connector is now the category `processing_failed` (done in the previous pass; re-verified: name, phone and email never appear in the response, event, connector row or Activity).

## D. Files changed

Requested fixes (this verification):
`apps/api/src/domain/acquisition/website-form.service.ts`, `website-form.routes.ts`, `website-intake-rejections.ts` (new) · `apps/api/src/domain/connector/connector.service.ts`, `connector.routes.ts` · `apps/api/src/domain/integration/hub-state.ts`, `hub.service.ts`, `website-leads-rules.ts`, `website-leads.service.ts` · `packages/types/src/index.ts` · `apps/web/components/integrations/WebsiteLeadsPanel.tsx` · `apps/api/.env.example` (commented docs for `PUBLIC_API_BASE_URL`, `TRUST_PROXY`, `FORM_INTAKE_MAX_PER_MINUTE`) · `docs/namokar/NAMOKAR_WEBSITE_INTAKE.md`.
Tests: `apps/api/src/__tests__/website-leads-hardening.integration.test.ts` (new, 15), `website-leads-rules.test.ts` (+4), `integration-hub-state.test.ts` (+1).
Earlier Website Leads work (previous pass) is unchanged in scope.

Pre-existing, **not mine, preserved untouched**: `apps/web/.env.example` (deleted), `apps/web/app/globals.css` and `apps/web/app/layout.tsx` (remove the Inter font load), `docs/website-leads-webhook-integration-report.md`, and (noticed in revision 2) `apps/api/src/domain/ads/google-ads.ts` plus `apps/api/src/__tests__/ads.test.ts` (Google Ads API version v21 to v26, with its test). The Ads suites pass with that change in place. Nothing staged, restored or deleted.

## E. Database verification

- **Environment:** a throwaway PostgreSQL 16.15 cluster created in a temporary directory, loopback only, port 54399, database `pulseos_test`, created and removed by this session. The Railway tunnel (`127.0.0.1:54301`) and every production service were not used; credentials were never printed.
- **Migrations:** 50 of 50 applied to an empty database; none added.
- **Seed:** fictional demo seed (it refuses `NODE_ENV=production`, so it was run with a process-local `NODE_ENV=development`). Reseeded before each regression run.
- **Results:** section H.
- **Isolation and cleanup:** suites use throwaway tenants removed in `afterAll`; the cluster was stopped afterwards (port closed). Its data directory remains in the session scratch folder and can be deleted.

## F. End-to-end ingestion evidence

Real Chrome → proxy to a local API on the disposable database (the web app's API origin was redirected in the browser only; no request reached a deployed service). A website-server request was then sent directly to the API.

| Stage | Result |
| --- | --- |
| HTTP request (server-to-server, JSON) | PASS (200 `{ok:true,duplicate:false,deduped:false}`) |
| Connector authentication (token; none → 401; old token after rotation → 401) | PASS |
| Validation (missing/invalid fields, phone, size, requireService → 422) | PASS |
| Idempotency (same `submissionId` → 200 duplicate, no extra task) | PASS |
| Patient (created; found again by phone; visible in `/patients` search from the browser session) | PASS |
| Journey (created once; reused for same person) | PASS |
| Attribution (UTM and source recorded; existing suites) | PASS |
| Timeline (`journey_created` + `website_form_submitted`, exactly once after a failed-then-retried submission) | PASS |
| Follow-up task (`new_lead`, exactly one) | PASS |
| Connector activity and health (Healthy only after the real submission; failure → Unhealthy; Activity shows processed and rejected rows) | PASS |
| Through a **deployed** environment | **NOT VERIFIED** |

## G. Security verification

| Check | Result |
| --- | --- |
| Token encryption at rest | PASS: stored payload does not contain it; decrypts to it |
| Token shown once; not in GET, list, logs, activity log, DOM after dismissal, mutation cache | PASS |
| Rotation: A works, rotate, A rejected, B works; six concurrent rotations leave one consistent token; verification restarts | PASS |
| Roles enforced on the server (Admin 403 on token; Front desk 403 on config) | PASS |
| Cross-tenant read, patch, rotate, logs, token reuse | PASS (all denied) |
| Generic routes cannot write typed settings | PASS after fix 4 |
| Allowed origins: https only, no path, query, credentials, `*`; limit 20; normalised; Origin is not authentication (documented, and a wrong Origin is refused even with the right token) | PASS |
| Constant-time compare, rate limit | PASS (unchanged; limit holds against forged forwarding headers) |
| Error sanitization (visitor name, phone, email, token absent from responses, events, Activity) | PASS |
| Rejection events design | Only for a real connector; fixed category text; no payload, header or token; max one row per connector per category per minute (in-process gate plus unique event id); never changes health; unknown ids write nothing; **429 deliberately not recorded** because it is answered before the connector lookup |
| Secrets in logs | Request logs carry method, URL, host and remote address only (observed) |
| Formid as authorization | Not claimed anywhere; it is a label |

## H. Test commands and outcomes

All API runs used a process-local `DATABASE_URL` pointing at the disposable cluster.

| Command (run in `apps/api` unless noted) | Result |
| --- | --- |
| `npx vitest run` (full suite, freshly seeded DB) | 158 files: 149 passed, 8 failed, 1 skipped. 1730 tests passed, 8 failed, 14 skipped |
| Same 8 files on a clean checkout of `HEAD` (separate worktree, my uncommitted changes absent; shared packages resolved to the live tree) | 7 of them fail identically; the 8th passes |
| `whatsnexus-provider-matrix` on my tree, alone | passes (7/7): its one full-run failure is an order/state interaction between notification tests; a full baseline run on `HEAD` was **not** performed |
| Latest run (revision 2, current tree, freshly seeded disposable DB) of 17 Website Leads and adjacent files: hardening 15, hub 14, integration-hub 11, website-form 6, intake-hardening 9, rules 17, state 11, web-origins 7, cors 4, CCS 5, Ads unit 10, Ads integration 14, Runo 8, calls 36, event-retry 4, lead-intake 16, pilot-lead-flow 9 | **17 files, 196 tests, all passed** (the previous run of the same list without the two Ads files: 15 files, 172 tests) |
| `npx tsc --noEmit`, `npx tsc -p tsconfig.json --noEmit` | clean |
| `npx eslint src` | 3 errors, 2 warnings, **all in lines committed by others** (`connector/adapters/ccs.ts:53`, `integration/hub.service.ts:191` `any`; unused seed variables). None from this work |
| `apps/web`: `npx vitest run` (single process) | 53 files, 414 tests passed |
| `apps/web`: `npx eslint app components lib e2e`, `npx tsc --noEmit` | clean (a stale generated `.next/types` entry ignored) |
| Real-browser runs (temporary Playwright specs through system Chrome, since removed) | 2/2 passed: full flow incl. keyboard and Escape; Admin and 390px view |
| `next build` | **not run**: it writes `.next/`, which the running dev server on 3310 uses |

The 7 pre-existing failures (unrelated to this feature, identical on `HEAD`): `capabilities.test.ts`, `capabilities.integration.test.ts`, `edition-access.integration.test.ts` (V1 default for `CCS_IVR` and the set of growth capabilities differ from what the tests expect; follows the CCS commit), `tenant-branding.integration.test.ts` and `signup.integration.test.ts` (session cookie attributes differ from expectation), `notifications.integration.test.ts` and `notification-reconcile.integration.test.ts` (reschedule count off by one).

## I. Production configuration checklist (names only)

API: `DATABASE_URL`, `CONNECTOR_ENCRYPTION_KEY` (must be the key existing secrets were encrypted with), `SESSION_SECRET`, `WEB_ORIGIN` (comma-separated list is supported), **`PUBLIC_API_BASE_URL`** (public https address; required for the intake address to be shown), **`TRUST_PROXY`** (number of proxies, e.g. `1` behind one; unset trusts nobody, so every client behind the proxy shares one rate-limit identity), `FORM_INTAKE_MAX_PER_MINUTE` (optional), `PORT`, `NODE_ENV=production`, `DEMO_PASSWORD` (demo only), `ENABLE_DEV_LOGIN` must be unset.
Web: `NEXT_PUBLIC_API_URL`.
Status on this machine: `NODE_ENV=production` is set in the local API env file; the web app's env points at a deployed API; `PUBLIC_API_BASE_URL` and `TRUST_PROXY` are not set locally. Production values were not inspected and are unconfirmed.

## J. Remaining blockers

| Priority | Item | Impact | Resolve | Approval needed |
| --- | --- | --- | --- | --- |
| P1 | No staging end-to-end run through the real deployment (proxy, TLS, `TRUST_PROXY`, public address) | Real-world path unproven | Deploy to staging, create a token, post the documented request from a real website server, confirm the card turns Healthy | Yes (staging access) |
| P1 | Production configuration unconfirmed (`PUBLIC_API_BASE_URL`, `TRUST_PROXY`, encryption key continuity) | Wrong or missing address; one shared rate-limit bucket behind a proxy | Check each against the deployment | Yes |
| P2 | 7 pre-existing failing test files | Hides regressions in capabilities, sign-in cookies and reminders | Triage separately; not caused by this work | No |
| P2 | Full-suite baseline on `HEAD` not run; one notification test fails only in the full run | Cannot rule out order dependence beyond the isolated checks | Run the full suite on a clean checkout | No |
| P3 | 429 refusals are not visible in Activity | Flood diagnosis needs server logs | Accept, or add aggregate metrics later | No |
| P3 | In-memory rate limiter and rejection gate are per process | Several API instances multiply the limits | Shared store if scaled out | No |
| P3 | Seeded demo connectors show mode "Fixture (sample data)" | Honest label; no longer shown as healthy | None | No |
| P3 | Pre-existing lint errors (`any`) in `ccs.ts`, `hub.service.ts:191` | Lint not green | Fix separately | No |
| P3 | No permanent browser e2e for this flow (the real-browser check used a temporary proxy spec) | Regression risk in UI | Add once a stable test environment exists | No |

## K. Deployment and rollback plan

Order: confirm configuration → deploy **API** → smoke test → deploy **web**.
1. Set `PUBLIC_API_BASE_URL` and `TRUST_PROXY` on the API; confirm `CONNECTOR_ENCRYPTION_KEY` is unchanged. No migration.
2. Deploy the API. It is backward compatible: new response fields are additive, the intake route behaves as before for existing connectors, and only connectors saved through the new screen are closed until a token exists.
3. Smoke test: `GET /health`; with a Super Admin session open Integrations → Website Leads; create a token for a staging or internal test hospital; post the documented request; check Healthy and the lead.
4. Deploy the web app. Old web with new API still works (it ignores the new fields). New web with old API simply has no Website Leads card.

Rollback: redeploy the previous API or web build; there is nothing to undo in the database. **One caution:** connectors saved by the new screen carry settings the old API ignores. After a rollback, a connector that was configured but has **no token** would accept anonymous submissions. Create a token, or switch the form off, before rolling the API back.

## L. Final production readiness

**PRODUCTION READY: NO**

| Criterion | Status |
| --- | --- |
| 1. Relevant database-backed tests pass | Met (196/196 on the current tree; disposable database) |
| 2. Real ingestion verified in staging | **Not met** (no staging; verified on a disposable stack only) |
| 3. Tenant isolation verified | Met |
| 4. Credential behaviour verified | Met |
| 5. No P0/P1 issue remains | **Not met** (two P1 blockers above, both environmental) |
| 6. Required production configuration confirmed | **Not met** |
| 7. Regression tests pass | Partly: web and all Website Leads, hub, intake, calls, Runo, CCS suites pass; 7 pre-existing failures remain and one full-run-only failure is unexplained beyond isolation |
| 8. No unauthorized production action | Met (no production service, credential or data touched) |
