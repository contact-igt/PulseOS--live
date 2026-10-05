# PulseOS — Full Local / Deployment / Product Audit

**Date:** 2026-10-03 · **Branch:** `claude/wonderful-carson-o7jbjk` · **Prepared for:** Sushil, CEO, Invictus Global Tech
**Basis:** fresh evidence gathered in this session (git, GitHub API, code, API, browser, test runs). Earlier reports (M7) were treated as claims to verify, not as proof.

---

## A. Local / Remote / Git

| | |
|---|---|
| Repository | `sushilathithiyaa-igt/pulseos-v5-sep29-1100am` (origin) |
| Local worktree | `…/PulseOS/.claude/worktrees/wonderful-carson` |
| Starting local = remote HEAD | `d696f5b` (M7 progress, Oct 2 7:50pm). Verified against GitHub: only two remote branches exist; this is the newest. |
| Divergence at start | none (0 ahead / 0 behind) |
| Work this session | 9 commits on top of `d696f5b` (`3d28034` … `974252d`) + this report |
| Working tree | clean after the report commit |
| Other local branches | `main` (Sep 13), `feature/pulseos-foundation-convergence` (one milestone behind) — untouched |

`git` on this Mac is wrapped by an Xcode-licence shim; the Command Line Tools binary (`/Library/Developer/CommandLineTools/usr/bin/git`) was used. Accepting the licence (`sudo xcodebuild -license`) removes the need.

## B. Deployment

| Environment | Status |
|---|---|
| **Local** | Running (production build, compiled API + `next start`) — see §Stack. **Localhost is not a deployment.** |
| Preview | **None.** |
| Staging | **None.** |
| Production | **None.** |
| Deployed SHA | n/a |

Evidence: no `.github/`, `vercel.json`, `netlify.toml`, `Dockerfile`, `fly.toml` or `render.yaml` in the repo; GitHub API reports 0 deployments, 0 environments, 0 workflows, no Pages, no homepage URL; no deployment documentation in `README`/`docs`. **No safe established deployment workflow exists, so nothing was deployed and no target was invented.** Status: **AWAITING TARGET/APPROVAL.** Demo fixtures and `DEMO_PASSWORD` must never be exposed publicly.

## C. Tech stack (installed, from `package.json` + `pnpm-lock.yaml`)

| | Version | Note |
|---|---|---|
| Node / pnpm | 24.18.1 / 9.15.0 | |
| Next.js | **16.3.8** | was 16.3.5; critical advisory (RCE in `next/og`, fixed in 16.3.6; **not used** by this app) — upgraded anyway, patch-level only |
| React / React DOM | 19.3.0 | current; no `react-server-dom-*` packages are direct dependencies |
| TypeScript | 5.9.3, `strict` | 2 `any`/`@ts-ignore` in source (both in prose strings); none added this session |
| Fastify | **5.12.5** | was 5.12.4 (HTTP/2 trailer DoS advisory) |
| Drizzle ORM / Kit | 0.45.2 / 0.31.10 | |
| Zod | 3.24.1 | |
| PostgreSQL | 16.14 | local |
| Tailwind / TanStack Query | 4.3 / 5.102 | |

Dependency security (`pnpm audit --prod`): **9 → 1** advisory. Fixed by upgrade (Next, Fastify) and by same-major `pnpm.overrides` (`brace-expansion` 1.1.21, `fast-uri` 3.1.8 / 4.1.5). **Remaining:** `uuid@8.3.2` via `exceljs` (moderate; only affects v3/v5/v6 with a caller-supplied buffer — not used; the major jump was deliberately not forced).

## D. Product matrix

| Area | Status | Notes |
|---|---|---|
| Auth | **DONE** | Argon2id, httpOnly `SameSite=Lax` cookie (`Secure` in production), Remember Me 7 d / 12 h, login throttle, **CSRF origin check added**. Open: session ids are raw UUIDs, no revoke/disable flag/purge, throttle is per-process. |
| Command Centre | **DONE** (period/filters) · **PARTIAL** (metrics) | One hospital-timezone period + branch + service in the URL. Calls, missed calls, follow-ups, check-ins and surgeries are not tiles on the Overview; they live in the *Operations report* tab, which has its own separate period state. |
| Leads | **DONE** | Shared presets, operational views, stated date context. |
| Add Lead | **DONE** | One transaction, tenant-checked references. No idempotency key (a double submit makes two journeys). |
| Journey Detail | **DONE** | |
| Patient 360 | **DONE** | Foreign-branch name leak fixed. Malformed `:id` returns 500; timeline unbounded. |
| Calls — manual / feedback | **DONE** | Idempotency key, transaction. |
| Calls — Runo webhook | **PARTIAL** | Inbound only (no click-to-call); disposition mapping hard-coded (the per-connector mapping table is unused). |
| Calls — recording | **DONE** (live unverified) | Authorised stream; fixture serves a silent WAV. |
| Calls — transcript | **BLOCKED BY PROVIDER** | No speech-to-text; provider-supplied transcript or fixture only. |
| Calls — AI summary | **PARTIAL** | Durable queue; fixture summariser by default; Anthropic only when configured. |
| My Work / Follow-ups | **DONE** | Completed tab now windowed. Complete/reschedule/reassign are not wrapped in a transaction; `POST /tasks` has no Zod. |
| Appointments | **DONE** | History tabs now take a period; advisory-lock booking, no DB exclusion constraint. |
| Front Desk | **DONE** | Today only; no previous/next-day navigation. |
| Doctors / resources | **DONE** | |
| Treatments / Surgery | **DONE** | Table has no period filter (calendar uses planned date). |
| CRM configuration (fields, outcomes, follow-up types, sources, departments, allocation) | **DONE** · **PARTIAL** | Appointment/Treatment field placements are stored but not rendered anywhere. Departments and allocation are not in the Activity log. |
| Core Analytics | **DONE** | |
| Marketing Analytics | **DONE** (V2) | N+1 on the dashboard marketing endpoints. |
| Google Ads / Meta Ads | **PARTIAL · BLOCKED BY PROVIDER** | Read-only adapters, fixtures only; API versions inconsistently pinned (Meta v23.0 is end-of-life per the repo's own comment). |
| Runo | **PARTIAL** | See Calls. |
| CCS IVR | **GATED · BLOCKED BY PROVIDER** | A switch only; provider documentation required. |
| SMS | **GATED · BLOCKED BY PROVIDER** | A switch only. |
| WhatsApp Phase 1 | **DONE** on fixtures (live unverified) | Fixture sends are stored as `SENT` with no mode marker. |
| WhatsApp Inbox / Phase 2 | **PARTIAL** | No agent runtime; Inbox free-text send not hardened (no timeout/idempotency/24 h window). |
| Reminder engine | **PARTIAL** | Disabled-rule bug fixed. No outbox, no re-plan after a rule/offset change or after downtime. |
| Integration Hub | **DONE** with bypass | Legacy `PATCH /connectors/:id` accepts arbitrary secret keys outside the Hub's rules. |
| Activity log | **PARTIAL** | Good redaction; coverage gaps (legacy connector PATCH, endpoints, allocation, departments, resources, owner changes). |
| Capability flags / V1 / V2 | **DONE** | Verified by real sign-in as every role in both editions (see §G). |
| Outbox / M8 | **NOT BUILT** | Recommended next module. |

## E. Date / filter matrix (final, from code and browser)

Presets everywhere they apply: Today · Yesterday · Last 7 · Last 9 · Last 30 · Last 90 · This month · Previous month · Custom (hospital timezone, one resolver `resolveDatePreset`, UI `PeriodControls`).

| Page | Date dimension | Presets / custom | Other filters | Hospital TZ | URL state | Consistent? | Status |
|---|---|---|---|---|---|---|---|
| **Command Centre — Overview** | per widget (see §F) | all 9 / custom From–To | branch, service | yes | yes (`range,from,to,branch,service`) | yes — live widgets labelled | **DONE** |
| Command Centre — Operations report | journey created, visit scheduled/booked, task due/completed, procedure planned/completed, payment | all 9 | 7 filters | yes | yes (`rRange…`) | yes | **DONE** — but a separate period from the Overview |
| Leads | enquiry created · task due · today | all 9 + "Any date" | owner/source/service/status/CRM fields | yes | yes | yes — intersection stated on screen | **DONE** |
| My Work | due (live buckets) · **completed-on** (Completed tab) | Completed: all 9, default 7 d | reason, type, priority | yes | yes (`crange…`) | buckets stay live by design | **DONE** |
| Appointments | scheduled (calendar nav) · history tabs by scheduled | No-shows/Completed: presets (no 90 d — API serves 62 d); Upcoming: today + 62 d | branch, doctor, search | yes | yes (`prange…`) | yes | **DONE** |
| Front Desk | scheduled, **today only** | none | stage, search | yes | partial | n/a | **PARTIAL** (no day navigation) |
| Doctor Home | scheduled, today only | none | — | yes | n/a | n/a | **PARTIAL** (no day navigation) |
| Treatments | planned (calendar) | calendar nav only | status/service/doctor/owner | display yes | yes | table unbounded | **PARTIAL** |
| Campaigns | touchpoint occurred (hospital day), spend prorated | two raw date inputs (no presets) | branch, specialty, source | **fixed** (was UTC) | yes | CPL/ROAS now like-for-like | **PARTIAL** (UI) |
| Core Analytics | per metric, stated on screen | all 9 | 7 filters | yes | yes | yes | **DONE** |
| Marketing Analytics | created / occurred / prorated spend | all 9 | branch, service, source, campaign | yes | yes | yes | **DONE** |
| Integration Logs | received / delivery created | all 9 + "Any date" | provider, status | yes | **yes (new)** | yes — invalid range = 400 | **DONE** |
| Activity Log | created | all 9 + "Any date" | action | yes | **yes (new)** | yes — invalid range = 400 | **DONE** |
| Patients / Journeys lists | — | none | search, stage, source | n/a | partly | `?filter=` from the dashboard is ignored | **NOT BUILT** |
| Journey timeline | — | none (type filters not built) | — | n/a | n/a | n/a | by design |

Known inconsistency: URL keys differ by page (`range` / `rRange` / `aRange` / `crange` / `prange` / `lgrange`), because the calendar owns `range`. A single `usePeriodFilter` is the clean-up.

## F. Command Centre widget reconciliation

| Widget | Date dimension | Follows period | Branch | Service |
|---|---|---|---|---|
| Hospital performance: enquiries | journey created | **yes** | no — hospital-wide (labelled) | no |
| …consultations | consultation outcome recorded | **yes** | no | no |
| …treatments completed | treatment `completedAt` | **yes** | no | no |
| …attributed revenue | payment (`occurredAt`) | **yes** | no | no |
| …marketing spend / ROAS | campaign spend **prorated** over run days in the period | **yes** | no | no |
| …spend at risk | live snapshot ("now") | no | yes | yes |
| **Today** strip | journeys created today · visits scheduled today · waiting now · completed today · treatment decisions pending (now) · payments today | no — labelled "Today" | **yes** (was ignored by revenue/decisions) | **yes** |
| Journey funnel / health | cohort of journeys created in the period | **yes** | yes | yes |
| Patient flow | visits scheduled today | no — labelled | yes | yes |
| Enquiries by source (chart) | journey created, local day | **yes** (was hard-coded 14 d) | yes | yes |
| Service lines | cohort of journeys created in period | **yes** | yes | (highlight) |
| Source performance | touchpoint occurred; spend prorated | **yes** | no (spend cannot be split) | no |
| Attention queue / Team | live (open and overdue) | no — labelled | yes | **yes** (was ignored) |
| Doctor load | visits scheduled / consultations completed in period; waiting = live | **yes** | yes | no |

Not on the Overview (and not added — no new features): calls, missed calls, follow-ups due, check-ins, surgeries. They are in the Operations report tab with their correct dimensions (task due, appointment scheduled, procedure planned).

## G. Security audit

**Critical:** none open. (Next.js RCE advisory in `next/og` was not reachable — the app does not use it — and is patched.)

**High (open):**
- No event outbox — a crash between commit and the in-memory handler loses a reminder plan or webhook (M8).
- List endpoints (`/journeys`, leads facts, journeys summary, patients) load whole tables and filter in JS — availability risk as data grows.
- **Fixed this session:** a failed webhook/form event was dropped for good on the provider's retry (data loss); a switched-off reminder rule kept sending.

**Medium (open):** public website-form and webhook routes have no rate limit, field length caps or per-connector secret · login throttle is in-memory and per-IP (set `TRUST_PROXY` behind a proxy or one IP locks everyone out) · session ids are raw UUIDs with no hashing, `is_active`, revoke-on-credential-change or purge · SSRF guards are duplicated and the recording proxy's applies only when `NODE_ENV=production`; DNS rebinding can bypass both · legacy `PATCH /connectors/:id` bypasses the Hub · several older routes lack Zod/uuid checks (malformed id → 500) · any Doctor in a hospital can record a consultation outcome for another doctor's visit · missing indexes for date-range queries (`appointments.scheduled_at`, `tasks`, `journeys.created_at`, `connector_events`, `revenue_events`) · Meta/Google API versions inconsistent · fixture sends are indistinguishable from real ones.

**Low (open):** CSP keeps `'unsafe-inline'` for scripts (nonce via a proxy is the next step) · connector key derivation has no length check/versioning/AAD · request logging includes query strings and unredacted provider error text.

**Fixed and tested this session:** cross-hospital branch/assignee ids accepted (and a foreign branch **name returned** in Patient 360) · no CSRF origin check (SameSite=Lax alone) · no security headers on web or API (now CSP, nosniff, frame-ancestors none, referrer/permissions policy, HSTS in production) · Developer Login answered remote callers · `?from=constructor` crashed `BackLink` · invalid date ranges silently returned all data (activity log, integration logs, campaigns, dashboard) · Next/Fastify/transitive advisories.

**Code review sweep:** no `tenantId` taken from a request; no unsafe redirect/`from` handling; no secret logging; no new `any`/unsafe casts.

## H. Test results (final tree, commit `974252d`)

| Gate | Result |
|---|---|
| Lint / Typecheck / Build | pass / pass (7 tasks) / pass |
| Targeted session tests | 77 API tests (8 files) + 43 web tests, all pass |
| API suite | **109 files · 1160 tests — 2 consecutive full runs green** on a freshly migrated + seeded database |
| Web / UI / api-client / design-tokens unit | 188 / 132 / 9 / 6 — pass |
| **Playwright full** (production-style stack) | **345 tests · 344 passed · 0 failed · 1 skipped · 9.2 min · no retries** |
| Fresh migration | 34 migrations from an empty database |
| Seed ×1 / ×2 / ×3 | identical: tenants 3, users 18, patients 98, journeys 100, tasks 65, appointments 82, campaigns 20, revenue 18, connectors 24; 0 duplicates (capabilities, rules, connectors, ads facts, appointments, open tasks, users); no FK errors; 0 sessions |
| V1 / V2 smoke | 10 role × edition sign-ins pass (super admin, admin, coordinator, front desk, doctor), server permission answers verified (integration hub, activity log, outbound webhooks Super-Admin-only, growth analytics 403 in V1 / 200 in V2) |
| Responsive | 1440 / 1280 / 1024 / 768 / 390 — period controls fit, wrap, 44 px on phones, no overflow (Command Centre, Core + Marketing Analytics, Appointments, Leads, Settings, Integration Hub) |

Playwright history this session: run 1 stopped after 63 tests (session ended); run 2 → 2 failures (both fixed); run 3 → 0 failures; the final run added the new role/responsive gate, which found and fixed three real layout defects (see below) → final run 0 failures. The single skip is the opt-in screenshot matrix (`SHOT_MATRIX=1`).

### API flake investigation
- **Original failure:** `m7-review-fixes … a redirect from a webhook receiver is never followed` failed once on the first fresh-database run (`seenRedirect` undefined — the delivery was never attempted).
- **Root cause:** a timing-precision race in the **test**. Queue rows get `next_attempt_at` from the database clock (`default now()`, microseconds); the test then asks the worker for deliveries due at a JS `new Date()` (milliseconds, truncated) read immediately after — which can be up to 1 ms earlier, so the row looks "not due yet". Measured: JS "now" is a median 0.48 ms *behind* Postgres `clock_timestamp()`; a micro-benchmark skipped 96.5 % of immediate checks.
- **Reproduction:** on a scratch database the test failed 1 of 6 single runs and 3 of 4 whole-file runs. `integration-hub.integration.test.ts` had the same latent pattern.
- **Resolution:** `dueNow()` helper (a clock slightly ahead) at both call sites. After: 0 failures in 8 single runs and 6 runs of both files. Production is unaffected (the worker ticks well after enqueue). `calls.integration` (a DB-default `next_attempt_at` too) was stable 8/8 and left unchanged.

### Defects the verification found in this session's own work (all fixed)
1. The new Command Centre caption named *spend at risk* and *campaigns* — panels a Beta V1 tenant does not have (and it collided with three tests matching "Service Lines"). Now edition-aware; tests target the heading.
2. Custom From–To dates ran off-screen at 390 px (shared `PeriodControls`) — pair now takes its own row.
3. `Toolbar`'s action area was unclamped (`shrink-0`) — filters overflowed 768 px by 7 px and 390 px badly. Clamped.
4. Command Centre Branch/Service selects were 32 px on phones — now 44 px.

## I. What is complete
Edition-aware Command Centre period + filter consistency; period-correct Campaigns, Appointments history, My Work Completed, Integration/Activity logs with validated, URL-persisted ranges; tenant-checked references; CSRF origin enforcement; web/API hardening headers; loopback-only Developer Login; event-retry and reminder-rule integrity fixes; Next 16.3.8 / Fastify 5.12.5; a permanent role × edition × viewport gate.

## J. What is partial
Calls/missed calls/follow-ups/check-ins/surgeries as Overview tiles (they are in the Operations report; separate period); Front Desk and Doctor Home day navigation; Treatments table period; Campaigns UI presets; Patients/Journeys date filters and dashboard drill-down filters; unified URL keys; auth-gate `proxy.ts`, error/loading/not-found boundaries, server components for shells; reminder re-planning.

## K. What is not built
M8 event outbox; periodic re-plan; webhook DNS pinning; rate limiting on public ingress; session hashing/revocation; list pagination in SQL; CCS IVR and SMS back-ends; a CI pipeline and any deployment target.

## L. Provider blockers
CCS IVR (documentation required) · SMS (no provider) · Google Ads and Meta Ads, WhatsApp live, Runo click-to-call and live webhooks (verified with fixtures only; need real sandbox accounts/credentials) · call transcription (no STT provider).

## Top 15 next actions (priority order)
1. **M8 — event outbox + periodic idempotent re-plan** (reminders, webhooks, rule changes).
2. Harden public ingress: rate limit, field caps, `bodyLimit`, uuid-check, per-connector token (website form, webhooks).
3. Session hardening: hashed tokens, `users.is_active`, revoke on credential change, expiry purge, `Secure` by HTTPS, tenant discriminator at login, shared throttle store + `TRUST_PROXY` guard.
4. One shared SSRF guard with connection pinning (webhooks + recording proxy), on in every non-dev mode.
5. Zod + uuid on the remaining older routes, map Postgres `22P02` to 400, retire or route legacy `PATCH /connectors/:id` through the Hub, doctor-ownership check on outcomes.
6. Push list filtering/counting into SQL with pagination (journeys, leads, patients, summary).
7. Add the missing date-range indexes (use query evidence).
8. Choose a preview/pilot target and add CI (lint, typecheck, build, tests) and a deploy workflow.
9. Test isolation: dedicated test database/schema with a wipe guard; stop tests consuming seeded data (e.g. the doctor-outcome e2e); cleanup test tenants.
10. Date follow-ups: Front Desk/Doctor Home day navigation, Treatments table period, Patients/Journeys created filter, Campaigns presets, one `usePeriodFilter`, sync the Operations-report period with the Overview.
11. Next.js: auth-gate `proxy.ts` (cookie decision for separate API host), `error.tsx`/`loading.tsx`/`not-found.tsx`, server components for static shells, `next/dynamic` for charts/report tab, CSP nonce.
12. Provider honesty: mark fixture sends in rows and timeline; harden the Inbox send; align Google/Meta API versions.
13. Verify WhatsApp, Google/Meta Ads and Runo against real sandbox accounts.
14. Log scrubbing (query strings, provider errors), recording/transcript read audit, connector key hygiene (length, versioning, AAD).
15. Shared types hygiene: derive enums from the DB, `noUncheckedIndexedAccess` per package, Zod-validate high-risk API responses.

## Recommended next module
**M8 — Event outbox, periodic re-plan and webhook DNS pinning.** It closes the two High data-loss/availability risks before any live provider is switched on.

---

*Local access (local only, never to be exposed):* `http://localhost:3310/login` · password = the local `DEMO_PASSWORD` · accounts `gyn.* / eye.* / eyev1.*` `@pulseos.local` (`superadmin, admin, doctor, doctor2, frontdesk, coordinator`).
*To run the e2e suite against this worktree:* `E2E_DATABASE_URL=postgres://localhost:5432/pulseos_latest DEMO_PASSWORD=… pnpm --filter @pulseos/web exec playwright test` (the fixtures default to `pulseos_dev` otherwise).
