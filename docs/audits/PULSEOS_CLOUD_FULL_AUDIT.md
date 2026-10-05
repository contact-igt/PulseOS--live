# PULSEOS CLOUD FULL AUDIT REPORT

Audit date: 2026-10-01 (UTC), cloud session. Baseline audited: `9bdaa4d` (`feature/pulseos-foundation-convergence`, mirrored on
`claude/wonderful-carson-o7jbjk`). Findings marked **FIXED** were fixed in the overnight build that followed the audit
(commits listed in §16 / the overnight report); everything else is as found. "NOT TESTED" is written where a thing was
not exercised. No production system, real patient data or external provider was touched.

---

## 1. Executive Summary

**Overall state.** PulseOS at `9bdaa4d` is a coherent, well-tested modular monolith. It installs, typechecks, lints,
builds, migrates (26 migrations, incl. 0025) from an empty database, seeds three isolated demo tenants, and runs. The
API enforces RBAC, tenant isolation and the Beta V1 edition gate server-side, and this audit confirmed that by calling it
as every role.

**What genuinely works (verified live):** auth (password + dev login, httpOnly session cookie, logout), RBAC per role and
edition, tenant isolation, Leads / Patients / Journeys / Patient 360, the Task-based follow-up engine with
tenant-configurable Follow-up Types (M5), Next Action, My Work, the appointment lifecycle state machine with
compare-and-set transitions, Appointment Risk tasks, doctor/schedule resources and surgery scheduling (M6), Front Desk,
Treatments, CRM fields / outcomes / allocation rules, lead sources, departments, calls + call intelligence (fixture
mode), Inbox / Campaigns / Analytics for the V2 edition, and every Settings section.

**Partially complete:** integrations (all FIXTURE or NOT CONFIGURED, none live, §13); CRM field placements
"Appointment" and "Treatment" could be configured but nothing rendered them (FIXED, hidden from the editor); doctor
resource data on 3 older seeded surgeries; Super Admin is a tenant-level role, not a platform console.

**Broken at baseline:**
- **Time display followed the browser's timezone, not the hospital's.** 6 of the 7 E2E failures came from this or from
  test environment issues. FIXED.
- **The seed's "today" followed the server clock.** On a UTC server the 18:30–24:00 UTC window seeded the queue on the
  wrong hospital day, which made 1–4 API tests fail depending on the time of the run. FIXED.

**Blocked:** real Meta / Google / GBP / WhatsApp / Runo / Exotel traffic (BLOCKED — EXTERNAL CREDENTIAL REQUIRED).

**M5:** the claimed scope is implemented and tested. Requirement table: 12 PASS, 1 PARTIAL. The partial item is that the
browser-timezone display defect affected M5 screens; it is now fixed.

**M6:** the claimed scope is implemented and tested. Requirement table: 13 PASS, 2 PARTIAL. The partials are the same
display defect (FIXED) and older seeded surgeries that lack doctor/branch data.

**Safe to continue into M7?** Yes, with the blockers in §23. The baseline is sound. The defects found were cross-cutting
date/time presentation and seed problems, not model or authorization flaws, and they are fixed and covered by
regression tests.

## 2. Environment Verification

| Item | Value |
|---|---|
| Repository | `sushilathithiyaa-igt/pulseos-v5-sep29-1100am` |
| Branch | `claude/wonderful-carson-o7jbjk` (session branch). It points at the same commit as `origin/feature/pulseos-foundation-convergence`: ahead 0, behind 0. |
| Commit | `9bdaa4d396e51aca9a650f3884d4d4cc48f4bd3d` — **exactly the expected `9bdaa4d`**, clean working tree |
| Node | 22.22.0 (CLAUDE.md locks Node 24, so this is a WARNING; everything passed on 22) |
| pnpm | 9.15.0 (matches `packageManager`) |
| Database | PostgreSQL 16.14 (local cluster started in the container); Drizzle ORM 0.45 + drizzle-kit migrations |
| Frontend | `apps/web` — Next.js 16 / React 19 / Tailwind 4, port 3310 |
| Backend | `apps/api` — Fastify 5 modular monolith, port 4310 |
| Shared | `packages/{types,ui,api-client,design-tokens,validation}` |
| Tests | Vitest (api, web, ui, api-client, design-tokens), Playwright (`apps/web/e2e`, 50 spec files at baseline) |
| Cloud status | Operational. No secrets were provided: `apps/api/.env` was created from `.env.example` with locally generated random values (never committed). |

**Env classification.**
- **A — safe defaults:** `PORT`, `WEB_ORIGIN`, `ENABLE_DEV_LOGIN`.
- **B — required to boot:** `DATABASE_URL`, `DEMO_PASSWORD` (seed/login), `CONNECTOR_ENCRYPTION_KEY` (seed encrypts fixture secrets).
- **C — integrations only:** real provider tokens live encrypted in `connector_secrets`, not in env.
- **D — may stay unavailable:** `PULSEOS_LLM_PROVIDER` / Anthropic key (fixture summarizer is used).
- **E — true blockers:** none.
- **Gaps found:**
  - The web app needs `NEXT_PUBLIC_API_URL`, which was undocumented and defaulted to port **4000** instead of the API's 4310.
  - `SESSION_SECRET` is declared but read nowhere (sessions are opaque DB ids).
  - E2E needs `E2E_DATABASE_URL` when Postgres requires a password.

## 3. Startup / Build Results

| Check | Result | Evidence / Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | 12 s |
| `pnpm typecheck` | PASS | 7/7 tasks |
| `pnpm lint` | PASS | 2/2 tasks, 0 problems |
| `pnpm build` | PASS | web routes compiled (22 routes) |
| `pnpm db:migrate` (empty DB) | PASS | 26 rows in `drizzle.__drizzle_migrations`; NOTICE about identifier truncation of `treatment_opportunities_scheduled_resource_id_schedule_resources_id_fk` (63-char limit), harmless |
| Migration 0025 objects | PASS | `schedule_resources`, `appointments.resource_id` + 6 timestamps + reason columns, `tasks.appointment_id/risk_reason`, partial unique `tasks_open_appointment_risk_unique`, triggers `appointments_resolve_resource_trg` / `users_sync_resource_trg`, CHECK `appointments_resource_required` |
| Schema drift (`drizzle-kit generate`) | PASS | no new migration generated |
| `pnpm db:seed` | PASS | Gynecology (22 journeys/20 patients), Ophthalmology V2 (31/31), Ophthalmology V1 (31/31), 6 accounts each |
| API start / `GET /health` | PASS | `{"ok":true}` |
| Web start / `/login` | PASS | 200; `/` → 307 `/login` |
| Browser → API from web | **FAIL → FIXED** | web defaulted to `localhost:4000`; dev-login controls never loaded until `NEXT_PUBLIC_API_URL` was set |
| Playwright launch | WARNING | repo Playwright expects Chromium build 1243, container has 1194 — ran with `executablePath` from a scratch config (no repo change) |

## 4. Automated Test Results

**Baseline (`9bdaa4d`):**

| Suite | Discovered | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|---|
| API (vitest, 79 files) | 843 | 842 / 841 / 839 | 1 / 2 / 4 | 0 | Varied by time of run. Failures were time-of-day dependent (UTC≠IST window); with a seed run under `TZ=Asia/Kolkata` only `dashboard-funnel-integrity › Patient Flow today` still failed (test computed "today" in UTC). |
| web unit | 106 | 106 | 0 | 0 | |
| ui | 98 | 98 | 0 | 0 | |
| api-client | 9 | 9 | 0 | 0 | |
| design-tokens | 6 | 6 | 0 | 0 | |
| types / validation | — | — | — | — | no test script |
| Playwright (50 files) | 233 | 225 | 7 | 1 | 18.4 min |

**The 7 E2E failures, root-caused:**
- **5 — browser-timezone display** (FIXED):
  - `followups-m5` FLOW A, FLOW C, Reschedule/Reassign
  - `m6-appointment-surgery` FLOW B, FLOW E

  Each showed "3 Oct, 05:30 am" for an 11:00 IST follow-up because the browser was in UTC.
- **1 — ICU punctuation:** `views-appointments › Los Angeles week view` expected "Thursday, 15 October 2026" while
  Chromium 1194 renders "Thursday 15 October, 2026". The product was correct; I made the test matcher tolerant.
- **1 — font metrics:** `multi-specialty-demo › Developer Login 44px` expects desktop buttons under 44px; this
  container's fonts make one wrap to 46px. Environment-specific, P3, open.

**Final gate after fixes:** Playwright 237 passed / 1 failed (B-10, pre-existing) / 1 skipped of 239; API 862/862, web 113/113, ui 102/102, api-client 9/9,
tokens 6/6. These ran at 01:16 IST, inside the window that used to fail.

**Coverage quality.**
- Every M5/M6 claim has named integration tests (§8, §9), including concurrency (double check-in, double completion,
  concurrent surgery scheduling) and tenant leakage.
- **Gaps:**
  - No test ran the UI with a non-IST browser for M5/M6 screens. That is how the display defect hid.
  - No load or performance tests.
  - No test for login brute force.

## 5. Frontend Module Audit

The scripted sweep covered 253 page loads: 21 routes plus a dynamic Journey and Patient 360 page, for 7 accounts. All
roles were checked on desktop (1440); Admin and Front Desk were also checked on tablet (820) and mobile (390). The sweep
recorded console errors, failed API calls (≥400), horizontal overflow, unlabeled controls and error screens. Result: **0
console errors, 0 failed API calls, 0 overflow, 0 unnamed buttons, 0 unlabeled inputs** (re-run after the fixes).

| Module/Page | Route | UI Status | API Status | Tested | Findings |
|---|---|---|---|---|---|
| Login + Dev Login | `/login` | Working | `/auth/*` | Sweep + E2E `auth-flows` | Wrong password keeps email; dev login needs `ENABLE_DEV_LOGIN` |
| Command Centre | `/command-centre` | Working | `/dashboard/*` | Sweep, E2E | Was "all time" only, no date filter, no export → Operations report added (overnight) |
| Doctor home | `/doctor-home` | Working | `/dashboard/doctor` | Sweep, E2E | "Today" used the browser day (FIXED) |
| My Work | `/my-work` | Working | `/tasks` | Sweep, E2E | — |
| Leads | `/leads` | Working | `/leads` | Sweep, E2E | — |
| Patients / Patient 360 | `/patients`, `/patients/[id]` | Working | `/patients/*` | Sweep, E2E | Timeline "Today/Yesterday" was browser-day (FIXED) |
| Journeys / Journey Detail | `/journeys`, `/journeys/[id]` | Working | `/journeys/*` | Sweep, E2E | Next Action / appointment context showed browser time (FIXED) |
| Front Desk | `/front-desk` | Working | `/front-desk` | Sweep, E2E | — |
| Appointments (list/day/week/month) | `/appointments` | Working | `/appointments` | Sweep, E2E | Calendar already hospital-TZ; drawer times were browser-TZ (FIXED via shared formatters) |
| Treatments | `/treatments` | Working | `/treatments` | Sweep, E2E | — |
| Inbox | `/inbox` | Working (V2) | `/conversations/*` | Sweep (V2 admin), E2E | AI-schedule window read in browser TZ (FIXED) |
| Campaigns / Analytics | `/campaigns`, `/analytics` | Working (V2) | `/campaigns/*`, `/analytics/*` | Sweep, E2E | V1 redirected (edition gate) — correct |
| Integrations | `/integrations` | Working (status display) | `/connectors` | Sweep | All fixture / not configured, honestly labelled |
| Settings — Services, Departments, CRM Fields, Lead Sources, Workflow Outcomes, Follow-up Types, Doctors, Allocation Rules | `/settings?section=…` | Working | respective APIs | Sweep (all 8), E2E | CRM placements Appointment/Treatment not rendered anywhere (FIXED); CRM drag-reorder was missing (added) |
| Team | (nav item `implemented:false`) | Placeholder | — | — | Not reachable |

**CRM Fields specifically (baseline):**

| Capability | Status | Detail |
|---|---|---|
| Service-specific and shared fields | WORKING | Service-specific fields plus "All services (shared)" (`specialty_key='*'`) |
| Field types | WORKING | TEXT/NUMBER/DATE/DATETIME/BOOLEAN/SELECT/MULTI_SELECT/PHONE/LONG_TEXT/EMAIL, with server validation per type |
| Options editor | WORKING | Shown only for choice types |
| Required flag | WORKING | Enforced server-side at Add Lead |
| Groups | WORKING | |
| Role visibility | WORKING | Server-filtered |
| Archive / restore | WORKING | History kept |
| Duplicate keys | WORKING | Refused (unique index + 409) |
| Key and type immutability | WORKING | Immutable once a value exists |
| Tenant isolation | WORKING | `crm-fields.integration` 15 tests |
| Ordering | WORKING (arrows only) | Up/down buttons, persisted via `POST /crm/fields/reorder` |
| Drag and drop | NOT IMPLEMENTED | Added overnight |
| Placements: Add Lead, Journey Detail, Patient 360, Follow-up outcome | WORKING | Each is rendered by a screen |
| Placements: Appointment, Treatment | VISUAL ONLY | Selectable and stored, but no screen reads them. FIXED: no longer offered. |

## 6. Backend Module Audit

The API has 128 routes in 27 route files. Every non-public route sits behind `requireAuth` plus per-route
`requirePermission` / `requireCapability`. The tenant is always `request.sessionUser.tenantId`, and unknown query keys
(such as `tenantId`) are stripped by zod.

| Module | APIs | DB | Auth | Tests | Status | Findings |
|---|---|---|---|---|---|---|
| Auth | `/auth/login`, `/auth/logout`, `/auth/session`, dev-login ×3 | users, sessions | public / session | auth-session-lifecycle, auth-and-dashboard | Implemented | No rate limit / lockout on `/auth/login`; login resolves email across tenants (ledger-known); cookie `secure` only in production |
| RBAC / editions | `ROLE_PERMISSIONS` (types), `requireCapability` | tenants.edition | server | edition-*, role tests | Implemented | Matrix verified live (§10) |
| Leads / ingestion | `/leads*`, `/lead-sources*`, `/forms/website/:id`, webhooks | journeys, patients, lead_sources, touchpoints | MANAGE_LEADS / public signed webhooks | leads, acquisition, webhook tests | Implemented | Dedup by normalized phone |
| Patients | `/patients*` | patients | VIEW_PATIENTS | patient tests | Implemented | |
| Journeys / Timeline | `/journeys*` | journeys, timeline_events | VIEW/MANAGE_JOURNEYS | journey, timeline tests | Implemented | |
| Tasks / Follow-ups (M5) | `/tasks*`, `/journeys/:id/follow-ups`, `/followup-types*` | tasks, followup_types | VIEW/MANAGE_TASKS, MANAGE_SPECIALTIES | followups (33), tasks | Implemented | |
| Appointments (M6) | `/appointments*`, `/front-desk`, `/appointments/:id/{action,complete,reschedule}` | appointments, schedule_resources | VIEW/MANAGE_APPOINTMENTS | m6 (41), appointment-transitions (8) | Implemented | `POST /appointments` accepts a past time and does not check doctor double-booking (code-verified, not executed); body field `doctorId` actually carries a resource id |
| Resources (M6) | `/resources*` | schedule_resources | VIEW_APPOINTMENTS / MANAGE_SPECIALTIES | m6 | Implemented | |
| Treatments / Surgery (M6) | `/treatments*`, `/journeys/:id/surgery`, `/treatments/:id/schedule` | treatment_opportunities | VIEW/MANAGE_TREATMENT | m6, treatment tests | Implemented | Completion has no timestamp column (dated by revenue / timeline) |
| Consultation outcome | `/appointments/:id/outcome` | consultation_outcomes | RECORD_CONSULTATION_OUTCOME | yes | Implemented | |
| CRM config | `/crm/fields*`, `/crm/outcomes*`, `/crm/allocation-rules*`, `/journeys/:id/interactions` | custom_field_*, crm_outcomes, allocation_rules | MANAGE_SPECIALTIES / MANAGE_TASKS | crm-* | Implemented | |
| Specialty / departments | `/specialties*`, `/departments*`, `/treatment-catalog` | specialty_templates, departments | mixed | yes | Implemented | |
| Calls (M4) | `/journeys/:id/calls`, `/calls/:id/*` | calls, call_intelligence | LOG_CALL, VIEW_CALL_* | calls tests | Implemented (fixture transcription) | |
| Conversations / Inbox | `/conversations*`, summaries | conversations, messages, conversation_summaries | VIEW/MANAGE_INBOX + FULL_INBOX capability | yes | Implemented (V2) | |
| Dashboard / analytics | `/dashboard/*`, `/analytics/*`, `/campaigns/*` | aggregates | VIEW_ADMIN_COMMAND_CENTRE, VIEW_MARKETING+VIEW_REVENUE, capabilities | dashboard-*, analytics | Implemented | |
| Connectors / webhooks | `/connectors*`, `/webhooks/*` | connectors, connector_secrets (AES-encrypted) | MANAGE_INTEGRATION_CONFIG / signed | connector tests | Implemented (fixture) | |
| Audit log | — | — | — | — | Not implemented | CLAUDE.md lists AuditEvent as a core domain; no table exists |

## 7. Database Audit

- **Migrations:** 0000–0025 apply in order on an empty DB. The journal and 26 snapshots are present, drift is clean,
  and migration 0025 is additive. It backfills resources and `checked_in_at` and adds triggers plus a CHECK.
- **Schema:** 39 tables, 119 foreign keys, 121 indexes. Every domain table carries `tenant_id`; the three that don't
  (`tenants`, `sessions`, `connector_secrets`) are reached only through a tenant-scoped parent.
- **Seed:** three isolated tenants. The seed refuses non-local databases (`seed/safety.ts`) and has consistency guards.
- **Relationships checked live (0 violations):**
  - tasks ↔ journey / appointment / follow-up type are in the same tenant
  - every appointment's journey belongs to the appointment's patient
  - every appointment has a resource
  - each appointment's doctor user matches its resource's linked user
- **Constraints:** `appointments_resource_required`; the cross-tenant resource trigger (`23514`); the partial unique open
  risk task per appointment and signal; unique (tenant, specialty, key) for fields.
- **Issues:**
  - 3 seeded SCHEDULED treatments have no `scheduled_resource_id` and 1 has no `planned_date` (pre-M6 demo rows). P3.
  - No index on `appointments.journey_id`, which is used by Journey Detail and the new report's EXISTS checks. P3
    (performance).
  - Treatment completion time is not stored. P3: reports date it by revenue event or planned date.
  - The 63-char FK name is truncated (cosmetic).
  - `appointment_status` keeps `scheduled` as the DB value for "Booked". This is documented, but it is a naming split.

## 8. M5 Requirement Verification

Source: `docs/superpowers/plans/2026-09-21-pulseos-overnight-completion-ledger.md` § "M5 — Follow-up types + Journey workspace".

| # | Requirement | Implementation | UI evidence | Backend evidence | DB evidence | Test evidence | Result |
|---|---|---|---|---|---|---|---|
| 1 | Follow-ups remain Tasks (no FollowUp table) | task.service | My Work, Journey | `/journeys/:id/follow-ups` → tasks | no followup table; `tasks.followup_type_id` | followups.integration | PASS |
| 2 | `followup_types` tenant-owned with key/label/canonical type/priority/owner/requires note/dept/active/order (0024) | schema.ts | Settings → Follow-up Types | followup-type.service | table present, 5 defaults per tenant | "every hospital starts with the five defaults" | PASS |
| 3 | CRUD + reorder, admin-only, keys immutable, archive not delete, last active not archivable | followup-type.routes | sweep: settings tab loads | MANAGE_SPECIALTIES (doctor/staff 403 live) | `is_active` | 5 named tests | PASS |
| 4 | Product label resolution (Callback etc.) | task.service | My Work rows | — | — | "a callback … reads 'Callback'" | PASS |
| 5 | `POST /journeys/:id/follow-ups` validation (active type, dept, future due, note, owner in tenant) | task.routes | Add follow-up sheet | 422s | — | "refuses a past time…", owner tests | PASS |
| 6 | Tenant validation added to task create / reassign / booking | task/appointment services | — | — | — | "another hospital's … refused" | PASS |
| 7 | Past times refused for follow-ups and reschedules | services | — | 422 | — | tests | PASS |
| 8 | Timeline line per schedule / complete / reschedule / reassign | timeline inserts | Journey timeline | — | timeline_events | "exactly one meaningful line" | PASS |
| 9 | Next Action derived, never stored, hospital-day buckets | `deriveNextAction` | Next Action card | — | no column | unit + "is never stored" | PASS |
| 10 | Journey Detail: Log call / Add follow-up / Book appointment + Next Action actions | NextActionCard, AppointmentContext | E2E FLOW A–D | — | — | followups-m5.spec | **PARTIAL at baseline**: times showed in browser TZ (5 E2E failures). FIXED; specs pass after the fix |
| 11 | My Work Appointment Risk bucket + type/priority filters | my-work page | sweep | `/tasks/counts` | — | "Appointment Risk … drives its own My Work bucket" | PASS |
| 12 | Doctor sees no task note/owner in Next Action | journey service | — | — | — | named test | PASS |
| 13 | Evidence claims (API 802, web 101, Playwright 217/1/1) | — | — | — | — | Found API 843 / web 106 at `9bdaa4d` (later work added tests) | PASS (claims consistent; counts grew) |

**M5 result: 12 PASS, 1 PARTIAL (fixed).**

## 9. M6 Requirement Verification

Source: same ledger, § "M6 — Appointment lifecycle, consultation completion, surgery scheduling".

| # | Requirement | Implementation | UI evidence | Backend evidence | DB evidence | Test evidence | Result |
|---|---|---|---|---|---|---|---|
| 1 | One shared state graph (`APPOINTMENT_TRANSITIONS`) enforced by API and offered by UI | `packages/types` L920 | drawer offers only graph ops | 409 on invalid | status enum | "accepts exactly the operations in the shared graph" + 8 transition tests | PASS |
| 2 | Check-in from Booked stamps `checked_in_at` | applyAppointmentAction | Front Desk | — | column | named test | PASS |
| 3 | Waiting / With doctor stamps | same | Front Desk queue | — | columns | named tests | PASS |
| 4 | Compare-and-set; concurrent presses give one state, one line, one task (`alreadyApplied`) | `where status = existing.status` | — | — | — | "two people pressing Check In at once…" | PASS |
| 5 | Complete with next step (none / follow-up / surgery) in the same transaction; a refused part refuses all | completeAppointment | completion sheet | — | — | 7 completion tests | PASS |
| 6 | No-show stores time + reason, one risk task; rebook resolves it | service | list one-click + drawer reason | — | `no_show_at`, risk index | 3 tests | PASS |
| 7 | Cancel needs reason; hospital-caused raises risk | service | drawer | 422 | `cancelled_at`, reason | 2 tests | PASS |
| 8 | Reschedule: future time + reason; hospital-caused raises one risk task | service | drawer | 422 `scheduled_in_past` | — | 3 tests | PASS |
| 9 | `schedule_resources`; DOCTOR users auto-linked by trigger; cross-hospital refused by DB | migration 0025 | Settings → Doctors | `/resources*` | triggers + CHECK verified | 4 resource tests | PASS |
| 10 | Appointment Risk via the follow-up engine, works if the type is archived | task engine | My Work bucket | — | partial unique index | named test | PASS |
| 11 | Surgery: reuse open treatment, walk to SCHEDULED, store date/doctor/branch/note, advisory lock, duplicate = 409 | `scheduleSurgery` | surgery card | `/journeys/:id/surgery` | columns present | 8 surgery tests | PASS |
| 12 | Surgery reschedule / cancel | `/treatments/:id/schedule`, status | Treatments | — | — | named test | PASS |
| 13 | Permission decisions (Front Desk cannot schedule surgery; Doctor view-only) | ROLE_PERMISSIONS | — | live: frontdesk 403, coordinator allowed | — | named tests | PASS |
| 14 | UI shows times correctly across the lifecycle | drawer / Journey | E2E FLOW B, E | — | — | m6 spec | **PARTIAL at baseline**: browser-TZ display (2 E2E failures). FIXED |
| 15 | Migration 0025 + demo data | 0025, seed | — | — | applies on empty DB | — | **PARTIAL**: 3 seeded SCHEDULED surgeries lack doctor / branch (pre-M6 demo rows) |

**M6 result: 13 PASS, 2 PARTIAL (one fixed, one seed-data P3).** Domain events for M7 exist (`appointment-events.ts`,
test "publishes domain events after the change").

## 10. Role / Permission Audit

Probed live with the API (GET plus write probes using dummy ids) as every role in Ophthalmology V1 and V2. The UI sweep
confirmed the routing.

| Role | Accessible Modules | Restricted Modules | Backend Protection | Findings |
|---|---|---|---|---|
| Super Admin | Everything in the tenant; V1 hides Inbox / Campaigns / Analytics / Executive | `/dashboard/doctor` | 403 / edition-gated on API | Tenant-scoped, not a platform admin |
| Hospital Admin | Same as Super Admin minus integration secrets / recording of consultation outcome | V1 growth modules | V1: `/dashboard/executive`, `/conversations`, `/campaigns/*` → 403 | Correct |
| Front Desk | My Work, Leads, Patients, Journeys, Front Desk, Appointments, Settings (read-only Services) | Command Centre, Treatments, Integrations, CRM config, surgery | `/treatments` 403, `/crm/fields` 403, `POST /journeys/:id/surgery` 403 | Matches M6 decision |
| Coordinator | Front Desk set + Treatments + surgery scheduling | Command Centre, Integrations, CRM config | `/dashboard/today` 403, `/connectors` 403 | Correct |
| Doctor | Doctor home, Appointments, Patients, Journeys (view), My Work | Leads, all writes except consultation outcome | Every write probe 403 | Correct |

No case was found where a hidden UI control was the only protection.

## 11. UI/UX QA Findings

**Critical:** none.

**High**

1. **Times shown in the browser's zone (FIXED).**
   - **Page:** Journey Detail.
   - **Steps:** set the browser timezone to UTC, then add a follow-up for tomorrow at 11:00.
   - **Expected:** "11:00 am".
   - **Actual:** "05:30 am". The same problem appeared in the appointment drawer, timeline and doctor home.

2. **Follow-up time from Log Outcome saved in the browser's zone (FIXED).**
   - **Page:** Journey → Log outcome → follow-up time.
   - **Expected:** the time is stored as hospital time.
   - **Actual:** the time was stored as browser-local time.

**Medium**

3. **CRM field placements that render nowhere (FIXED).**
   - **Page:** Settings → CRM Fields → Add field.
   - **Expected:** only placements a screen renders are offered.
   - **Actual:** "Appointment" and "Treatment" were selectable, but nothing shows fields placed there.

4. **No drag-and-drop for field ordering (ADDED).** Ordering was arrow buttons only.

5. **No dated management view or export at baseline (ADDED).**
   - **Page:** Command Centre.
   - **Actual:** "all time" figures only; no date filter, no table view, no Excel export.

**Low**

6. **Dev-login button height (open).** One role button is 46px instead of under 44px on desktop with this container's
   fonts (dev-only screen).

7. **Week-view ICU punctuation (FIXED in test).** The Week-view day label punctuation differs across ICU versions; the
   E2E matcher was too strict.

## 12. Responsive QA

- **Desktop 1440:** all 23 routes × 7 accounts load with no overflow and no errors.
- **Tablet 820:** Admin and Front Desk, all routes, no overflow.
- **Mobile 390:** Admin and Front Desk, all routes, no overflow. Existing Playwright suites `no-overflow` and
  `responsive-matrix` (1440/1280/1024/768/390) pass.
- **Not tested:** every role at tablet/mobile (only Admin and Front Desk were swept there).

## 13. Integration Status

| Integration | Status | Evidence |
|---|---|---|
| WhatsApp (Meta Cloud API) | IMPLEMENTED + UNTESTED live; tested in FIXTURE mode | `adapters/whatsapp-meta-cloud.ts` calls the Graph API; seeded CONNECTED/FIXTURE; webhook signature tests. BLOCKED BY CREDENTIALS for live |
| Runo (telephony) | IMPLEMENTED (inbound webhook) + tested with fixture | `adapters/runo.ts` parses webhooks; no outbound calling. Live BLOCKED BY CREDENTIALS |
| Exotel | NOT IMPLEMENTED | Seeded `NOT_CONFIGURED` row only; no adapter |
| Superfone | NOT IMPLEMENTED | Same as Exotel |
| Meta Lead Ads | IMPLEMENTED + UNTESTED live | Graph lead fetch + campaign / insights sync; fixture-tested. BLOCKED BY CREDENTIALS |
| Google Ads lead forms | IMPLEMENTED + UNTESTED live | Fixture-tested |
| Google Business Profile | PARTIAL | Performance sync only (by design); fixture |
| Website form | IMPLEMENTED + TESTED | PulseOS's own public endpoint |
| LLM summarizer | STUB (FIXTURE) by default | Anthropic adapter only when configured |

The UI labels every one of these honestly (FIXTURE / Not configured). None is presented as live.

## 14. Security / Data Safety Findings

**Good:**
- No secrets are committed (`git ls-files` / pattern grep clean).
- Argon2id passwords.
- httpOnly `SameSite=Lax` session cookie; no tokens in Web Storage.
- Tenant taken from the session everywhere; zod strips unknown keys.
- Connector secrets are AES-encrypted.
- The generic 500 handler hides SQL details.
- Recording proxy has an SSRF guard.
- Dev login is absent unless explicitly enabled outside production.
- The seed refuses non-local databases.

**Findings:**
- (P2) No rate limiting or lockout on `/auth/login`.
- (P2) No audit-event store for sensitive actions. Exports are now logged to the server log.
- (P3) CORS reflects a single configured origin with credentials. Fine, but `WEB_ORIGIN` must be set in any deployment
  (the fallback is `localhost:3000`).
- (P3) `SESSION_SECRET` is unused, so it gives a false sense of configuration.
- (P3) The cookie `secure` flag depends on `NODE_ENV=production`.

## 15. Code / Architecture Findings

- **Critical:** none.
- **High:**
  - **Date/time presentation was not centralized on the hospital zone (FIXED).** The infrastructure existed
    (`lib/hospitalTime.ts`, `useHospitalTimeZone`) but the shared `@pulseos/ui` formatters bypassed it.
- **Medium:**
  - `POST /appointments` lacks a past-time guard and double-booking detection.
  - No AuditEvent domain.
  - Seed code used the server clock (FIXED).
  - Web had no env example and a wrong default API port (FIXED).
- **Low:**
  - `doctorId` naming carries a resource id.
  - DB status value `scheduled` is displayed as "Booked".
  - Missing `appointments.journey_id` index.
  - The repo's Playwright browser pin differs from the cloud image.
  - Screenshot specs write ~25 files per run (gitignored).
  - 0 TODO/FIXME markers; 4 `as any` / eslint-disable occurrences in non-test code.

## 16. Bugs Found

| ID | Severity | Module | Description | Steps | Expected | Actual | Likely source | Recommended fix / status |
|---|---|---|---|---|---|---|---|---|
| B-01 | High | UI (all) | Dates/times rendered in browser zone | UTC browser, view an IST follow-up | Hospital time | UTC time | `packages/ui/src/format.ts` no `timeZone` | **FIXED `3c1957f`** |
| B-02 | High | Journey / Log outcome, Inbox | datetime inputs read/written in browser zone | UTC browser, log "Needs callback" at 17:00 | 17:00 IST stored | 17:00 UTC stored | `outcomeForm.ts`, `inbox/page.tsx` | **FIXED `3c1957f`** |
| B-03 | Medium | Seed | Demo "today" from server clock | Seed on a UTC server after 18:30 UTC | Queue on IST today | Queue on IST yesterday | `seed/demo/demo-clock.ts`, `shared.ts` | **FIXED `3c1957f`** |
| B-04 | Low | Tests | `dashboard-funnel-integrity` compared UTC day with hospital day | Run 18:30–24:00 UTC | pass | fail | test used `setHours` | **FIXED `3c1957f`** |
| B-05 | Medium | Dev setup | Web → API default port 4000, undocumented | Fresh clone, `pnpm dev` | login works | dev-login empty, API calls fail | `api-client` `API_BASE` | **FIXED `3c1957f`** (+ `.env.example`, README) |
| B-06 | Medium | Settings → CRM Fields | Placements Appointment/Treatment offered but not rendered | Add field, tick Appointment | appears somewhere | appears nowhere | `FIELD_PLACEMENTS` | **FIXED `e20fccb`** |
| B-07 | Medium | Appointments API | Booking accepts a past time; no double-booking guard | `POST /appointments` with yesterday | 422 | 201 (code-verified, not executed) | `createAppointment` | Open — add the reschedule guard + overlap check |
| B-08 | Medium | Auth | No login throttling | Repeated wrong passwords | Throttled | Unlimited | `auth.routes.ts` | Open — per-IP/email rate limit |
| B-09 | Low | Seed data | 3 SCHEDULED surgeries without doctor/branch | View Treatments | doctor shown | blank | pre-M6 demo builders | Open — set resource/branch in seed |
| B-10 | Low | Dev login | Button 46px on desktop (expects <44px) | E2E `multi-specialty-demo` | <44px | 46px | font metrics in container | Open — allow single-line truncate |
| B-11 | Low | Config | `SESSION_SECRET` read nowhere | — | used or removed | unused | `.env.example` | Open — remove or document |
| B-12 | Low | DB perf | No index on `appointments.journey_id` | — | indexed FK | seq scans at scale | schema | Open — additive migration when needed |
| B-13 | Low (found while building) | Export | Filename header not readable cross-origin | Download a report | named file | generic name | missing `Access-Control-Expose-Headers` | **FIXED `fe3baa5`** before release |

## 17. Missing / Incomplete Work

Claims the audit does not fully support:
- **M5/M6 "UI complete":** the UI showed wrong times off-IST. The E2E suite for exactly these flows failed in a UTC
  browser. Fixed.
- **Ledger test counts:** M5 says Playwright "217 passed / 1 skipped"; at `9bdaa4d` the suite has 233 tests (M6 added
  more) and a UTC environment produced 7 failures.
- **CRM placements "Appointment / Treatment":** claimed as placements but never rendered. Now hidden.
- **The M6 ledger section has no Evidence paragraph.** The other milestones have one with test counts.

## 18. What Is Fully Completed

Every item below was verified by tests and live checks:
- Auth and session lifecycle.
- RBAC and the edition gate.
- Tenant isolation.
- Lead capture with dedup and attribution.
- Patients, Journeys, Timeline.
- The M5 follow-up engine, types, Next Action and My Work.
- The M6 appointment state machine, resources, Appointment Risk, completion with next step, and surgery scheduling.
- Front Desk and Treatments.
- CRM fields, outcomes and allocation rules.
- Departments and lead sources.
- Calls (fixture).
- V2 Inbox, Campaigns and Analytics.
- Migrations from empty, seed, and the build pipeline.

## 19. What Is Partially Completed

- **Integrations:** fixture-complete, none live.
- **GBP:** performance sync only.
- **Seeded surgeries:** some lack doctor/branch.
- **Settings per-hospital reason lists:** reasons are a stable V1 set (ledger M6 decision 3).
- **Super Admin:** tenant-level only.

## 20. What Is Not Started / Placeholder Only

- Team page (nav `implemented:false`).
- Exotel / Superfone adapters.
- AuditEvent store.
- Appointment WhatsApp templates / reminders: specified in the 2026-10-01 design contract §5, intended for M7. Tables
  `message_templates`, `reminder_rules`, `appointment_notifications` do not exist yet.
- Platform-level super admin.

## 21. Cloud Environment Blockers

| Blocker | Impact | Status |
|---|---|---|
| No real provider credentials | Live integrations | BLOCKED (expected) |
| Playwright Chromium pin (1243) vs image (1194) | E2E needs `executablePath` | Worked around with a scratch config |
| Node 22 vs 24 | none observed | WARNING |
| Postgres password auth for E2E `psql` | E2E fixtures | `E2E_DATABASE_URL` |

## 22. Recommended Next Actions (dependency order)

1. Keep the hospital-time rule enforced. Consider a lint rule banning `toLocale*`/`getHours` outside the formatter
   modules.
2. Add a booking past-time guard and doctor overlap detection (B-07). M7 reminders depend on correct bookings.
3. Add login throttling (B-08) and a minimal AuditEvent table (exports, role changes, archive actions) before real
   hospitals are onboarded.
4. Fix the seed surgeries' doctor/branch (B-09).
5. Start M7 (appointment messaging), using the domain events M6 already publishes.
6. Add the `appointments.journey_id` index when data volume warrants it.

## 23. M7 Readiness

**READY WITH BLOCKERS.**
- **Ready:** the build is green and the domain is coherent. The M6 domain events M7 subscribes to exist and are tested.
  The timezone defect that would have corrupted reminder times is fixed and regression-tested at the UTC/IST boundary.
- **Blockers:**
  - M7 cannot be validated against a live WhatsApp account without credentials (fixture mode only).
  - B-07 (booking past-time / overlap) should land before reminders are scheduled from bookings.

---

## Status update — after M6.5 (2026-10-02)

| Bug | Status |
|---|---|
| B-07 booking accepts the past; no double-booking guard | **FIXED** (M6.5): server-side past refusal; per-resource locked same-minute collision check |
| B-08 no login throttling | **FIXED** (M6.5): reserve-on-admit throttle, 429 + Retry-After, per account+address and per address |
| B-09 seeded surgeries without doctor/branch | **FIXED** (M6.5): seed repaired; completed rows carry a completion time |
| B-10 dev-login button 46px | **FIXED** (M6.5): the stale maximum-height assertion replaced by a minimum + on-screen rule |
| "Treatment completion has no timestamp" (P2) | **FIXED** (migration 0026); reports no longer infer it from payments |
| "Settings: system vs hospital stages" (deferred) | **DONE** (M6.5) |
| B-11 unused `SESSION_SECRET`, B-12 `appointments.journey_id` index | open (P3) |
