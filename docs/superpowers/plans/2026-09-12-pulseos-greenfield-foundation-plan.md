# PulseOS Greenfield Foundation — Implementation Plan

- **Status**: Planning only. No implementation started.
- **Date**: 2026-09-12
- **Approved spec**: [2026-09-12-pulseos-greenfield-foundation-design.md](../specs/2026-09-12-pulseos-greenfield-foundation-design.md)
- **Supersedes**: `2026-09-12-pulseos-foundation-design.md` (old spec) and the Task 16–20 implementation plan built on `whatnexus-frontend`/`invictus-chatbot` as the product base. That plan is stopped.
- **Locked decisions**: `apps/web`/`apps/api` are new, not scaffolded from any old repo. `Journey` is a dedicated first-class entity, not legacy Lead-as-Journey.
- **Reference repos** (`backend`, `frontend`, `whatnexus-frontend`, `whatnexus-frontend-pulseos-work`, `invictus-chatbot`, `invictus-chatbot-pulseos-work`): read-only sources for pattern extraction. Never a runtime dependency of `apps/*`. Old Task 5–15 worktrees: kept, not continued, not deleted.

---

## How to read this plan

Each task is independently reviewable and lists:

- **FILES** — Create / Modify / Test
- **INTERFACES** — Consumes / Produces
- Checkboxes: failing test → run failure → minimal implementation → focused verification → regression check → browser/UI verification (where applicable) → commit

Modules M0–M12 constitute the **PulseOS Visual Prototype Cut Line** (defined in full at the end). M13–M16 are post-cutline hardening/extension work, planned now but not blocking the first reviewable prototype.

Technical baseline: TypeScript throughout, Node/Express (or Fastify — decided in M0) for `apps/api`, Next.js for `apps/web`, Postgres (or MySQL — decided in M0) via a typed ORM, a modular monolith (no microservices), Turborepo workspace. Shared packages (`packages/types`, `packages/validation`, `packages/api-client`, `packages/ui`, `packages/design-tokens`) exist only where web/API genuinely share a contract.

---

## M0 — Greenfield Workspace / Monorepo / Quality Baseline

Goal: an empty, correctly-wired monorepo with CI-grade quality gates, before any product code.

### M0.1 — Initialize Turborepo workspace and package layout

**FILES**
- Create: `package.json` (root), `turbo.json`, `tsconfig.base.json`, `.gitignore`, `apps/web/.gitkeep`, `apps/api/.gitkeep`, `packages/ui/.gitkeep`, `packages/types/.gitkeep`, `packages/validation/.gitkeep`, `packages/api-client/.gitkeep`, `packages/design-tokens/.gitkeep`
- Modify: none
- Test: `apps/api/__tests__/workspace.smoke.test.ts` (placeholder — asserts workspace resolves) — removed once M0.3 adds a real test runner target

**INTERFACES**
- Consumes: none
- Produces: workspace package boundaries (`apps/*`, `packages/*`) that every later module builds inside

- [ ] Write failing smoke test asserting the workspace's root `package.json` declares the five `packages/*` workspaces and two `apps/*` workspaces
- [ ] Run it, confirm failure (workspace doesn't exist yet)
- [ ] Scaffold root `package.json` (workspaces field), `turbo.json` pipeline stub, per-package `package.json`/`tsconfig.json` stubs
- [ ] Run test, confirm pass
- [ ] Commit: `chore: initialize PulseOS greenfield monorepo workspace`

### M0.2 — Choose and wire backend runtime, DB, and ORM

**FILES**
- Create: `apps/api/package.json`, `apps/api/src/index.ts`, `apps/api/src/db/client.ts`, `apps/api/.env.example`, `docker-compose.dev.yml` (local Postgres)
- Modify: `turbo.json` (add `apps/api` build/dev pipeline)
- Test: `apps/api/__tests__/db.connection.test.ts`

**INTERFACES**
- Consumes: `docker-compose.dev.yml` local DB
- Produces: `db` client singleton every domain module (M4+) imports

- [ ] Write failing test: app boots, DB client connects, `SELECT 1` returns
- [ ] Run it, confirm failure (no server/db client yet)
- [ ] Implement minimal Express (or Fastify) app entry + typed DB client (Prisma or Drizzle — pick one, document choice in this file's changelog) + local Postgres via `docker-compose.dev.yml`
- [ ] Run test, confirm pass
- [ ] Regression: `turbo run build` succeeds across all workspaces
- [ ] Commit: `chore: wire apps/api runtime, DB client, local Postgres`

### M0.3 — Wire frontend runtime (Next.js) and shared TypeScript config

**FILES**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `packages/types/package.json`, `packages/types/src/index.ts` (empty export barrel)
- Modify: `turbo.json` (add `apps/web` pipeline), root `tsconfig.base.json` referenced by both apps
- Test: `apps/web/__tests__/smoke.test.tsx` (renders `/` without throwing)

**INTERFACES**
- Consumes: `packages/types` (empty barrel, proves the import path resolves)
- Produces: a running Next.js shell that M1 fills in

- [ ] Write failing render test for `app/page.tsx`
- [ ] Run it, confirm failure
- [ ] Scaffold minimal Next.js app (App Router), import one symbol from `packages/types` to prove workspace linking works
- [ ] Run test, confirm pass
- [ ] Browser verification: `npm run dev` in `apps/web`, confirm blank page loads at `http://localhost:3000`
- [ ] Commit: `chore: wire apps/web Next.js shell`

### M0.4 — Lint, format, typecheck, test, CI quality gate

**FILES**
- Create: `.eslintrc.cjs` (or flat config), `.prettierrc`, `.github/workflows/ci.yml`, `vitest.config.ts` (or Jest equivalent) per app
- Modify: root `package.json` scripts (`lint`, `typecheck`, `test`, `format`)
- Test: CI workflow itself is the test — verified by a deliberate failing lint/type error committed then reverted, or by inspecting a passing local run

- [ ] Add `lint`/`typecheck`/`test`/`build` scripts at root, delegating to `turbo run`
- [ ] Confirm all four fail cleanly on an intentionally broken file, then pass once reverted (local dry run, not committed broken)
- [ ] Add GitHub Actions workflow running lint+typecheck+test+build on every PR
- [ ] Commit: `chore: add lint/typecheck/test/CI quality gate`

---

## M1 — Design Tokens + Application Shell + Authentication Shell

Goal: the first pixels a human can judge, behind a real (if minimal) login.

### M1.1 — Design tokens package

**FILES**
- Create: `packages/design-tokens/src/colors.ts`, `spacing.ts`, `typography.ts`, `index.ts`, `packages/design-tokens/package.json`
- Test: `packages/design-tokens/__tests__/tokens.test.ts` (token shape/contract test — e.g., every color has light+dark value)

**INTERFACES**
- Consumes: none
- Produces: `@pulseos/design-tokens` consumed by `packages/ui` (M1.2) and directly by `apps/web` Tailwind/CSS config

- [ ] Write failing test asserting token shape contract (color scale completeness, spacing scale, type scale)
- [ ] Run it, confirm failure
- [ ] Author tokens per spec §18 (`DESIGN_VARIANCE=5`, calm enterprise-healthcare palette, one accent, functional-not-decorative color use)
- [ ] Run test, confirm pass
- [ ] Commit: `feat(design-tokens): establish PulseOS token set`

### M1.2 — Core UI primitives package

**FILES**
- Create: `packages/ui/src/{Button,Input,Card,Badge,KpiStrip,Table,Drawer,EmptyState,Skeleton}.tsx`, `packages/ui/src/index.ts`
- Test: `packages/ui/__tests__/*.test.tsx` (render + a11y role assertions per primitive)

**INTERFACES**
- Consumes: `@pulseos/design-tokens`
- Produces: `@pulseos/ui` consumed by every screen from M2 onward

- [ ] Write failing render/a11y tests for each primitive (button has accessible name, table has proper roles, drawer traps focus, empty/loading states render distinct content)
- [ ] Run them, confirm failure
- [ ] Implement primitives against tokens, VISUAL_DENSITY=7 spacing defaults, MOTION_INTENSITY=3 transition tokens only (no decorative animation)
- [ ] Run tests, confirm pass
- [ ] Commit: `feat(ui): core PulseOS UI primitive library`

### M1.3 — Auth domain: User, Role, session issuance (API)

**FILES**
- Create: `apps/api/src/domain/user/{User.model.ts,user.service.ts,auth.routes.ts,auth.middleware.ts}`, `apps/api/src/db/migrations/0001_users_roles.sql` (or ORM schema equivalent)
- Test: `apps/api/src/domain/user/__tests__/{auth.service.test.ts,auth.routes.test.ts}`

**INTERFACES**
- Consumes: `apps/api/src/db/client.ts`
- Produces: `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` — consumed by `apps/web` in M1.5

- [ ] Write failing test: seeded user + correct password → `POST /auth/login` returns session/cookie; wrong password → 401
- [ ] Run it, confirm failure (no route yet)
- [ ] Implement `User`/`Role` tables, password hashing, httpOnly-cookie session issuance, `auth.middleware` for protected routes
- [ ] Run test, confirm pass
- [ ] Regression: full `apps/api` test suite green
- [ ] Commit: `feat(api): auth domain — user, role, session issuance`

### M1.4 — Seed/demo data layer

**FILES**
- Create: `apps/api/src/seed/{seed.ts,fixtures/{tenants,branches,users}.ts}`, `apps/api/package.json` (add `seed` script)
- Test: `apps/api/src/seed/__tests__/seed.test.ts` (running seed twice is idempotent, produces expected row counts)

**INTERFACES**
- Consumes: `User`/`Role`/`Tenant`/`Branch` models
- Produces: a repeatable `npm run seed` every later module's demo data extends

- [ ] Write failing test asserting seed produces one demo tenant, one branch, one user per role (`SUPER_ADMIN`, `HOSPITAL_ADMIN`, `RECEPTION`, `COUNSELLOR`, `DOCTOR`) with known demo credentials
- [ ] Run it, confirm failure
- [ ] Implement idempotent seed script
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): seed/demo data layer with role-per-user fixtures`

### M1.5 — Web: login page + app shell + role-aware nav

**FILES**
- Create: `apps/web/app/login/page.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/components/shell/{Sidebar,TopBar,RoleGate}.tsx`, `packages/api-client/src/auth.ts`
- Test: `apps/web/__tests__/{login.test.tsx,shell.test.tsx}` + one Playwright/E2E: login → land on shell

**INTERFACES**
- Consumes: `POST /auth/login`, `GET /auth/session` via `@pulseos/api-client`
- Produces: authenticated app shell every later screen (M2+) mounts inside

- [ ] Write failing test: unauthenticated visit to `/` redirects to `/login`; valid login redirects into shell with role-correct nav items (spec §17 nav list, reduced set for `DOCTOR`)
- [ ] Run it, confirm failure
- [ ] Implement login form, session cookie handling, shell layout (`Sidebar`/`TopBar`), `RoleGate` component
- [ ] Run test, confirm pass
- [ ] Browser verification: log in with each seeded demo user, confirm correct nav per role
- [ ] Commit: `feat(web): login, app shell, role-aware navigation`

---

## M2 — Admin Command Centre

Goal: the flagship dashboard, first version on seeded data — every section from spec §6.

### M2.1 — Dashboard aggregation API (Today + Attention/SLA)

**FILES**
- Create: `apps/api/src/domain/dashboard/{dashboard.service.ts,dashboard.routes.ts}`
- Test: `apps/api/src/domain/dashboard/__tests__/dashboard.today.test.ts`

**INTERFACES**
- Consumes: (stub) Patient/Journey/Task/Appointment tables — since M4/M6/M8/M9 don't exist yet, this task creates **minimal stub tables** sufficient for counts (full models arrive in their own modules; this endpoint is rebuilt to point at real tables once they land, tracked as a follow-up note in M4–M9)
- Produces: `GET /dashboard/today`, `GET /dashboard/attention`

- [ ] Write failing test: seeded counts (new enquiries, uncontacted, follow-ups due, appointments today, waiting, consultations done, no-shows, pending decisions) match expected fixture numbers
- [ ] Run it, confirm failure
- [ ] Implement aggregation queries against stub tables
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): admin dashboard today+attention aggregation`

> Note: this task is intentionally sequenced before M4–M9's real domain models to unblock the visual milestone. M4.4/M6.4/M8.3/M9.3 each include a "repoint dashboard query" sub-step so this endpoint ends on real data, not stub data, by the prototype cut line.

### M2.2 — Dashboard aggregation API (Conversion, Patient Flow, Marketing, Team, Branch/Doctor)

**FILES**
- Create: `apps/api/src/domain/dashboard/{conversion.service.ts,patientflow.service.ts,marketing.service.ts,team.service.ts,branchdoctor.service.ts}` + routes
- Test: matching `__tests__` per service

**INTERFACES**
- Consumes: stub tables (same caveat as M2.1)
- Produces: `GET /dashboard/{conversion,patient-flow,marketing,team,branch-doctor}`

- [ ] Write failing tests for each of the five endpoints against seeded fixture data
- [ ] Run them, confirm failure
- [ ] Implement the five aggregation services
- [ ] Run tests, confirm pass
- [ ] Regression: full dashboard test suite green
- [ ] Commit: `feat(api): remaining admin dashboard aggregation endpoints`

### M2.3 — KPI strip, funnel, and patient-flow board components

**FILES**
- Create: `packages/ui/src/{KpiStripSection,ConversionFunnel,PatientFlowBoard}.tsx` + tests

**INTERFACES**
- Consumes: `@pulseos/ui` primitives (M1.2)
- Produces: components consumed by M2.5 dashboard page

- [ ] Write failing render tests: each component renders correct segment counts from mock data, each segment is a clickable element exposing an `onSegmentClick(filter)` callback
- [ ] Run them, confirm failure
- [ ] Implement components (no decorative chart libraries beyond what's needed — simple SVG/CSS bars per spec, analytical not decorative)
- [ ] Run tests, confirm pass
- [ ] Commit: `feat(ui): KPI strip, conversion funnel, patient flow board`

### M2.4 — Attention queue, marketing panel, team panel, branch/doctor panel components

**FILES**
- Create: `packages/ui/src/{AttentionQueue,MarketingPanel,TeamPanel,BranchDoctorPanel}.tsx` + tests

**INTERFACES**
- Consumes: `@pulseos/ui` primitives
- Produces: components consumed by M2.5

- [ ] Write failing render tests per component (ranked list rendering for AttentionQueue, source-distribution bars for MarketingPanel, workload bars for TeamPanel, compact table for BranchDoctorPanel — each clickable)
- [ ] Run them, confirm failure
- [ ] Implement components
- [ ] Run tests, confirm pass
- [ ] Commit: `feat(ui): attention queue, marketing, team, branch/doctor panels`

### M2.5 — Admin Command Centre page (assembled, wired to API, drill-down navigation)

**FILES**
- Create: `apps/web/app/(app)/command-centre/page.tsx`, `apps/web/app/(app)/command-centre/loading.tsx`, `apps/web/app/(app)/command-centre/error.tsx`
- Test: `apps/web/__tests__/command-centre.test.tsx` + E2E: load dashboard, click a KPI, land on filtered list route (stub route acceptable until M4/M6 exist)

**INTERFACES**
- Consumes: `GET /dashboard/*` (M2.1, M2.2), all M2.3/M2.4 components
- Produces: `/command-centre` route — the primary reviewable screen

- [ ] Write failing test: page renders all seven sections (Today, Conversion, Patient Flow, Attention, Marketing, Team, Branch/Doctor) with seeded data, no decorative-only elements
- [ ] Run it, confirm failure
- [ ] Assemble page, wire loading/empty/error states, wire drill-down click handlers to router
- [ ] Run test, confirm pass
- [ ] Browser verification: log in as `HOSPITAL_ADMIN`, view `/command-centre`, visually confirm layout/hierarchy/density/typography against spec §18 intent; click through 2–3 drill-downs
- [ ] Commit: `feat(web): Admin Command Centre — assembled, seeded, drill-down`

---

## M3 — Doctor Command Centre

Goal: role-distinct home screen, second half of the first visible milestone.

### M3.1 — Doctor dashboard aggregation API

**FILES**
- Create: `apps/api/src/domain/dashboard/doctor.service.ts`, route
- Test: `apps/api/src/domain/dashboard/__tests__/doctor.dashboard.test.ts`

**INTERFACES**
- Consumes: stub tables (same caveat as M2.1, repointed in M4/M9/M10)
- Produces: `GET /dashboard/doctor/:doctorId`

- [ ] Write failing test: seeded doctor's today's appointments, waiting/checked-in, next patient, outcomes-awaiting, treatment/post-care follow-ups, callbacks-due all match fixtures
- [ ] Run it, confirm failure
- [ ] Implement aggregation scoped to the authenticated doctor's own data
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): doctor command centre aggregation`

### M3.2 — Doctor dashboard components (next-patient card, today list, awaiting-outcome list)

**FILES**
- Create: `packages/ui/src/{NextPatientCard,DoctorTodayList,AwaitingOutcomeList}.tsx` + tests

**INTERFACES**
- Consumes: `@pulseos/ui` primitives
- Produces: components consumed by M3.3

- [ ] Write failing render tests per component
- [ ] Run them, confirm failure
- [ ] Implement components — deliberately un-marketing-flavored, patient-context-first
- [ ] Run tests, confirm pass
- [ ] Commit: `feat(ui): doctor command centre components`

### M3.3 — Doctor Command Centre page

**FILES**
- Create: `apps/web/app/(app)/doctor-home/page.tsx` (or role-based redirect target for `/command-centre` when role is `DOCTOR` — decide routing approach here), loading/error states
- Test: `apps/web/__tests__/doctor-home.test.tsx` + E2E: doctor login lands on doctor home, not admin dashboard

**INTERFACES**
- Consumes: `GET /dashboard/doctor/:doctorId`, M3.2 components
- Produces: doctor's role-specific landing screen

- [ ] Write failing test: `DOCTOR`-role login routes to doctor home; `HOSPITAL_ADMIN` login routes to `/command-centre`; doctor home never renders a marketing/revenue section for a doctor without permission
- [ ] Run it, confirm failure
- [ ] Implement page + role-based landing route logic in the shell (M1.5)
- [ ] Run test, confirm pass
- [ ] Browser verification: log in as seeded `DOCTOR` demo user, confirm distinct screen, next-patient card, today list
- [ ] Commit: `feat(web): Doctor Command Centre — role-distinct landing`

> **First visible milestone reached here.** Login + shell + both dashboards + seeded data are browser-reviewable end to end.

---

## M4 — Patient Model + Patients UI

### M4.1 — Patient/PatientIdentity domain model (API)

**FILES**
- Create: `apps/api/src/domain/patient/{Patient.model.ts,PatientIdentity.model.ts,patient.service.ts,patient.routes.ts}`, migration
- Test: `apps/api/src/domain/patient/__tests__/patient.service.test.ts`

**INTERFACES**
- Consumes: `Tenant`/`Branch` (M1.3)
- Produces: `Patient`, `PatientIdentity` tables; `GET/POST /patients`, `GET /patients/:id` — consumed by M4.3, M5, M6

- [ ] Write failing test: create patient with guardian-linked dependent (`primary_contact_id`-equivalent relationship) round-trips correctly
- [ ] Run it, confirm failure
- [ ] Implement model + service + routes
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): Patient/PatientIdentity domain model`

### M4.2 — Patient seed fixtures (realistic hospital data)

**FILES**
- Modify: `apps/api/src/seed/{seed.ts,fixtures/patients.ts}`
- Test: extend `seed.test.ts` for patient row-count/shape assertions

- [ ] Write failing test: seed produces N realistic patients across fertility/paediatrics/general-OPD demo scenarios, including one guardian→dependent pair
- [ ] Run it, confirm failure
- [ ] Author fixtures
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): realistic patient seed fixtures`

### M4.3 — Patients list UI (dense, filterable, searchable)

**FILES**
- Create: `apps/web/app/(app)/patients/page.tsx`, `packages/ui/src/DataTable.tsx` (if not already generalized from M2), `apps/web/app/(app)/patients/loading.tsx`, `.../error.tsx`
- Test: `apps/web/__tests__/patients-list.test.tsx` + E2E: search by name/phone filters rows

**INTERFACES**
- Consumes: `GET /patients`
- Produces: `/patients` route, consumed by M2 drill-down links (repoint stub routes here)

- [ ] Write failing test: list renders seeded patients, search-as-you-type filters client-visible rows, filter chips (branch, source) narrow results
- [ ] Run it, confirm failure
- [ ] Implement page with `DataTable`, search, filter chips, empty/loading/error states
- [ ] Run test, confirm pass
- [ ] Browser verification: search and filter against seeded data
- [ ] Commit: `feat(web): Patients list — dense, filterable, searchable`

### M4.4 — Repoint dashboard stubs to real Patient data

**FILES**
- Modify: `apps/api/src/domain/dashboard/*.service.ts` (patient-count-dependent queries only)
- Test: update existing dashboard tests to assert against real `Patient` rows instead of stub table

- [ ] Update failing assertions to expect real-table-derived counts
- [ ] Run them, confirm failure against still-stubbed queries
- [ ] Repoint queries to `Patient` table
- [ ] Run tests, confirm pass
- [ ] Regression: full dashboard + patient suites green
- [ ] Commit: `refactor(api): dashboard queries read real Patient data`

---

## M5 — Patient 360

### M5.1 — Patient 360 aggregation API

**FILES**
- Create: `apps/api/src/domain/patient/patient360.service.ts`, route `GET /patients/:id/360`
- Test: `__tests__/patient360.test.ts`

**INTERFACES**
- Consumes: `Patient` (M4), plus placeholder fields for Journey/Appointment/Treatment until M6/M9/M10 land (documented as a repoint follow-up, same pattern as M2.1)
- Produces: single aggregated payload for the header strip (spec §8)

- [ ] Write failing test: aggregation returns identity, language, branch, source, last-interaction placeholder, next-action placeholder in one payload shape
- [ ] Run it, confirm failure
- [ ] Implement aggregation service
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): Patient 360 aggregation endpoint`

### M5.2 — Patient 360 header + tabbed drawer UI

**FILES**
- Create: `apps/web/app/(app)/patients/[id]/page.tsx` (or drawer-over-list pattern per spec §20 — drawer preferred), `packages/ui/src/Patient360Header.tsx`
- Test: `apps/web/__tests__/patient360.test.tsx` + E2E: open from Patients list, header renders full identity strip

**INTERFACES**
- Consumes: `GET /patients/:id/360`
- Produces: Patient 360 drawer, consumed by M6 (Journey tab), M7 (Timeline tab), M9 (Appointments tab)

- [ ] Write failing test: clicking a patient row opens drawer with full header strip and four tab placeholders (Timeline, Journey, Appointments, Tasks)
- [ ] Run it, confirm failure
- [ ] Implement drawer + header + tab shell (tab bodies stubbed until M6–M9 wire them)
- [ ] Run test, confirm pass
- [ ] Browser verification: open Patient 360 from Patients list for a seeded patient
- [ ] Commit: `feat(web): Patient 360 header and tabbed drawer shell`

### M5.3 — Wire linked-family / multi-journey summary into header

**FILES**
- Modify: `patient360.service.ts`, `Patient360Header.tsx`
- Test: extend `patient360.test.ts` for the guardian→dependent seeded pair

- [ ] Write failing test: viewing the guardian's 360 shows linked-dependent summary
- [ ] Run it, confirm failure
- [ ] Implement linked-family rollup
- [ ] Run test, confirm pass
- [ ] Commit: `feat: linked-family summary on Patient 360 header`

---

## M6 — Journey Model + Journeys UI

Implements the locked §9 decision: dedicated `Journey` entity, never Lead-as-Journey.

### M6.1 — Journey + Pipeline/PipelineStage domain model (API)

**FILES**
- Create: `apps/api/src/domain/journey/{Journey.model.ts,PipelineStage.model.ts,journey.service.ts,journey.routes.ts}`, migration
- Test: `__tests__/journey.service.test.ts`

**INTERFACES**
- Consumes: `Patient` (M4)
- Produces: `Journey`, `PipelineStage` tables; `GET/POST /journeys`, `GET /journeys/:id`, `PATCH /journeys/:id/stage` — consumed by M6.3, M7, M8, M9, M10

- [ ] Write failing test: one patient can have two concurrent Journeys of different `journey_type` with independent stages; stage transitions validate against tenant's `PipelineStage` set
- [ ] Run it, confirm failure
- [ ] Implement model + service + routes, seed industry-default pipeline (spec §15-equivalent stage set: Enquiry → Contacted → Appointment Scheduled → Consulted → Treatment Proposed → Treatment Accepted → Completed → Lost/Declined)
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): dedicated Journey + PipelineStage domain model`

### M6.2 — Journey seed fixtures

**FILES**
- Modify: `apps/api/src/seed/fixtures/journeys.ts`, `seed.ts`
- Test: extend `seed.test.ts`

- [ ] Write failing test: seed produces journeys spanning fertility/paediatrics/general-OPD, multiple stages, including the guardian/dependent pair with distinct concurrent journeys
- [ ] Run it, confirm failure
- [ ] Author fixtures
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): realistic Journey seed fixtures`

### M6.3 — Journeys list UI

**FILES**
- Create: `apps/web/app/(app)/journeys/page.tsx` + loading/error states
- Test: `apps/web/__tests__/journeys-list.test.tsx` + E2E: filter by stage/owner/source/branch/date

**INTERFACES**
- Consumes: `GET /journeys`
- Produces: `/journeys` route, columns per spec §20 (Patient, Journey Type, Stage, Owner, Next Action placeholder, Last Contact placeholder, Source)

- [ ] Write failing test: list renders seeded journeys, filter bar narrows by stage/journey-type/source/branch/date
- [ ] Run it, confirm failure
- [ ] Implement page
- [ ] Run test, confirm pass
- [ ] Browser verification
- [ ] Commit: `feat(web): Journeys list — dense, filterable`

### M6.4 — Wire Journey tab into Patient 360; repoint dashboard Conversion queries

**FILES**
- Modify: `Patient360Header.tsx` tab body, `apps/api/src/domain/dashboard/conversion.service.ts`
- Test: extend `patient360.test.ts`, extend conversion dashboard test

- [ ] Write failing tests for both
- [ ] Run them, confirm failure
- [ ] Implement Journey tab body (stage, custom fields placeholder, treatment opportunities placeholder) and repoint conversion funnel to real `Journey`/`PipelineStage` data
- [ ] Run tests, confirm pass
- [ ] Regression: full journey + dashboard + patient360 suites green
- [ ] Commit: `feat: wire Journey data into Patient 360 and Conversion funnel`

---

## M7 — Unified Timeline

### M7.1 — Interaction domain model + write-through helper

**FILES**
- Create: `apps/api/src/domain/interaction/{Interaction.model.ts,interaction.service.ts,interaction.routes.ts}`, migration
- Test: `__tests__/interaction.service.test.ts`

**INTERFACES**
- Consumes: `Patient`, `Journey`
- Produces: `Interaction` table, `recordInteraction()` helper — consumed by M8 (task events), M9 (appointment events), M10 (outcome/treatment events), `GET /patients/:id/timeline`

- [ ] Write failing test: `recordInteraction()` writes a row with `event_type`, `actor_type`, `previous_value`/`new_value`, `metadata`; `GET /patients/:id/timeline` returns interleaved events across a patient's journeys, filterable to one `journey_id`
- [ ] Run it, confirm failure
- [ ] Implement model, service, routes
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): Interaction domain model and unified timeline query`

### M7.2 — Wire Journey stage transitions to emit Timeline events

**FILES**
- Modify: `journey.service.ts` (M6.1) stage-transition path
- Test: extend `journey.service.test.ts`

- [ ] Write failing test: changing a Journey's stage produces exactly one `Interaction` row with correct `previous_value`/`new_value`
- [ ] Run it, confirm failure
- [ ] Wire `recordInteraction()` call into the stage-transition path
- [ ] Run test, confirm pass
- [ ] Commit: `feat: Journey stage transitions emit Timeline events`

### M7.3 — Timeline UI component + wire into Patient 360

**FILES**
- Create: `packages/ui/src/Timeline.tsx` + tests
- Modify: `Patient360Header.tsx` Timeline tab body

**INTERFACES**
- Consumes: `GET /patients/:id/timeline`
- Produces: Timeline tab, primary tab per spec §8

- [ ] Write failing test: Timeline renders interleaved events chronologically, filterable to one journey, distinct icon/style per `event_type` category
- [ ] Run it, confirm failure
- [ ] Implement component and wire into Patient 360
- [ ] Run test, confirm pass
- [ ] Browser verification: view a seeded patient with multiple journeys, confirm interleaved + filtered views both work
- [ ] Commit: `feat(web): Timeline component wired into Patient 360`

---

## M8 — Tasks / Follow-ups / Next Action

### M8.1 — Task domain model

**FILES**
- Create: `apps/api/src/domain/task/{Task.model.ts,task.service.ts,task.routes.ts}`, migration
- Test: `__tests__/task.service.test.ts`

**INTERFACES**
- Consumes: `Patient`, `Journey`, `User` (assignee)
- Produces: `Task` table; `GET/POST /tasks`, `PATCH /tasks/:id` — consumed by M8.3, M9, M10, dashboard Attention queue

- [ ] Write failing test: creating a task with `parent_task_id` builds a retry chain; completing a task emits a Timeline event via `recordInteraction()`
- [ ] Run it, confirm failure
- [ ] Implement model, service, routes
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): Task domain model with retry chains and Timeline events`

### M8.2 — Next Action derivation + Tasks/Follow-ups list UI

**FILES**
- Create: `apps/web/app/(app)/follow-ups/page.tsx`, `apps/api/src/domain/task/nextAction.service.ts`
- Test: `__tests__/nextAction.service.test.ts`, `apps/web/__tests__/followups-list.test.tsx`

**INTERFACES**
- Consumes: `GET /tasks`
- Produces: `GET /journeys/:id/next-action` (nearest-due open task), `/follow-ups` route

- [ ] Write failing tests: `nextAction.service` returns the nearest-due open task per journey; follow-ups list renders assigned/priority/due-date, filterable by assignee/status
- [ ] Run them, confirm failure
- [ ] Implement service + page
- [ ] Run tests, confirm pass
- [ ] Browser verification
- [ ] Commit: `feat: Next Action derivation and Follow-ups list`

### M8.3 — Wire Next Action into Journeys list, Patient 360, and dashboard Attention queue

**FILES**
- Modify: `journeys/page.tsx` (M6.3), `Patient360Header.tsx` header strip, `apps/api/src/domain/dashboard/dashboard.service.ts` attention query
- Test: extend respective existing tests

- [ ] Write failing tests for all three integration points
- [ ] Run them, confirm failure
- [ ] Wire Next Action data through
- [ ] Run tests, confirm pass
- [ ] Regression: full task + journey + dashboard + patient360 suites green
- [ ] Commit: `feat: Next Action surfaced across Journeys list, Patient 360, Attention queue`

---

## M9 — Appointments

### M9.1 — Appointment domain model

**FILES**
- Create: `apps/api/src/domain/appointment/{Appointment.model.ts,appointment.service.ts,appointment.routes.ts}`, migration
- Test: `__tests__/appointment.service.test.ts`

**INTERFACES**
- Consumes: `Patient`, `Journey`, `Branch`, doctor `User`
- Produces: `Appointment` table (always FK'd to `journey_id` at creation, per spec §13); `GET/POST /appointments`, `PATCH /appointments/:id/state` — consumed by M9.2, M10, dashboards

- [ ] Write failing test: booking an appointment requires a `journey_id`; state transitions (scheduled → checked-in → with-doctor → completed/no-show/cancelled) validate legal transitions and emit Timeline events
- [ ] Run it, confirm failure
- [ ] Implement model, service, routes
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): Appointment domain model with state machine and Timeline events`

### M9.2 — Appointments UI (list + booking drawer + state actions)

**FILES**
- Create: `apps/web/app/(app)/appointments/page.tsx`, `packages/ui/src/AppointmentDrawer.tsx`
- Test: `apps/web/__tests__/appointments.test.tsx` + E2E: book appointment, advance state, confirm Timeline reflects it

**INTERFACES**
- Consumes: `GET/POST /appointments`, `PATCH /appointments/:id/state`
- Produces: `/appointments` route, consumed by M5 (Appointments tab), M9.3

- [ ] Write failing test: list renders today's appointments; booking drawer creates one tied to a journey; state action buttons advance state and disable illegal transitions
- [ ] Run it, confirm failure
- [ ] Implement page and drawer
- [ ] Run test, confirm pass
- [ ] Browser verification
- [ ] Commit: `feat(web): Appointments list, booking drawer, state actions`

### M9.3 — Wire Appointments into Patient 360, Doctor dashboard, Admin dashboard patient-flow

**FILES**
- Modify: `Patient360Header.tsx` Appointments tab, `apps/api/src/domain/dashboard/{doctor.service.ts,patientflow.service.ts}`
- Test: extend existing tests for each

- [ ] Write failing tests for all three integration points
- [ ] Run them, confirm failure
- [ ] Wire real Appointment data through, repointing remaining dashboard stubs
- [ ] Run tests, confirm pass
- [ ] Regression: full appointment + dashboard + patient360 + doctor-home suites green
- [ ] Commit: `feat: Appointments wired into Patient 360, Doctor and Admin dashboards`

---

## M10 — Consultation / Treatment / Post-care

### M10.1 — ConsultationOutcome + TreatmentOpportunity domain model

**FILES**
- Create: `apps/api/src/domain/treatment/{ConsultationOutcome.model.ts,TreatmentOpportunity.model.ts,treatment.service.ts,treatment.routes.ts}`, migration
- Test: `__tests__/treatment.service.test.ts`

**INTERFACES**
- Consumes: `Appointment` (M9), `Journey`
- Produces: `ConsultationOutcome`, `TreatmentOpportunity` tables; `POST /appointments/:id/outcome`, `GET/PATCH /treatment-opportunities/:id` — consumed by M10.2, M11

- [ ] Write failing test: recording an outcome with `treatment_recommended=true` auto-creates a `TreatmentOpportunity`; a Journey can hold multiple opportunities over time (declined then later accepted); every outcome/status change emits a Timeline event
- [ ] Run it, confirm failure
- [ ] Implement model, service, routes
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): ConsultationOutcome and TreatmentOpportunity domain model`

### M10.2 — Post-care task auto-creation on treatment completion

**FILES**
- Modify: `treatment.service.ts` (M10.1), consumes `task.service.ts` (M8.1)
- Test: extend `treatment.service.test.ts`

- [ ] Write failing test: `TreatmentOpportunity` reaching `status=completed` creates one recall `Task` per the fixed stage→template mapping (no general rule engine, per spec §14)
- [ ] Run it, confirm failure
- [ ] Implement fixed mapping
- [ ] Run test, confirm pass
- [ ] Commit: `feat: post-care recall task auto-creation on treatment completion`

### M10.3 — Treatment progression UI (outcome drawer, opportunity list)

**FILES**
- Create: `packages/ui/src/OutcomeDrawer.tsx`, `apps/web/app/(app)/treatment/page.tsx`
- Test: `apps/web/__tests__/treatment.test.tsx` + E2E: record outcome from an appointment, confirm opportunity appears

**INTERFACES**
- Consumes: `POST /appointments/:id/outcome`, `GET /treatment-opportunities`
- Produces: `/treatment` route, wired into Patient 360 Journey tab

- [ ] Write failing test: outcome drawer records treatment recommendation; treatment list shows opportunities by status, filterable
- [ ] Run it, confirm failure
- [ ] Implement drawer + list page, wire into Patient 360
- [ ] Run test, confirm pass
- [ ] Browser verification
- [ ] Commit: `feat(web): Treatment progression — outcome drawer, opportunity list`

---

## M11 — Source / Campaign / Revenue Context

### M11.1 — CampaignTouchpoint + RevenueEvent model, rollup query

**FILES**
- Create: `apps/api/src/domain/revenue/{CampaignTouchpoint.model.ts,revenue.service.ts,revenue.routes.ts}`, migration
- Test: `__tests__/revenue.service.test.ts`

**INTERFACES**
- Consumes: `Journey` (touchpoint recorded at creation), `TreatmentOpportunity.actual_value` (M10.1)
- Produces: `GET /revenue/rollup?groupBy=source|campaign|journeyType`

- [ ] Write failing test: rollup query correctly sums `actual_value` grouped by source/campaign/journey_type/date_range against seeded fixtures
- [ ] Run it, confirm failure
- [ ] Implement model and rollup query (single view/query, not a subsystem, per spec §15)
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): CampaignTouchpoint model and revenue rollup query`

### M11.2 — Source/revenue panel wired into Admin dashboard Marketing section

**FILES**
- Modify: `apps/api/src/domain/dashboard/marketing.service.ts`, `MarketingPanel.tsx`
- Test: extend `dashboard.today.test.ts`/marketing test, `apps/web` marketing panel test

- [ ] Write failing tests: marketing panel shows real revenue-per-source, replacing any placeholder
- [ ] Run them, confirm failure
- [ ] Repoint marketing dashboard query to `revenue.service.ts`
- [ ] Run tests, confirm pass
- [ ] Regression: full dashboard suite green
- [ ] Commit: `feat: real source/revenue context in Admin dashboard Marketing panel`

---

## M12 — Inbox / Conversations Shell

### M12.1 — Conversation + Message model, ownership-state field

**FILES**
- Create: `apps/api/src/domain/inbox/{Conversation.model.ts,Message.model.ts,inbox.service.ts,inbox.routes.ts}`, migration
- Test: `__tests__/inbox.service.test.ts`

**INTERFACES**
- Consumes: `Patient`, `Journey`
- Produces: `Conversation`, `Message` tables with `ownership_state` (`AI_ACTIVE|HUMAN_REQUIRED|HUMAN_ASSIGNED|HUMAN_ACTIVE|AI_RESUME_PENDING`); `GET /conversations`, `GET /conversations/:id/messages`, `PATCH /conversations/:id/ownership`

- [ ] Write failing test: ownership-state transitions follow the legal state graph from spec §11; illegal transitions rejected; every transition emits a Timeline event
- [ ] Run it, confirm failure
- [ ] Implement model, service, routes
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): Conversation/Message model with ownership-state machine`

### M12.2 — Inbox UI shell (conversation list + thread view, no live send required)

**FILES**
- Create: `apps/web/app/(app)/inbox/page.tsx`, `packages/ui/src/{ConversationList,ThreadView,OwnershipBadge}.tsx`
- Test: `apps/web/__tests__/inbox.test.tsx` + E2E: select conversation, view thread, toggle ownership

**INTERFACES**
- Consumes: `GET /conversations`, `GET /conversations/:id/messages`, `PATCH /conversations/:id/ownership`
- Produces: `/inbox` route — reviewable shell, no `WhatsAppProvider` wiring yet (deferred to M14)

- [ ] Write failing test: inbox lists seeded conversations, selecting one shows thread + ownership badge, staff can claim (`HUMAN_ASSIGNED`) and hand back (`AI_RESUME_PENDING`)
- [ ] Run it, confirm failure
- [ ] Implement components and page, seed demo conversations/messages
- [ ] Run test, confirm pass
- [ ] Browser verification
- [ ] Commit: `feat(web): Inbox shell — conversation list, thread view, ownership toggle`

---

## PulseOS Visual Prototype Cut Line

**Reached at the end of M12.** At this point PulseOS is browser-reviewable end to end with real, persisted core domain data:

- Login, shell, role-aware navigation
- Admin Command Centre (all seven sections, drill-down working)
- Doctor Command Centre (role-distinct)
- Patients list + Patient 360 (real data)
- Journeys list (dedicated `Journey` entity, real data)
- Unified Timeline (real `Interaction` table, write-through from stage/task/appointment/outcome events)
- Follow-ups / Tasks with Next Action surfaced everywhere
- Appointments (booking, state machine)
- Treatment progression (outcome → opportunity → post-care task)
- Source / revenue context (real rollup)
- Inbox shell (real conversation/ownership model; WhatsApp send is not yet live — that's M14)

External integrations (WhatsApp send/receive, telephony receive, ad-platform attribution) remain mocked/deferred past this line, per the approved spec's prototype boundary. This is intentional: the cut line proves the product on real persisted domain data without requiring live third-party credentials to be reviewable.

---

## M13 — Role / Permission Enforcement

### M13.1 — Permission model + grant table

**FILES**
- Create: `apps/api/src/domain/user/Permission.model.ts`, migration, seed grants per role
- Test: `__tests__/permission.service.test.ts`

- [ ] Write failing test: fine-grained permission keys (`journey.reassign_any`, `appointment.manage_all_doctors`, `ai.silence_toggle`, `billing.view`) grant/deny correctly per seeded role
- [ ] Run it, confirm failure
- [ ] Implement model + seed grants
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): fine-grained permission model`

### M13.2 — Route-level and UI-level permission enforcement

**FILES**
- Modify: `auth.middleware.ts` (add permission check), `RoleGate.tsx` → extend to `PermissionGate.tsx`
- Test: extend route tests for at least one permission-gated endpoint per domain module; extend `shell.test.tsx`

- [ ] Write failing tests: a `RECEPTION` user hitting `billing.view`-gated data gets 403; UI hides billing/revenue elements without the grant
- [ ] Run them, confirm failure
- [ ] Implement middleware check + `PermissionGate` component, apply to revenue/billing surfaces from M11
- [ ] Run tests, confirm pass
- [ ] Regression: full suite green
- [ ] Commit: `feat: enforce fine-grained permissions at route and UI level`

### M13.3 — Doctor-nav permission audit

**FILES**
- Modify: `Sidebar.tsx` nav config
- Test: extend `shell.test.tsx`

- [ ] Write failing test: doctor nav excludes Campaigns/Analytics/Team/Integrations unless explicitly granted
- [ ] Run it, confirm failure
- [ ] Implement nav filtering by permission set
- [ ] Run test, confirm pass
- [ ] Commit: `feat: permission-filtered navigation for reduced doctor nav set`

---

## M14 — Adapter Foundations / Selective Module Extraction

### M14.1 — Provider adapter interfaces (no live implementations yet)

**FILES**
- Create: `apps/api/src/adapters/{WhatsAppProvider.ts,TelephonyProvider.ts,AdsProvider.ts,LLMProvider.ts,StorageProvider.ts}` (interfaces + a `NullProvider`/mock implementation each)
- Test: `__tests__/adapters.contract.test.ts`

- [ ] Write failing test: each interface's mock implementation satisfies its contract (typed method signatures, no PulseOS domain types leak provider-specific shapes)
- [ ] Run it, confirm failure
- [ ] Implement interfaces + mocks
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): provider adapter interfaces and mock implementations`

### M14.2 — Extract WhatsApp Cloud API pattern from `invictus-chatbot` into `WhatsAppProvider`

**FILES**
- Create: `apps/api/src/adapters/whatsapp/CloudApiProvider.ts`
- Test: `__tests__/whatsapp.cloudapi.test.ts`

**INTERFACES**
- Consumes: reference-only reading of `invictus-chatbot/src/models/AuthWhatsapp/*` (no import, no runtime dependency — pattern extracted and rewritten)
- Produces: real `WhatsAppProvider` implementation, with the signature-verification hardening noted in the original spec applied from day one (not retrofitted)

- [ ] Write failing test: webhook signature verification rejects unsigned/invalid payloads; valid payload maps to a `Message`/`Conversation` write via `inbox.service.ts`
- [ ] Run it, confirm failure
- [ ] Implement adapter, adapted to PulseOS interfaces, with signature verification built in
- [ ] Run test, confirm pass
- [ ] Commit: `feat(api): WhatsApp Cloud API provider extracted and adapted from reference implementation`

### M14.3 — Extract custom-field and assignment/follow-up patterns from Lead Panel

**FILES**
- Create: `apps/api/src/domain/customfield/{CustomFieldDefinition.model.ts,CustomFieldValue.model.ts,customfield.service.ts}`, `apps/api/src/domain/task/assignmentRule.service.ts`
- Test: `__tests__/customfield.service.test.ts`, `__tests__/assignmentRule.service.test.ts`

**INTERFACES**
- Consumes: reference-only reading of `backend/src/database/tables/CrmCustomFieldTable`, `BirthwaveAssignmentRuleTable` (no runtime import)
- Produces: `CustomFieldDefinition`/`CustomFieldValue` tables, round-robin `AssignmentRuleTable`

- [ ] Write failing tests: custom field CRUD/reorder/archive works per tenant/entity_type without any Lead-Panel-specific tenant gate; round-robin assignment cycles correctly across a team
- [ ] Run them, confirm failure
- [ ] Implement, adapted to PulseOS tenant scoping
- [ ] Run tests, confirm pass
- [ ] Commit: `feat(api): custom fields and assignment rules extracted and adapted from reference implementation`

---

## M15 — Security / Testing / Production Hardening

### M15.1 — Auth hardening (httpOnly cookie, refresh rotation, denylist)

**FILES**
- Modify: `auth.service.ts`, `auth.middleware.ts`
- Test: extend `auth.service.test.ts`

- [ ] Write failing test: refresh-token reuse after rotation is rejected
- [ ] Run it, confirm failure
- [ ] Implement denylist (Redis set with TTL)
- [ ] Run test, confirm pass
- [ ] Commit: `security: refresh-token rotation denylist`

### M15.2 — Consent + audit event logging

**FILES**
- Create: `apps/api/src/domain/consent/Consent.model.ts`, `apps/api/src/domain/audit/AuditEvent.model.ts` + redaction middleware (pattern extracted per M14 discipline from Lead Panel's audit logger)
- Test: `__tests__/consent.test.ts`, `__tests__/audit.test.ts`

- [ ] Write failing tests: consent capture on first WhatsApp opt-in; audit log redacts `password|token|authorization|secret|api_key|signature` fields
- [ ] Run them, confirm failure
- [ ] Implement
- [ ] Run tests, confirm pass
- [ ] Commit: `security: consent capture and redacted audit logging`

### M15.3 — First critical E2E flow + CI gate

**FILES**
- Create: `e2e/critical-path.spec.ts` (login → view Admin Command Centre → open a Patient → view Journey → book Appointment → record Outcome → confirm Timeline entry)
- Modify: `.github/workflows/ci.yml` (add E2E job)

- [ ] Write the E2E spec against seeded data
- [ ] Run it, confirm it fails on a deliberately broken step (sanity-check the test itself catches regressions)
- [ ] Fix/confirm the real flow, run green
- [ ] Wire into CI as a required check
- [ ] Commit: `test: critical-path E2E flow, gated in CI`

---

## M16 — Mobile (Deferred)

Not started until the web prototype is reviewed and approved. `apps/mobile` scaffolding, shared `packages/types`/`packages/api-client` consumption, and the companion-app scope (schedule, patient lookup, outcome capture, task list, push notifications) are planned in a separate follow-up plan once M0–M15 are stable, per the spec's Phase 3.

---

## Reporting Standard (applies to every execution report from here on)

Each module's completion report must include:

- **PAGE LINKS** — exact running app URL + exact route per page built/modified
- **DEMO CREDENTIALS** — seeded demo login only, never secrets/tokens/DB credentials
- **HOW TO RUN** — exact commands (`npm run dev`, `npm run seed`, etc.)
- **WHAT TO REVIEW FIRST** — top 2–3 visual screens/features from that module

---

## Changelog / Open Technical Choices

To be resolved at M0 implementation time and recorded here (not left as "TBD" in task bodies):
- Backend framework: Express vs. Fastify
- ORM: Prisma vs. Drizzle
- Database: Postgres vs. MySQL
- Test runner: Vitest vs. Jest
- E2E: Playwright (default assumption, confirm at M15.3)

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
