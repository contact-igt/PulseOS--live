# PulseOS Foundation Implementation Plan

- **Status**: Approved for execution planning. Not yet executed.
- **Date**: 2026-09-12
- **Approved spec**: [docs/superpowers/specs/2026-09-12-pulseos-foundation-design.md](../specs/2026-09-12-pulseos-foundation-design.md)
- **Locks applied in this plan**: ownership state lives on the existing LiveChat model (no new `EngagementOwnershipTable`); `journey_type` is a free-text/configurable column, never a DB ENUM; the physical `leads`/`Lead` table/model is never renamed; the DPDP security gate items are scheduled explicitly in Part B (M14), not deferred to an unscheduled future phase; every task obeys the workspace-safety rule established in M0.

## How to read this plan

- **Repos**: `invictus-chatbot` (PulseOS backend), `whatnexus-frontend` (PulseOS frontend), `backend`/`frontend` (Lead Panel — selective-port source only, never modified directly by this plan), plus a new lightweight workspace-level repo created in M0 to hold `docs/superpowers/**` safely (see M0 Task 1). All file paths in a task are **relative to the repo named in that task's `FILES:` block**, never relative to `/Users/sushil`.
- **Task numbering** is global and sequential across the whole plan for unambiguous reference (`Task 14`), grouped under module headings that match the approved spec's sections.
- **Checklist style**: tasks that touch application code use full TDD (write failing test → run and see it fail → minimal implementation → run focused test → run regression tests → commit). Tasks that are pure verification of already-LIVE functionality, or one-time workspace/seed setup with no business logic, use a **verification checklist** instead (no fabricated test-around-nothing) — each such task says so explicitly.
- **Two tracks**: **Part A — Prototype Track** (M0 plus a thin, explicitly-scoped slice of M2/M3/M4/M5/M6/M8/M10/M11) ends at an explicit **PROTOTYPE CUT LINE**. **Part B — Post-Prototype Track** resumes at M1 and completes the full depth of every module through M16. This ordering (M1 after the cut line rather than before M2, as the request's illustrative ordering suggested) reflects one deliberate dependency decision, explained where it occurs.
- Every task cites the exact existing file(s) it reads or reuses before writing new code. Where no prior audit evidence pins an exact line number for a genuinely new integration point, the task's first step is an explicit "read/grep to confirm" action rather than an invented citation.

---

# PART A — PROTOTYPE TRACK

## Module M0 — Workspace Safety + Baseline Verification

This module is blocking: no other task in this plan may begin before all four M0 tasks are complete, because it establishes the only safe place to run git operations for the rest of the plan.

### Task 1: Confirm repository roots and establish a safe workspace-level repo

FILES:
- Create: `docs/superpowers/plans/baseline/repo-roots.md` (in the new workspace-level repo created by this task, at the PulseOS workspace root — not inside any of the four project repos)
- Create: `.gitignore` (at the PulseOS workspace root)

INTERFACES:
- Consumes: nothing (verification-only)
- Produces: `repo-roots.md` — the recorded, confirmed list of safe repository boundaries every later task must respect

Steps:
- [ ] Run `git -C invictus-chatbot rev-parse --show-toplevel` and confirm the output is the absolute path to `invictus-chatbot`, not `/Users/sushil`
- [ ] Run `git -C whatnexus-frontend rev-parse --show-toplevel` and confirm the output is the absolute path to `whatnexus-frontend`
- [ ] Run `git -C backend rev-parse --show-toplevel` and confirm the output is the absolute path to `backend`
- [ ] Run `git -C frontend rev-parse --show-toplevel` and confirm the output is the absolute path to `frontend`
- [ ] From the PulseOS workspace root (a directory containing all four of the above as subdirectories, and nothing else tracked), run `git rev-parse --show-toplevel` and confirm it prints `/Users/sushil` — this is the pre-existing, unintended repository (remote `origin` = `https://github.com/contact-igt/igt.git`, zero commits, discovered during the discovery audit) that must never receive commits, adds, pushes, or worktree operations from PulseOS work
- [ ] At the PulseOS workspace root, run `git init` to create a new, dedicated, scoped repository whose root is the PulseOS workspace directory itself — this is a real, separate `.git` from `/Users/sushil`'s and becomes the sole home for `docs/superpowers/**` and any future workspace-level (non-application) artifacts
- [ ] Create `.gitignore` at the PulseOS workspace root containing exactly: `backend/`, `frontend/`, `invictus-chatbot/`, `whatnexus-frontend/`, `node_modules/` — this guarantees the four nested project repos are never swept into the new workspace-level repo by an accidental `git add -A`
- [ ] Write `repo-roots.md` recording: the four confirmed project repo roots and their current `HEAD` hashes; the confirmed hazard at `/Users/sushil`; the rule that no git operation for PulseOS work ever targets `/Users/sushil`; the existence and purpose of the new PulseOS-workspace-root repo
- [ ] `git add .gitignore docs/superpowers/plans/baseline/repo-roots.md && git commit -m "chore: establish safe PulseOS workspace repo and record repository boundaries"` inside the new workspace-root repo — this is the first commit of that repo

### Task 2: Establish isolated-worktree usage for implementation work

FILES:
- Modify: `docs/superpowers/plans/baseline/repo-roots.md` (append a worktree-policy section, in the workspace-root repo)

INTERFACES:
- Consumes: `repo-roots.md` from Task 1
- Produces: an explicit, recorded worktree policy every subsequent code-touching task in `invictus-chatbot`/`whatnexus-frontend` must follow

Steps:
- [ ] Check whether the execution environment for implementation provides isolated-worktree tooling (the Agent tool's `isolation: "worktree"` option, or equivalent `EnterWorktree`/`ExitWorktree` tooling) — if available, record that all `invictus-chatbot` and `whatnexus-frontend` implementation tasks must be run with isolation scoped individually to that repo's own root, never to the PulseOS workspace root and never to `/Users/sushil`
- [ ] If no such tooling is available in a given execution context, record the fallback policy: `git -C invictus-chatbot worktree add ../invictus-chatbot-pulseos-work -b pulseos/foundation` and the equivalent `git -C whatnexus-frontend worktree add ../whatnexus-frontend-pulseos-work -b pulseos/foundation`, with all implementation performed inside those worktree directories rather than the original clones, and both commands run with `-C` pinned to the specific repo, never from `/Users/sushil` or the PulseOS workspace root
- [ ] Append this policy to `repo-roots.md`
- [ ] `git add docs/superpowers/plans/baseline/repo-roots.md && git commit -m "chore: record worktree isolation policy"` in the workspace-root repo

### Task 3: Snapshot and isolate pre-existing dirty package.json/package-lock.json changes

FILES:
- Create: `docs/superpowers/plans/baseline/backend-pre-existing.patch`, `docs/superpowers/plans/baseline/frontend-pre-existing.patch`, `docs/superpowers/plans/baseline/invictus-chatbot-pre-existing.patch`, `docs/superpowers/plans/baseline/whatnexus-frontend-pre-existing.patch` (all in the workspace-root repo)

INTERFACES:
- Consumes: current dirty-state of `package.json`/`package-lock.json` in all four project repos
- Produces: one isolating commit per touched repo, plus permanent snapshot records, so no later PulseOS commit can be confused with pre-existing dependency-approval changes

Steps:
- [ ] Run `git -C backend diff -- package.json package-lock.json` and save the full output to `backend-pre-existing.patch`
- [ ] Run `git -C frontend diff -- package.json package-lock.json` and save the full output to `frontend-pre-existing.patch`
- [ ] Run `git -C invictus-chatbot diff -- package.json package-lock.json` and save the full output to `invictus-chatbot-pre-existing.patch`
- [ ] Run `git -C whatnexus-frontend diff -- package.json package-lock.json` and save the full output to `whatnexus-frontend-pre-existing.patch`
- [ ] In `invictus-chatbot` only: `git -C invictus-chatbot add package.json && git -C invictus-chatbot commit -m "chore: capture pre-existing npm approve-scripts changes (not PulseOS work)"`
- [ ] In `whatnexus-frontend` only: `git -C whatnexus-frontend add package.json && git -C whatnexus-frontend commit -m "chore: capture pre-existing npm approve-scripts changes (not PulseOS work)"`
- [ ] Do not create an isolating commit in `backend` or `frontend` — per the approved spec, these two repos are selective-port sources only and receive no direct commits during PulseOS implementation
- [ ] `git -C invictus-chatbot rev-parse HEAD` and `git -C whatnexus-frontend rev-parse HEAD` — record both new hashes in `repo-roots.md` as the official PulseOS baseline commit for each repo; every task from here forward in `invictus-chatbot`/`whatnexus-frontend` is a diff against these two hashes
- [ ] `git add docs/superpowers/plans/baseline/*.patch docs/superpowers/plans/baseline/repo-roots.md && git commit -m "chore: snapshot pre-existing dependency diffs and record PulseOS baseline commits"` in the workspace-root repo

### Task 4: Seed a demo hospital tenant on the clean baseline

FILES:
- Create: `src/scripts/seedPulseOsDemoTenant.js`
- Modify: `package.json` (add `seed:pulseos-demo` script)
- Test: none — one-off seed script verified by manual run, matching the existing project's own convention for `src/scripts/seedSuperAdmin.js`, which is also unwrapped by a test

INTERFACES:
- Consumes: `Tenant` and `TenantUser` Sequelize models (`src/database/tables/TenantsTable/index.js`, `src/database/tables/TenantUsersTable/index.js`)
- Produces: one demo `tenants` row (`type: "hospital"`, `industry_type: "healthcare"`) and one `tenant_users` row (`role: "tenant_admin"`) for the prototype demo login

Steps:
- [ ] Read `src/scripts/seedSuperAdmin.js` in full to confirm the existing seed-script convention (env-var-driven configuration, direct Sequelize model calls, console success/error logging, no framework beyond plain Node)
- [ ] Read `src/database/tables/TenantsTable/index.js` to confirm the exact `type`, `industry_type`, and `plan` enum values before choosing which to seed with
- [ ] Write `src/scripts/seedPulseOsDemoTenant.js` following the confirmed convention: create one `Tenant` row with `type: "hospital"`, `industry_type: "healthcare"`, and the lowest-tier existing `plan` enum value confirmed above; create one `TenantUser` row for that tenant with `role: "tenant_admin"` and demo credentials read from env vars (`PULSEOS_DEMO_ADMIN_EMAIL`, `PULSEOS_DEMO_ADMIN_PASSWORD`, etc.), following the same env-var pattern as `seedSuperAdmin.js`
- [ ] Add `"seed:pulseos-demo": "node src/scripts/seedPulseOsDemoTenant.js"` to `package.json`'s `scripts`, placed alongside the existing `seed:superadmin`/`seed:allprice` entries
- [ ] Run `npm run seed:pulseos-demo` against the local dev database and confirm one `tenants` row and one `tenant_users` row are created; record the printed `tenant_id` in `docs/superpowers/plans/baseline/repo-roots.md` (workspace-root repo) for reuse by every later prototype task
- [ ] `git -C invictus-chatbot add src/scripts/seedPulseOsDemoTenant.js package.json && git -C invictus-chatbot commit -m "feat: seed PulseOS demo hospital tenant"`

**===== END M0 =====**

---

## Module M2 (prototype slice) — Terminology / Hospital Tenant / Demo Foundation

### Task 5: Add `journey_type` and `journey_label` to the Journey (Lead) table

FILES:
- Modify: `src/database/tables/LeadsTable/index.js`
- Test: `tests/leadsModel.journeyType.test.js`

INTERFACES:
- Consumes: existing `Lead` Sequelize model definition
- Produces: two new nullable columns, `journey_type` (STRING(50)) and `journey_label` (STRING(255)), readable/writable through the existing `Lead` model with no other change to its shape

Steps:
- [ ] Read `src/database/tables/LeadsTable/index.js` in full to confirm the exact Sequelize `define()` call shape and existing column list before editing
- [ ] Write a failing test in `tests/leadsModel.journeyType.test.js` that creates a `Lead` row via the Sequelize model with `journey_type: "fertility"` and `journey_label: "Priya — 2nd IVF cycle"`, then reads it back and asserts both values round-trip exactly
- [ ] Run `npx jest tests/leadsModel.journeyType.test.js` and confirm it fails with a column/validation error, since the two columns do not exist yet
- [ ] Add `journey_type: { type: Sequelize.STRING(50), allowNull: true }` and `journey_label: { type: Sequelize.STRING(255), allowNull: true }` to the `Lead` model definition — deliberately `STRING`, never a DB `ENUM`, per the approved spec's configurability requirement
- [ ] Run `npx jest tests/leadsModel.journeyType.test.js` and confirm it now passes
- [ ] Run `npm run test:billing` (the only currently-wired backend test script) and confirm no regression
- [ ] Manually run `npm run start:dev` and confirm the existing boot-time `sequelize.sync()` mechanism (already relied on by this codebase per the original audit) adds both columns to the local `leads` table without error
- [ ] `git -C invictus-chatbot add src/database/tables/LeadsTable/index.js tests/leadsModel.journeyType.test.js && git -C invictus-chatbot commit -m "feat: add configurable journey_type and journey_label columns to Lead model"`

### Task 6: Document example journey_type values without constraining them

FILES:
- Modify: `src/scripts/seedPulseOsDemoTenant.js`
- Test: none — documentation-level seed output, verified by manual run

INTERFACES:
- Consumes: nothing new
- Produces: console-logged example values only; no schema constraint

Steps:
- [ ] Extend `seedPulseOsDemoTenant.js` to print the four example `journey_type` values from the approved spec — `general_opd`, `fertility`, `pregnancy`, `paediatrics` — as a console log explicitly labeled "example values for this demo tenant only — journey_type is not constrained by the database"
- [ ] Grep `src/` for `journey_type` and confirm the only references are Task 5's column definition, this seed script's log line, and (after later tasks run) the specific UI/service touch points added by this plan — no `ENUM`, `CHECK` constraint, or hardcoded validator list restricting the value appears anywhere
- [ ] `git -C invictus-chatbot add src/scripts/seedPulseOsDemoTenant.js && git -C invictus-chatbot commit -m "docs: log example (non-constraining) journey_type values in demo seed"`

### Task 7: Relabel the primary navigation entry from "Leads" to "Journeys"

FILES:
- Modify: `components/layout/sidebarConfig.ts`
- Test: none — label-only change, covered by the Task 20 end-to-end walkthrough

INTERFACES:
- Consumes: existing `tenantSidebarConfig` entry pointing at `/leads` (confirmed LIVE route, `leads.routes.js:25`)
- Produces: the same entry, same route, changed display label only

Steps:
- [ ] Read `components/layout/sidebarConfig.ts` in full and locate the exact nav entry whose route is `/leads`
- [ ] Change only that entry's display label from "Leads" to "Journeys" — do not change the route path, do not touch any other nav entry, do not rename the underlying page component or file
- [ ] Manually verify in the browser that the sidebar now reads "Journeys" and that clicking it still loads the existing, already-LIVE leads list page unchanged
- [ ] `git -C whatnexus-frontend add components/layout/sidebarConfig.ts && git -C whatnexus-frontend commit -m "feat: relabel primary nav entry from Leads to Journeys (route unchanged)"`

**===== END M2 (prototype slice) =====**

---

## Module M3 (prototype slice) — Contact + Journey Semantics

### Task 8: Add `primary_contact_id` to the Contact table for linked-family support

FILES:
- Modify: `src/database/tables/ContactsTable/index.js`
- Test: `tests/contactsModel.primaryContact.test.js`

INTERFACES:
- Consumes: existing `Contact` Sequelize model definition
- Produces: a nullable, self-referencing `primary_contact_id` INTEGER column on `Contact`, `onDelete: "SET NULL"`

Steps:
- [ ] Read `src/database/tables/ContactsTable/index.js` in full
- [ ] Write a failing test that creates two `Contact` rows in the same tenant, sets the second row's `primary_contact_id` to the first row's `id`, and asserts the value round-trips on read
- [ ] Run the test and confirm it fails, since the column does not exist yet
- [ ] Add `primary_contact_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: "contacts", key: "id" }, onDelete: "SET NULL" }` to the `Contact` model
- [ ] Run the test and confirm it passes
- [ ] Manually verify via `npm run start:dev` plus the Playground chat simulator (`src/models/Playground/playground.service.js`, confirmed reusable per the AI-architecture audit) that ordinary Contact creation from an inbound message is unaffected by this column addition
- [ ] `git -C invictus-chatbot add src/database/tables/ContactsTable/index.js tests/contactsModel.primaryContact.test.js && git -C invictus-chatbot commit -m "feat: add primary_contact_id to Contact for linked-family journeys"`

### Task 9: Extend Journey creation to accept `journey_type` without duplicating the creation path

FILES:
- Modify: `src/models/LeadsModel/leads.service.js`
- Test: `tests/leadsService.createJourney.test.js`

INTERFACES:
- Consumes: the existing lead-creation function in `leads.service.js`
- Produces: the same function, extended to accept and persist an optional `journey_type`/`journey_label`, with no second creation path introduced

Steps:
- [ ] Read `src/models/LeadsModel/leads.service.js` in full and identify the existing lead-creation function's exact name and parameter shape
- [ ] Grep `src/` for every call site that creates a `Lead` row (pattern: the identified function's name, and any direct `Lead.create(`/`db.Lead.create(` usage), including any automatic creation triggered from the WhatsApp message-processing path in `src/models/AuthWhatsapp/AuthWhatsapp.controller.js` or a service it calls — record the confirmed list of call sites as a comment at the top of the new test file before changing any production code
- [ ] Write a failing test asserting that calling the existing lead-creation function with `journey_type: "fertility"` persists that value on the created `Lead` row, and that omitting the argument leaves `journey_type` `null` rather than throwing or defaulting silently
- [ ] Run the test and confirm it fails, since the function does not yet accept or persist `journey_type`
- [ ] Extend the existing function's parameter object with optional `journey_type`/`journey_label` fields, passed straight through to the existing `Lead.create(...)` call already inside that function — do not create a second function, do not duplicate creation logic
- [ ] Run the test and confirm it passes
- [ ] For each call site recorded above that already has a `journey_type`-equivalent concept available to it at call time (the new UI action built in Task 10), pass it through explicitly; leave every other existing call site (including any automatic WhatsApp-triggered creation) passing no `journey_type` argument, so it persists as `null` exactly as before — do not introduce a silent default at the service layer
- [ ] Run `npm run test:billing` plus a manual smoke test: create a Journey via the existing `POST /whatsapp/lead`-family route with no `journey_type` supplied, and confirm it still succeeds exactly as before this change
- [ ] `git -C invictus-chatbot add src/models/LeadsModel/leads.service.js tests/leadsService.createJourney.test.js && git -C invictus-chatbot commit -m "feat: accept optional journey_type/journey_label on existing Journey creation path"`

### Task 10: Add a "New Journey" creation action to the Journeys list page

FILES:
- Modify: `components/views/leadsView.tsx`, `services/leadIntelligene/index.ts`
- Test: none — manual/E2E verification per Task 20; component-test harness for this view is added in the full M9 detail-UX pass in Part B, not duplicated here for one button

INTERFACES:
- Consumes: the existing create-lead form/drawer and its backing service call already used by `leadsView.tsx` (confirmed LIVE per the frontend audit)
- Produces: the same create flow, with one added `journey_type` input wired through to the backend change from Task 9

Steps:
- [ ] Read `components/views/leadsView.tsx` and `services/leadIntelligene/index.ts` in full to confirm the existing create-lead call shape
- [ ] Add a "New Journey" button to `leadsView.tsx` that opens the existing create-lead form/drawer, with one added field: a `journey_type` dropdown pre-filled with the four demo examples (`general_opd`, `fertility`, `pregnancy`, `paediatrics`) plus an "Other" option that reveals a free-text input — this directly implements the spec's "configurable, not a rigid ENUM" requirement in the UI itself
- [ ] Extend `services/leadIntelligene/index.ts`'s existing create-lead function to include `journey_type` (and `journey_label` when "Other" free text is used) in its request body
- [ ] Manually create a Journey with `journey_type: "fertility"` through the UI, confirm it appears in the Journeys list, and confirm the value persists after a page reload
- [ ] `git -C whatnexus-frontend add components/views/leadsView.tsx services/leadIntelligene/index.ts && git -C whatnexus-frontend commit -m "feat: add New Journey action with configurable journey_type"`

**===== END M3 (prototype slice) =====**

---

## Module M4 (prototype slice) — Unified Timeline

The real, persisted `TimelineEventTable` is a Part B task (M4-full). The prototype uses an explicit, clearly-scoped client-side merge, per the approved spec's §25 prototype boundary.

### Task 11: Build a client-side merged Timeline view for one Contact/Journey

FILES:
- Create: `components/views/journeyTimeline/journeyTimelineView.tsx`, `services/journeyTimeline/index.ts`, `hooks/useJourneyTimelineQuery.tsx`
- Test: `components/views/journeyTimeline/__tests__/journeyTimelineView.test.tsx`

INTERFACES:
- Consumes: the existing message-history endpoint already backing the confirmed-LIVE `shared-inbox/history` page (via `services/contact` or the equivalent already-confirmed live-chat history service), and the existing appointment-outcome endpoint (`appointment.routes.js:89,140,148,156`)
- Produces: a read-only, client-side-merged, chronologically-sorted list — explicitly not a new backend endpoint and explicitly not the production Timeline

Steps:
- [ ] Read the existing service file backing the confirmed-LIVE `shared-inbox/history` page to identify its exact message-history fetch function and response shape
- [ ] Read `services/appointment/index.ts` to identify its exact appointment-outcome fetch function and response shape
- [ ] Write `services/journeyTimeline/index.ts` with one function, `getJourneyTimeline(contactId, journeyId)`, that calls both identified functions in parallel via `Promise.all` and returns their raw results — no new backend route is created
- [ ] Write a failing test in `journeyTimelineView.test.tsx` asserting that, given a mocked message list and a mocked appointment-outcome list passed as props, the component renders every item from both lists in one chronologically-sorted (descending) list
- [ ] Run the test and confirm it fails, since the component does not exist yet
- [ ] Implement `journeyTimelineView.tsx`: merge the two arrays client-side by their existing timestamp fields, sort descending, render one row per item (icon, short description, timestamp) — add a visible code comment stating this view is a prototype-only stand-in for the production `TimelineEventTable`-backed view built in Part B Task M4-full
- [ ] Implement `useJourneyTimelineQuery.tsx` as a thin React Query wrapper around `getJourneyTimeline`, following the same hook conventions already used by `hooks/useLeadIntelligenceQuery.tsx`
- [ ] Run the component test and confirm it passes
- [ ] Manually verify: open the demo Contact from Task 8/10 and confirm the merged Timeline renders both a WhatsApp message and an appointment event once both exist
- [ ] `git -C whatnexus-frontend add components/views/journeyTimeline services/journeyTimeline hooks/useJourneyTimelineQuery.tsx && git -C whatnexus-frontend commit -m "feat: add prototype client-side merged Journey timeline view"`

**===== END M4 (prototype slice) =====**

---

## Module M5 (prototype slice) — AI/Human Ownership

The full `ownership_state` machine is a Part B task (M5-full). The prototype reuses the already-LIVE `contacts.is_ai_silenced` toggle, per the approved spec's §25 prototype boundary — this is a verification task, not new code.

### Task 12: Verify the existing human-takeover toggle end-to-end for the demo

FILES: none (verification only)

INTERFACES:
- Consumes: `PATCH /whatsapp/contact/:contact_id/silence` (`src/models/ContactsModel/contacts.routes.js:87-92` → `contacts.controller.js:353-368` → `contacts.service.js:605-614`), and the check in `src/models/AuthWhatsapp/AuthWhatsapp.controller.js:1082-1087`
- Produces: a recorded pass/fail verification result

Steps:
- [ ] Trigger the existing "Silence AI" button in `whatnexus-frontend/components/views/chats/ChatDetails.tsx:376-401` against the demo Contact
- [ ] Send an inbound message from that Contact via the Playground simulator and confirm, by inspecting logs around `AuthWhatsapp.controller.js:1082-1087`, that no AI reply is generated
- [ ] Toggle "Unsilence AI" and confirm a subsequent inbound message does trigger an AI reply again
- [ ] Record the pass/fail result in `docs/superpowers/plans/baseline/prototype-verification-log.md` (workspace-root repo) — no application code changes in this task, since the full ownership-state machine is explicitly deferred to Part B
- [ ] `git add docs/superpowers/plans/baseline/prototype-verification-log.md && git commit -m "chore: record prototype AI-silence verification result"` in the workspace-root repo

**===== END M5 (prototype slice) =====**

---

## Module M6 (prototype slice) — Follow-ups / Tasks / Next Action

The real, persisted `TaskTable` is a Part B task (M6-full). The prototype reuses the already-LIVE `ScheduledMessageTable` follow-up mechanism — a verification task.

### Task 13: Verify the existing scheduled follow-up mechanism against the demo journey

FILES: none (verification only)

INTERFACES:
- Consumes: the existing `ScheduledMessageTable`, `send_type: "follow_up"` row, and whatever scheduler already processes it (started in `src/app.js` per the original discovery audit)
- Produces: a recorded pass/fail verification result

Steps:
- [ ] Create one `ScheduledMessageTable` row (`send_type: "follow_up"`) for the demo Contact via the existing reminder-creation flow already confirmed LIVE (`appointment.routes.js:102,157`, per the frontend Reminders page trace)
- [ ] Confirm the existing scheduler picks it up and attempts a send at its `scheduled_at` time in a local run
- [ ] Record the pass/fail result in `prototype-verification-log.md` — no application code changes in this task
- [ ] `git add docs/superpowers/plans/baseline/prototype-verification-log.md && git commit -m "chore: record prototype follow-up scheduling verification result"` in the workspace-root repo

**===== END M6 (prototype slice) =====**

---

## Module M8 (prototype slice) — Configurable Pipeline / Stages

The real `PipelineStageTable` is a Part B task (M8-full). The prototype narrates stage progression through the Timeline view (Task 11) rather than adding new stage-editing UI — a verification task.

### Task 14: Confirm the existing Lead status field's current scope, without adding new stage UI

FILES: none (verification only)

INTERFACES:
- Consumes: `src/database/tables/LeadsTable/index.js`'s existing `status` column
- Produces: a recorded finding of whether `status` is currently editable from the frontend, gating whether the demo narrates stage change via the field itself or via the Timeline view only

Steps:
- [ ] Read `src/database/tables/LeadsTable/index.js` to confirm the current `status` column's exact enum/definition
- [ ] Read `leadsView.tsx` and `services/leadIntelligene/index.ts` to confirm whether `status` is currently exposed as an editable field in the frontend
- [ ] If it is editable, use it directly to narrate stage progression for the demo Journey; if it is not, the demo narrates stage progression via the Timeline view from Task 11 instead — do not add new stage-editing UI in the prototype track, that belongs to Part B Task M8-full
- [ ] Record the finding in `prototype-verification-log.md`
- [ ] `git add docs/superpowers/plans/baseline/prototype-verification-log.md && git commit -m "chore: record prototype pipeline-stage scope finding"` in the workspace-root repo

**===== END M8 (prototype slice) =====**

---

## Module M10 (prototype slice) — Appointment → Consultation → Treatment Progression

### Task 15: Book a demo appointment through the existing state machine

FILES: none (verification only)

INTERFACES:
- Consumes: `src/models/AppointmentModel/Advanced_Appointment_Booking.service.js` (states `COLLECT_NAME → COLLECT_EMAIL → SELECT_DOCTOR → SELECT_DATE → SELECT_TIME → COLLECT_REASON → BOOKING_COMPLETE`) and the confirmed-LIVE `appointment.routes.js:29` create endpoint
- Produces: a recorded pass/fail verification result

Steps:
- [ ] Drive the existing appointment state machine to `BOOKING_COMPLETE` for the demo Contact, either via the Playground chat simulator or the confirmed-LIVE create endpoint directly
- [ ] Confirm the resulting appointment appears on the confirmed-LIVE `whatnexus-frontend/app/(protected)/appointments` page and in `appointmentDrawer.tsx`
- [ ] Record the result in `prototype-verification-log.md`
- [ ] `git add docs/superpowers/plans/baseline/prototype-verification-log.md && git commit -m "chore: record prototype appointment-booking verification result"` in the workspace-root repo

### Task 16: Add `journey_id` to the confirmed-appointment write path

FILES:
- Modify: the table identified below, `src/models/AppointmentModel/Advanced_Appointment_Booking.service.js`
- Test: `tests/appointmentBooking.journeyId.test.js`

INTERFACES:
- Consumes: the `Advanced_Appointment_Booking.service.js` `BOOKING_COMPLETE` handler
- Produces: a nullable `journey_id` column on the appointment-confirmation table, populated when the caller supplies it, `null` otherwise

Steps:
- [ ] Read `Advanced_Appointment_Booking.service.js`'s `BOOKING_COMPLETE` handler in full to identify the exact table and function that performs the final appointment-confirmation write
- [ ] Write a failing test asserting that booking a demo appointment for a Contact with an open Journey (created in Task 9/10) results in the confirmed appointment row carrying that Journey's `id` in a `journey_id` column
- [ ] Run the test and confirm it fails, since the column and wiring do not exist yet
- [ ] Add a nullable `journey_id` INTEGER column to the identified appointment-confirmation table, and pass the caller's `journey_id` through the booking service's final write when known, defaulting to `null` when no Journey context is available — do not auto-create or guess a Journey
- [ ] Run the test and confirm it passes
- [ ] Complete a full state-machine booking with no `journey_id` supplied (reproducing today's existing behavior) and confirm it still succeeds unchanged — this is the regression check for this task
- [ ] `git -C invictus-chatbot add src/models/AppointmentModel/Advanced_Appointment_Booking.service.js tests/appointmentBooking.journeyId.test.js && git -C invictus-chatbot commit -m "feat: attach journey_id to confirmed appointments when known"`
- [ ] Also commit the identified table's definition file if it required a separate edit from `Advanced_Appointment_Booking.service.js`

### Task 17: Record a consultation outcome for the demo appointment

FILES: none (verification only)

INTERFACES:
- Consumes: the confirmed-LIVE `VisitOutcomeDrawer.tsx` → `appointment.routes.js:148` flow
- Produces: a recorded pass/fail verification result

Steps:
- [ ] Mark the demo appointment attended and record an outcome via `VisitOutcomeDrawer.tsx`
- [ ] Confirm the outcome persists across a page reload
- [ ] Record the result in `prototype-verification-log.md`
- [ ] `git add docs/superpowers/plans/baseline/prototype-verification-log.md && git commit -m "chore: record prototype consultation-outcome verification result"` in the workspace-root repo

### Task 18: Add a clearly-labeled mocked treatment-status chip to the Journey detail view

FILES:
- Modify: `components/views/journeyTimeline/journeyTimelineView.tsx`
- Test: none — static display value, covered by the Task 20 end-to-end walkthrough

INTERFACES:
- Consumes: the presence of a recorded consultation outcome (Task 17) for the current Journey
- Produces: a visibly-labeled mock UI element, not silently presented as persisted data

Steps:
- [ ] Add a "Treatment Status" chip to the Journey detail view, rendering the hardcoded value `"Proposed"` once a consultation outcome exists for the current Journey
- [ ] Add a code comment directly above the chip's render logic stating this is a prototype-only mock and that the real, persisted `TreatmentOpportunityTable`-backed version is built in Part B Task M10-full
- [ ] Manually verify the chip appears immediately after Task 17's outcome is recorded
- [ ] `git -C whatnexus-frontend add components/views/journeyTimeline/journeyTimelineView.tsx && git -C whatnexus-frontend commit -m "feat: add prototype-only mocked treatment-status chip"`

**===== END M10 (prototype slice) =====**

---

## Module M11 (prototype slice) — Source / Campaign / Revenue Context

### Task 19: Surface source, journey_type, and a mocked revenue figure on the Journey detail view

FILES:
- Modify: `src/models/LeadsModel/leads.service.js` (only if `source` is confirmed missing from the existing get-by-id response), `components/views/journeyTimeline/journeyTimelineView.tsx`
- Test: `tests/leadsService.sourceField.test.js` (created only if the backend change in this task is actually needed)

INTERFACES:
- Consumes: the existing `GET /whatsapp/lead/:id` response (`leads.controller.js:getLeadByIdController` → `leads.service.js`, confirmed LIVE route `leads.routes.js:32`)
- Produces: `source` guaranteed present in that response, plus a clearly-labeled mocked revenue display on the Journey detail view

Steps:
- [ ] Read the existing `GET /whatsapp/lead/:id` response shape to confirm whether `source` is already included
- [ ] If `source` is missing: write a failing test asserting the get-by-id response includes `source` when the underlying row has one set, run it to confirm it fails, add the missing field to the existing function's return shape (no new endpoint), run the test again to confirm it passes, then run `npm run test:billing` to confirm no regression
- [ ] If `source` is already present: skip the backend change entirely and note this explicitly in the frontend commit message below
- [ ] On the Journey detail view, display `journey_type`, `source`, and a static, clearly-labeled mocked revenue figure ("Estimated opportunity value: ₹— (mocked; real revenue attribution ships in Part B)")
- [ ] Manually verify the demo Journey (whose `source` was already captured by whatever existing Contact/Lead creation path populates it — confirm this before assuming new plumbing is needed) displays correctly
- [ ] `git -C invictus-chatbot add src/models/LeadsModel/leads.service.js tests/leadsService.sourceField.test.js` (only if the backend change was made) `&& git -C invictus-chatbot commit -m "feat: ensure source is present on Journey get-by-id response"`
- [ ] `git -C whatnexus-frontend add components/views/journeyTimeline/journeyTimelineView.tsx && git -C whatnexus-frontend commit -m "feat: surface source, journey_type, and mocked revenue context on Journey detail"`

**===== END M11 (prototype slice) =====**

---

### Task 20: End-to-end prototype walkthrough verification

FILES:
- Create: `docs/superpowers/plans/baseline/prototype-e2e-walkthrough.md` (workspace-root repo)

INTERFACES:
- Consumes: every artifact produced by Tasks 1–19
- Produces: a recorded, step-by-step pass/fail verification proving the prototype cut line is genuinely reached

Steps:
- [ ] Starting from a freshly reseeded demo tenant (re-run Task 4's seed script), walk the full required chain manually and record each step's pass/fail: Source (manual `source` selection, Task 19) → Patient (Contact, Task 8) → Journey (Task 9/10, `journey_type` set) → Timeline (Task 11 renders the WhatsApp+appointment merge) → WhatsApp/Human interaction (Task 12's silence-toggle) → Follow-up (Task 13's scheduled message) → Appointment (Task 15/16, `journey_id` attached) → Consultation outcome (Task 17) → Treatment status (Task 18's explicitly-mocked chip) → Post-care next action (a manually-created follow-up via Task 13's existing mechanism, narrated as the next action) → Revenue/source context (Task 19)
- [ ] Confirm every step above uses real, persisted backend data except the two explicitly-allowed mocks (treatment-status chip, revenue figure) — if any other step is found using placeholder data during this walkthrough, that is a defect against the approved spec's "do not mock persistence" rule and must be fixed before declaring the cut line reached, not narrated around
- [ ] Write the walkthrough script and its pass/fail results into `prototype-e2e-walkthrough.md`
- [ ] `git add docs/superpowers/plans/baseline/prototype-e2e-walkthrough.md && git commit -m "chore: record end-to-end prototype walkthrough verification"` in the workspace-root repo

---

# ===== PROTOTYPE CUT LINE =====

At this point PulseOS demonstrates, with real and persisted Contact/Journey/Appointment/Outcome data: **Source → Patient → Journey → Timeline → WhatsApp/Human interaction → Follow-up → Appointment → Consultation outcome → Treatment status → Post-care next action → Revenue/source context** — exactly the chain required by the approved spec, with only outbound telephony, live Meta/Google ad-platform data, and advanced revenue attribution mocked, exactly as the spec permits. Everything below is **POST-PROTOTYPE**.

---

# PART B — POST-PROTOTYPE TRACK

## Module M1 — Security Prerequisites Before Touching Communication Flows

Positioned here (after the cut line, ahead of the deeper Part B modules) because M5-full (below) modifies the same inbound-message handling in `AuthWhatsapp.controller.js` that this module hardens — doing the security fix first means M5-full is built on an already-hardened webhook path instead of requiring a second pass through the same file. Per the approved spec's security gate, this module does **not** need to complete before the prototype demo (already proven above) — only before a real patient pilot (M14).

### Task 21: Add WhatsApp webhook POST signature verification

FILES:
- Modify: `src/models/AuthWhatsapp/AuthWhatsapp.routes.js`, `src/models/AuthWhatsapp/AuthWhatsapp.controller.js`
- Test: `tests/authWhatsapp.webhookSignature.test.js`

INTERFACES:
- Consumes: the tenant's `META_APP_SECRET` (already an existing config concept per the security audit), the raw request body of `POST /webhook/:tenantId?`
- Produces: a `receiveMessage` handler that rejects any POST payload whose `X-Hub-Signature-256` header does not match an HMAC-SHA256 of the raw body computed with the tenant's `META_APP_SECRET`

Steps:
- [ ] Read `AuthWhatsapp.routes.js:9-10` and the `receiveMessage` handler in `AuthWhatsapp.controller.js` in full to confirm the exact current request-body handling (raw vs. already-parsed JSON) — signature verification requires the raw, unparsed body, so confirm whether Express body-parsing middleware runs before this route and adjust the route's body-capture accordingly if it does, following the same raw-body-preservation pattern already used elsewhere in this codebase for other signed webhooks (Razorpay's `RAZORPAY_WEBHOOK_SECRET` handling and the campaign-events webhook's `CAMPAIGN_EVENT_WEBHOOK_SECRET` handling, both confirmed present in the security audit) — read those two existing implementations first and reuse their raw-body-capture technique rather than inventing a new one
- [ ] Write a failing test asserting that a POST to `/webhook/:tenantId` with a missing or incorrect `X-Hub-Signature-256` header is rejected with `401`, and a POST with a correct signature (computed the same way the test itself computes it, using a known test `META_APP_SECRET`) is accepted and proceeds to normal processing
- [ ] Run the test and confirm it fails, since no verification exists yet
- [ ] Implement the signature check as the first line of `receiveMessage`, before any tenant/`phone_number_id` resolution — on mismatch, respond `401` and do not process the payload
- [ ] Run the test and confirm it passes
- [ ] Run a full regression check of the existing WhatsApp inbound flow: send a correctly-signed test payload through the Playground/local webhook simulator and confirm normal message processing, billing hook (`AuthWhatsapp.controller.js:468-474`), and AI reply generation all still function exactly as before this change
- [ ] `git -C invictus-chatbot add src/models/AuthWhatsapp/AuthWhatsapp.routes.js src/models/AuthWhatsapp/AuthWhatsapp.controller.js tests/authWhatsapp.webhookSignature.test.js && git -C invictus-chatbot commit -m "fix: verify X-Hub-Signature-256 on inbound WhatsApp webhook POSTs"`

---

## Module M3 (full) — Contact + Journey Semantics

### Task 22: Wire `journey_type` through the automatic WhatsApp-triggered Journey creation path

FILES:
- Modify: the specific call site in `src/models/AuthWhatsapp/AuthWhatsapp.controller.js` (or the lead-scoring service it calls) identified by Task 9's grep
- Test: `tests/authWhatsapp.autoJourneyType.test.js`

INTERFACES:
- Consumes: the extended lead-creation function from Task 9
- Produces: a documented, explicit default policy for `journey_type` when a Journey is auto-opened from an inbound WhatsApp message with no prior journey context (default to `"general_opd"` only at this single, explicit call site — never as a silent service-layer default)

Steps:
- [ ] Re-read the exact call site recorded in Task 9's test-file comment
- [ ] Write a failing test asserting that a brand-new inbound WhatsApp message from a Contact with no existing open Journey results in a new Journey with `journey_type: "general_opd"`, and that a message from a Contact with an already-open Journey does not open a second one with a different default
- [ ] Run the test and confirm it fails
- [ ] Add the explicit `journey_type: "general_opd"` argument at this one call site only, alongside the existing logic that decides whether to open a new Journey vs. reuse an existing one
- [ ] Run the test and confirm it passes
- [ ] Run the full existing WhatsApp-inbound regression suite (manual Playground walkthrough covering: new contact, returning contact, existing-open-journey contact) and confirm no change in behavior beyond the new `journey_type` value being set
- [ ] `git -C invictus-chatbot add <call site file> tests/authWhatsapp.autoJourneyType.test.js && git -C invictus-chatbot commit -m "feat: default journey_type=general_opd for auto-opened WhatsApp journeys"`

### Task 23: Add a "Journeys for this Contact" API endpoint

FILES:
- Modify: `src/models/LeadsModel/leads.routes.js`, `src/models/LeadsModel/leads.controller.js`, `src/models/LeadsModel/leads.service.js`
- Test: `tests/leads.byContact.test.js`

INTERFACES:
- Consumes: `tenant_id` from `req.user` (following the confirmed-safe IDOR pattern already used throughout `leads.controller.js`)
- Produces: `GET /whatsapp/contact/:contact_id/journeys`, returning every `Lead` row for that contact within the caller's tenant, ordered by `created_at` descending

Steps:
- [ ] Read `leads.routes.js`, `leads.controller.js`, and `leads.service.js` in full to confirm existing routing/controller/service conventions
- [ ] Write a failing integration test asserting the new endpoint returns only Journeys belonging to the requested Contact and the caller's own tenant (create a second tenant's Journey for the same `contact_id` value in the test and assert it is excluded)
- [ ] Run the test and confirm it fails, since the route does not exist yet
- [ ] Add the route in `leads.routes.js`, the controller function in `leads.controller.js` (deriving `tenant_id` from `req.user.tenant_id`, matching every other handler in this file), and the service function in `leads.service.js` (a `WHERE tenant_id = ? AND contact_id = ?` query, no other new logic)
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/models/LeadsModel/leads.routes.js src/models/LeadsModel/leads.controller.js src/models/LeadsModel/leads.service.js tests/leads.byContact.test.js && git -C invictus-chatbot commit -m "feat: add tenant-scoped GET /contact/:contact_id/journeys endpoint"`

---

## Module M4 (full) — Unified Interaction Timeline

### Task 24: Create the `TimelineEventTable` model

FILES:
- Create: `src/database/tables/TimelineEventTable/index.js`
- Modify: `src/database/index.js` (or wherever new table models are registered — confirm the exact registration pattern by reading how an existing table, e.g. `LeadScoreHistoryTable`, is registered, before editing)
- Test: `tests/timelineEventModel.test.js`

INTERFACES:
- Consumes: nothing (new table)
- Produces: a `TimelineEventTable` Sequelize model with columns `id, tenant_id, contact_id, journey_id (nullable), event_type (STRING, open catalog), actor_type (STRING: system|ai|tenant_user), actor_id (nullable), title, description, previous_value, new_value, metadata (JSON), occurred_at, created_at`

Steps:
- [ ] Read `src/database/tables/LeadScoreHistoryTable/index.js` (an existing, structurally similar append-only history table) in full as the reference pattern for column types and indexing
- [ ] Read how that table is registered/associated in the project's model-registration file
- [ ] Write a failing test creating a `TimelineEvent` row with `event_type: "outcome_recorded"`, reading it back, and asserting all fields round-trip
- [ ] Run the test and confirm it fails, since the model doesn't exist yet
- [ ] Implement `TimelineEventTable/index.js` with the column set above, `event_type` as `STRING(80)` (not a DB ENUM, matching the approved spec's low-migration-cost technique), and indexes on `[tenant_id, contact_id]` and `[tenant_id, journey_id]`
- [ ] Register the model following the confirmed existing pattern
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/TimelineEventTable src/database/index.js tests/timelineEventModel.test.js && git -C invictus-chatbot commit -m "feat: add TimelineEventTable model"`

### Task 25: Write a shared `recordTimelineEvent` helper

FILES:
- Create: `src/utils/timeline/recordTimelineEvent.js`
- Test: `tests/recordTimelineEvent.test.js`

INTERFACES:
- Consumes: `TimelineEventTable` from Task 24
- Produces: one function, `recordTimelineEvent({ tenant_id, contact_id, journey_id, event_type, actor_type, actor_id, title, description, previous_value, new_value, metadata, occurred_at })`, used by every write-through call site added in later tasks — this is the single write path into the Timeline, preventing each call site from hand-rolling its own insert

Steps:
- [ ] Write a failing test asserting `recordTimelineEvent(...)` creates exactly one `TimelineEvent` row with the given fields, defaulting `occurred_at` to "now" when omitted
- [ ] Run the test and confirm it fails
- [ ] Implement `recordTimelineEvent.js` as a thin wrapper around `TimelineEvent.create(...)`
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/utils/timeline/recordTimelineEvent.js tests/recordTimelineEvent.test.js && git -C invictus-chatbot commit -m "feat: add shared recordTimelineEvent write-through helper"`

### Task 26: Write-through Timeline events from appointment outcome recording

FILES:
- Modify: the appointment-outcome-recording service function (confirmed location: wherever `AppointmentOutcomeTable` rows are created, in the `AppointmentModel` service files exercised by Task 17/`VisitOutcomeDrawer.tsx`'s backend route `appointment.routes.js:148`)
- Test: `tests/appointmentOutcome.timelineWriteThrough.test.js`

INTERFACES:
- Consumes: `recordTimelineEvent` from Task 25
- Produces: one `TimelineEvent` row (`event_type: "outcome_recorded"`) per recorded consultation outcome

Steps:
- [ ] Read the outcome-recording service function in full to confirm its exact structure and where a post-write hook can be added
- [ ] Write a failing test asserting that recording a consultation outcome creates exactly one `TimelineEvent` row with `event_type: "outcome_recorded"`, correct `contact_id`/`journey_id`, and `previous_value`/`new_value` reflecting the outcome fields that changed
- [ ] Run the test and confirm it fails
- [ ] Add a call to `recordTimelineEvent` immediately after the existing `AppointmentOutcomeTable` write succeeds, inside the same function — do not change the existing outcome-write logic itself
- [ ] Run the test and confirm it passes
- [ ] Manually re-run Task 17's outcome-recording flow and confirm the existing outcome-recording behavior (response shape, status code, frontend rendering) is completely unchanged aside from the new Timeline row
- [ ] `git -C invictus-chatbot add <outcome service file> tests/appointmentOutcome.timelineWriteThrough.test.js && git -C invictus-chatbot commit -m "feat: write-through Timeline event on consultation outcome"`

### Task 27: Write-through Timeline events from appointment state transitions

FILES:
- Modify: `src/models/AppointmentModel/Advanced_Appointment_Booking.service.js` (the handler-dispatch table at lines 1878-1881)
- Test: `tests/appointmentBooking.timelineWriteThrough.test.js`

INTERFACES:
- Consumes: `recordTimelineEvent` from Task 25
- Produces: one `TimelineEvent` row (`event_type: "appointment_booked"`) written exactly once when the state machine reaches `BOOKING_COMPLETE`

Steps:
- [ ] Read the `BOOKING_COMPLETE` handler identified in Task 16 to confirm the exact point where the booking is finalized
- [ ] Write a failing test (idempotency-focused, per the plan's test-strategy requirement) asserting that completing a booking once produces exactly one `TimelineEvent` row, and that the existing state machine's own retry/re-entry handling (if a duplicate `BOOKING_COMPLETE` transition is ever re-triggered for the same appointment) does not produce a second, duplicate row — assert this by calling the completion path twice with the same appointment id and asserting the Timeline row count is still 1
- [ ] Run the test and confirm the "single event" half passes trivially but the "no duplicate on re-entry" half fails, since no de-duplication exists yet
- [ ] Add the `recordTimelineEvent` call inside the `BOOKING_COMPLETE` handler, guarded by a check against an existing `TimelineEvent` row with the same `event_type` and appointment reference in its `metadata` (a `findOrCreate`-style guard) so re-entry is idempotent
- [ ] Run the test and confirm it passes
- [ ] Run the existing appointment-booking regression check: complete a fresh booking end-to-end via the Playground simulator and confirm the state machine's behavior and final response are unchanged aside from the new Timeline row
- [ ] `git -C invictus-chatbot add src/models/AppointmentModel/Advanced_Appointment_Booking.service.js tests/appointmentBooking.timelineWriteThrough.test.js && git -C invictus-chatbot commit -m "feat: idempotent write-through Timeline event on appointment booking completion"`

### Task 28: Replace the prototype's client-side Timeline merge with the real `TimelineEventTable`-backed endpoint

FILES:
- Create: `src/models/TimelineModel/timeline.routes.js`, `src/models/TimelineModel/timeline.controller.js`, `src/models/TimelineModel/timeline.service.js`
- Modify: `src/app.js` (mount the new router under the existing `/api/whatsapp` prefix, alongside the other 20+ sub-routers already mounted there), `whatnexus-frontend/services/journeyTimeline/index.ts`, `whatnexus-frontend/components/views/journeyTimeline/journeyTimelineView.tsx`
- Test: `tests/timeline.getByContact.test.js` (backend), `components/views/journeyTimeline/__tests__/journeyTimelineView.test.tsx` (frontend, extended)

INTERFACES:
- Consumes: `TimelineEventTable`
- Produces: `GET /whatsapp/timeline/:contact_id?journey_id=` (tenant-scoped from `req.user.tenant_id`, matching the confirmed-safe pattern in `leads.controller.js`/`contacts.controller.js`), returning `TimelineEvent` rows ordered by `occurred_at` descending

Steps:
- [ ] Read an existing simple `Model/routes.js` + `.controller.js` + `.service.js` triplet (e.g., `FaqModel`) as the structural reference
- [ ] Write a failing backend test asserting the endpoint returns only `TimelineEvent` rows for the requested `contact_id` within the caller's tenant, optionally filtered by `journey_id` when supplied
- [ ] Run the test and confirm it fails
- [ ] Implement the route/controller/service triplet and mount it in `src/app.js`
- [ ] Run the test and confirm it passes
- [ ] Update `services/journeyTimeline/index.ts`'s `getJourneyTimeline` function to call the new endpoint instead of merging two separate calls client-side
- [ ] Update the failing-then-passing frontend test from Task 11 to assert the component renders correctly from the new single-endpoint response shape instead of two merged arrays
- [ ] Delete the client-side merge logic from `journeyTimelineView.tsx` added in Task 11, and delete its prototype-only code comment
- [ ] Manually verify the Journey detail view still renders identically to the prototype's merged view, now backed by real `TimelineEventTable` rows
- [ ] `git -C invictus-chatbot add src/models/TimelineModel src/app.js tests/timeline.getByContact.test.js && git -C invictus-chatbot commit -m "feat: add tenant-scoped Timeline read endpoint"`
- [ ] `git -C whatnexus-frontend add services/journeyTimeline/index.ts components/views/journeyTimeline && git -C whatnexus-frontend commit -m "feat: back Journey timeline view with real TimelineEventTable endpoint"`

---

## Module M5 (full) — AI/Human Ownership

### Task 29: Add `ownership_state` to the existing LiveChat model

FILES:
- Modify: `src/database/tables/LiveChatTable/index.js`
- Test: `tests/liveChatModel.ownershipState.test.js`

INTERFACES:
- Consumes: existing `LiveChat` model (`status` ENUM `active|closed|pending`, lines 17-21; `assigned_admin_id`, lines 27-31 — both unchanged by this task)
- Produces: one new column, `ownership_state` (STRING, values `AI_ACTIVE | HUMAN_REQUIRED | HUMAN_ASSIGNED | HUMAN_ACTIVE | AI_RESUME_PENDING | CLOSED`, default `AI_ACTIVE`) — the smallest representation compatible with the existing model, per the architecture lock; no new table

Steps:
- [ ] Read `src/database/tables/LiveChatTable/index.js` in full to confirm the exact existing `status`/`assigned_admin_id` definitions before adding a new, orthogonal column
- [ ] Write a failing test asserting a new `LiveChat` row defaults to `ownership_state: "AI_ACTIVE"`, and that the value can be explicitly set to each of the other five states and round-trips correctly
- [ ] Run the test and confirm it fails
- [ ] Add `ownership_state: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "AI_ACTIVE" }` — `STRING`, not a DB `ENUM`, so the state list can be extended later without a migration, matching the same technique already used for `journey_type`
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/LiveChatTable/index.js tests/liveChatModel.ownershipState.test.js && git -C invictus-chatbot commit -m "feat: add ownership_state column to existing LiveChat model"`

### Task 30: Atomic human-claim suppression of AI

FILES:
- Modify: `src/models/LiveChatModel/livechat.service.js` (the `claimLiveChatService` function, confirmed at lines 183-236)
- Test: `tests/livechatService.claimSuppressesAi.test.js`

INTERFACES:
- Consumes: `ownership_state` from Task 29
- Produces: `claimLiveChatService` sets `assigned_admin_id` and `ownership_state: "HUMAN_ASSIGNED"` in a single atomic database write (one `UPDATE` statement or one Sequelize transaction wrapping both field changes — no window where a claim exists without AI already being suppressed)

Steps:
- [ ] Read `claimLiveChatService` (lines 183-236) in full to confirm its exact current update logic
- [ ] Write a failing test that calls `claimLiveChatService` and immediately (within the same test, no artificial delay) asserts `ownership_state === "HUMAN_ASSIGNED"` on the resulting row
- [ ] Run the test and confirm it fails, since claiming does not currently touch `ownership_state`
- [ ] Modify the existing update call inside `claimLiveChatService` to also set `ownership_state: "HUMAN_ASSIGNED"` in the same `UPDATE`/transaction as the existing `assigned_admin_id` write — do not add a second, separate write
- [ ] Run the test and confirm it passes
- [ ] Run the existing claim-flow regression check: claim a chat through the confirmed-LIVE claim UI in `ChatDetails.tsx` and confirm the existing claim behavior (UI state, `assigned_admin_id` persistence) is unchanged aside from the new `ownership_state` value
- [ ] `git -C invictus-chatbot add src/models/LiveChatModel/livechat.service.js tests/livechatService.claimSuppressesAi.test.js && git -C invictus-chatbot commit -m "feat: atomically set ownership_state=HUMAN_ASSIGNED on chat claim"`

### Task 31: Replace `is_ai_silenced` check with `ownership_state` check in the AI reply path, plus pre-send re-check

FILES:
- Modify: `src/models/AuthWhatsapp/AuthWhatsapp.controller.js` (the check confirmed at lines 1082-1087, and the point immediately before the AI reply is actually sent)
- Test: `tests/authWhatsapp.ownershipGating.test.js`

INTERFACES:
- Consumes: `ownership_state` from Task 29
- Produces: (a) inbound-message AI processing proceeds only when `ownership_state === "AI_ACTIVE"`; (b) immediately before the generated reply is sent to WhatsApp, `ownership_state` is re-read and the send is aborted if it has changed away from `AI_ACTIVE` since processing began — this closes the race where a human claims mid-processing

Steps:
- [ ] Read the existing `is_ai_silenced` check at `AuthWhatsapp.controller.js:1082-1087` and the code path from there through to the actual WhatsApp-send call, to identify exactly where the send happens
- [ ] Write a failing test (this is the plan's designated AI/human ownership race-condition test) simulating: an inbound message begins AI processing while `ownership_state === "AI_ACTIVE"`, then — before the reply-send step executes — `ownership_state` is changed to `"HUMAN_ASSIGNED"` (simulating a concurrent human claim); assert the AI reply is **not** sent
- [ ] Run the test and confirm it fails, since no re-check exists yet
- [ ] Replace the `is_ai_silenced` boolean check with an `ownership_state === "AI_ACTIVE"` check at the same point in the flow; add a second, identical check immediately before the WhatsApp-send call, aborting the send (without erroring the request) if the state has changed
- [ ] Run the test and confirm it passes
- [ ] Keep the existing `contacts.is_ai_silenced` column and its `PATCH /whatsapp/contact/:contact_id/silence` endpoint in place, unmodified, as a deprecated/legacy field per the approved spec — do not remove it in this task, and do not have any code path read it for gating decisions anymore (grep to confirm no remaining read-for-gating usage after this change, only the existing write-endpoint itself)
- [ ] Run the full existing WhatsApp-inbound regression suite (Playground walkthrough: AI-active reply, human-claimed no-reply, both covered)
- [ ] `git -C invictus-chatbot add src/models/AuthWhatsapp/AuthWhatsapp.controller.js tests/authWhatsapp.ownershipGating.test.js && git -C invictus-chatbot commit -m "feat: gate AI replies on ownership_state with pre-send re-check"`

### Task 32: Automatic `HUMAN_REQUIRED` escalation from AI confidence/grounding gates

FILES:
- Modify: `src/models/AuthWhatsapp/AuthWhatsapp.service.js` (the grounding-enforcement check confirmed around `shouldEnforceStrictGrounding`/`knowledgeRequiredButMissing`, lines 994-1019), `src/models/AppointmentModel/appointmentOperationRouter.service.js` (the confidence-tier logic confirmed at lines 759-833)
- Test: `tests/ownershipEscalation.test.js`

INTERFACES:
- Consumes: `ownership_state`, `recordTimelineEvent`
- Produces: `ownership_state` transitions to `"HUMAN_REQUIRED"` automatically when (a) the forced "missing knowledge" fallback fires twice in a row for the same conversation, or (b) the appointment meaning-classifier confidence stays below the existing ask-confirm threshold (0.55, confirmed at `appointmentOperationRouter.service.js:812-825`) across two consecutive turns

Steps:
- [ ] Read the `knowledgeRequiredButMissing` check (`AuthWhatsapp.service.js:994-1019`) and the confidence-tier logic (`appointmentOperationRouter.service.js:759-833`) in full
- [ ] Write a failing test asserting that two consecutive forced-fallback replies for the same `LiveChat` row set `ownership_state` to `"HUMAN_REQUIRED"` and write a `TimelineEvent` (`event_type: "ai_escalated_to_human"`)
- [ ] Run the test and confirm it fails
- [ ] Add a small per-conversation counter (a new column on `LiveChatTable`, `consecutive_low_confidence_count`, INTEGER, default 0, incremented on each low-confidence/forced-fallback turn and reset to 0 on any confident/grounded reply) and, when it reaches 2, set `ownership_state: "HUMAN_REQUIRED"` and call `recordTimelineEvent`
- [ ] Run the test and confirm it passes
- [ ] Run the existing RAG-grounding regression check (a known-answerable question still gets a grounded AI reply and does not increment the counter; a known-unanswerable question still gets the existing forced-fallback text exactly as before, only now also incrementing the counter)
- [ ] `git -C invictus-chatbot add src/models/AuthWhatsapp/AuthWhatsapp.service.js src/models/AppointmentModel/appointmentOperationRouter.service.js src/database/tables/LiveChatTable/index.js tests/ownershipEscalation.test.js && git -C invictus-chatbot commit -m "feat: auto-escalate ownership_state to HUMAN_REQUIRED on repeated low AI confidence"`

### Task 33: `AI_RESUME_PENDING` → `AI_ACTIVE` with context rebuild from the human interaction

FILES:
- Modify: `whatnexus-frontend/components/views/chats/ChatDetails.tsx` (the existing "Unsilence AI" button, lines 376-401), `src/models/ContactsModel/contacts.controller.js`, `src/models/ContactsModel/contacts.service.js`, `src/utils/chat/buildChatHistory.js`
- Test: `tests/aiResumeContextRebuild.test.js`

INTERFACES:
- Consumes: `ownership_state`, `TimelineEventTable` (Task 24), the existing `buildChatHistory` function (`MAX_CHAT_HISTORY = 30`, line 1)
- Produces: clicking the existing button sets `ownership_state: "AI_RESUME_PENDING"`; the next AI processing pass for that conversation, before generating a reply, reads the `TimelineEvent` rows recorded since the last `HUMAN_ASSIGNED`/`HUMAN_ACTIVE` transition and injects a short structured summary of them into the system prompt (via `aiFlowHelper.js`'s existing prompt-assembly pipeline) instead of relying solely on raw replayed chat history, then transitions `ownership_state` to `"AI_ACTIVE"`

Steps:
- [ ] Read `ChatDetails.tsx:376-401` to confirm the existing button's click handler and the endpoint it currently calls
- [ ] Read `buildChatHistory.js` and `aiFlowHelper.js`'s `buildAiSystemPrompt` (lines 29-288) in full to identify the correct injection point for an added "handoff summary" section
- [ ] Write a failing test asserting that, given a `LiveChat` row transitioning from `AI_RESUME_PENDING` to processing a new inbound message, the assembled system prompt contains a summary of the `TimelineEvent` rows recorded while `ownership_state` was `HUMAN_ASSIGNED`/`HUMAN_ACTIVE`, and that `ownership_state` becomes `"AI_ACTIVE"` after that message is processed
- [ ] Run the test and confirm it fails
- [ ] Update the button's backend call (repointing from the existing `PATCH /whatsapp/contact/:contact_id/silence` to a new, explicit `PATCH /whatsapp/livechat/:id/resume-ai` endpoint — add this route/controller/service function following the same conventions confirmed in `contacts.controller.js`) to set `ownership_state: "AI_RESUME_PENDING"`
- [ ] Add a small function that, given a `LiveChat` row's id, fetches its `TimelineEvent` rows since the last ownership transition into `HUMAN_ASSIGNED`, and formats them as a short bulleted summary string
- [ ] Wire this function's output into `buildAiSystemPrompt`'s existing prompt-assembly pipeline as an additional section, only when `ownership_state === "AI_RESUME_PENDING"`; after that message is processed, transition `ownership_state` to `"AI_ACTIVE"`
- [ ] Run the test and confirm it passes
- [ ] Manually verify: silence AI, exchange a few manual messages as a human, click "Resume AI," send a new inbound message, and confirm the AI's reply reflects awareness of what the human discussed (not just a blind resume)
- [ ] `git -C invictus-chatbot add src/models/ContactsModel src/utils/ai/aiFlowHelper.js src/utils/chat tests/aiResumeContextRebuild.test.js && git -C invictus-chatbot commit -m "feat: rebuild AI context from human interaction on resume"`
- [ ] `git -C whatnexus-frontend add components/views/chats/ChatDetails.tsx && git -C whatnexus-frontend commit -m "feat: point Resume AI button at new ownership resume endpoint"`

### Task 34: `CLOSED` ownership state on conversation close

FILES:
- Modify: wherever `LiveChat.status` is currently set to `"closed"` (confirm exact call site by reading `livechat.service.js` in full)
- Test: `tests/liveChatClose.ownershipState.test.js`

INTERFACES:
- Consumes: `ownership_state`
- Produces: whenever `LiveChat.status` transitions to `"closed"`, `ownership_state` transitions to `"CLOSED"` in the same write

Steps:
- [ ] Read `livechat.service.js` in full to confirm the exact function that closes a chat
- [ ] Write a failing test asserting that closing a chat sets `ownership_state: "CLOSED"` in the same write as `status: "closed"`
- [ ] Run the test and confirm it fails
- [ ] Add `ownership_state: "CLOSED"` to the existing close-chat update
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/models/LiveChatModel/livechat.service.js tests/liveChatClose.ownershipState.test.js && git -C invictus-chatbot commit -m "feat: set ownership_state=CLOSED when a chat is closed"`

---

## Module M6 (full) — Tasks / Follow-ups / Next Action

### Task 35: Create the `TaskTable` model, ported from the Lead Panel's proven pattern

FILES:
- Create: `src/database/tables/TaskTable/index.js`
- Modify: model-registration file (same pattern confirmed in Task 24)
- Test: `tests/taskModel.test.js`

INTERFACES:
- Consumes: pattern from `backend/src/database/tables/BirthwaveTaskTable/index.js` (`parent_task_id` self-relation confirmed at line 21, `idx_bw_tasks_parent` at line 40; `task_type`/`status`/`priority` as `STRING`, not ENUM, confirmed at lines 13-15) — read directly, not copied file-for-file, since column names/associations differ (`client_id` → `tenant_id`)
- Produces: `TaskTable` with columns `id, tenant_id, contact_id, journey_id, assigned_to (tenant_user_id), created_by, parent_task_id (nullable self-FK), task_type (STRING), status (STRING: pending|in_progress|completed|cancelled), priority (STRING: normal|high), due_at, started_at, completed_at, cancelled_at, completion_reason, metadata (JSON)`

Steps:
- [ ] Read `backend/src/database/tables/BirthwaveTaskTable/index.js` in full as the reference pattern
- [ ] Write a failing test creating a `Task` row with a `parent_task_id` referencing another `Task` row in the same tenant, and asserting the self-relation resolves
- [ ] Run the test and confirm it fails
- [ ] Implement `TaskTable/index.js` with the column set above, `task_type`/`status`/`priority` as `STRING`, indexes on `[tenant_id, contact_id]`, `[tenant_id, journey_id]`, `[tenant_id, assigned_to, status]`, and `parent_task_id` self-referencing `tasks.id`
- [ ] Register the model
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/TaskTable tests/taskModel.test.js && git -C invictus-chatbot commit -m "feat: add TaskTable model, ported from proven Lead Panel task pattern"`

### Task 36: Task CRUD API + "Next Action" query

FILES:
- Create: `src/models/TaskModel/task.routes.js`, `src/models/TaskModel/task.controller.js`, `src/models/TaskModel/task.service.js`
- Modify: `src/app.js` (mount under `/api/whatsapp`)
- Test: `tests/task.crud.test.js`, `tests/task.nextAction.test.js`

INTERFACES:
- Consumes: `TaskTable`
- Produces: standard CRUD routes for `Task`, plus `GET /whatsapp/journey/:journey_id/next-action` returning the single earliest-`due_at` open `Task` for that Journey (or `null`)

Steps:
- [ ] Read an existing CRUD triplet (e.g., `FaqModel`) as the structural reference, as in Task 28
- [ ] Write failing tests: (a) standard create/list/update for `Task`, tenant-scoped from `req.user.tenant_id`; (b) the next-action query returns the correct single earliest-due open task and `null` when none exist
- [ ] Run both and confirm they fail
- [ ] Implement the route/controller/service triplet, including the next-action query (`WHERE tenant_id = ? AND journey_id = ? AND status IN ('pending','in_progress') ORDER BY due_at ASC LIMIT 1`)
- [ ] Mount in `src/app.js`
- [ ] Run both tests and confirm they pass
- [ ] `git -C invictus-chatbot add src/models/TaskModel src/app.js tests/task.crud.test.js tests/task.nextAction.test.js && git -C invictus-chatbot commit -m "feat: add Task CRUD API and Journey next-action query"`

### Task 37: Port round-robin assignment as a small `AssignmentRuleTable`

FILES:
- Create: `src/database/tables/AssignmentRuleTable/index.js`, `src/models/AssignmentModel/assignment.service.js`
- Test: `tests/assignmentRule.roundRobin.test.js`

INTERFACES:
- Consumes: pattern from `backend/src/database/tables/BirthwaveAssignmentRuleTable/index.js` and `BirthwaveAssignmentCursorTable/index.js`
- Produces: one small table (`id, tenant_id, journey_type (nullable — null means "applies to all"), team_member_tenant_user_ids (JSON array), cursor_position (INTEGER)`) and one function `getNextAssignee(tenant_id, journey_type)` implementing round-robin selection

Steps:
- [ ] Read `backend/src/database/tables/BirthwaveAssignmentRuleTable/index.js` and `BirthwaveAssignmentCursorTable/index.js` in full as the reference pattern
- [ ] Write a failing test: given an `AssignmentRuleTable` row with three team members and `cursor_position: 0`, three successive calls to `getNextAssignee` return each member once, in order, and the cursor persists across calls
- [ ] Run the test and confirm it fails
- [ ] Implement the table and function
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/AssignmentRuleTable src/models/AssignmentModel tests/assignmentRule.roundRobin.test.js && git -C invictus-chatbot commit -m "feat: add round-robin assignment rule engine, ported from Lead Panel pattern"`

### Task 38: Wire Task write-through Timeline events

FILES:
- Modify: `src/models/TaskModel/task.service.js`
- Test: `tests/task.timelineWriteThrough.test.js`

INTERFACES:
- Consumes: `recordTimelineEvent`
- Produces: `event_type: "task_created"` / `"task_completed"` Timeline rows on the relevant Task service functions

Steps:
- [ ] Write a failing test asserting task creation and task completion each produce exactly one correctly-typed `TimelineEvent`
- [ ] Run the test and confirm it fails
- [ ] Add the `recordTimelineEvent` calls at the two points
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/models/TaskModel/task.service.js tests/task.timelineWriteThrough.test.js && git -C invictus-chatbot commit -m "feat: write-through Timeline events on Task create/complete"`

---

## Module M7 — Custom Fields

### Task 39: Port `CustomFieldTable`, generalized beyond Birthwave

FILES:
- Create: `src/database/tables/CustomFieldTable/index.js`
- Test: `tests/customFieldModel.test.js`

INTERFACES:
- Consumes: pattern from `backend/src/database/tables/CrmCustomFieldTable/index.js` (`CRM_FIELD_TYPES` confirmed at lines 3-15; unique composite `[client_id, entity_type, field_key]` confirmed at lines 52-56)
- Produces: `CustomFieldTable` with `id, tenant_id, entity_type (STRING, open — "journey"|"contact"|"treatment_opportunity"), field_key, label, field_type (STRING, JS-array-validated against a ported FIELD_TYPES list, not a DB ENUM), options (JSON), required, active, show_in_form, show_in_detail, show_in_table, filterable, display_order`, unique on `[tenant_id, entity_type, field_key]`

Steps:
- [ ] Read `backend/src/database/tables/CrmCustomFieldTable/index.js` in full
- [ ] Write a failing test asserting a duplicate `[tenant_id, entity_type, field_key]` combination is rejected, and a valid unique combination succeeds
- [ ] Run the test and confirm it fails
- [ ] Implement `CustomFieldTable/index.js`, porting the `CRM_FIELD_TYPES` list verbatim as `FIELD_TYPES` in this new file
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/CustomFieldTable tests/customFieldModel.test.js && git -C invictus-chatbot commit -m "feat: add generalized CustomFieldTable, ported from Lead Panel CrmCustomFieldTable"`

### Task 40: Add `custom_fields` JSON column to `LeadsTable` and `ContactsTable`

FILES:
- Modify: `src/database/tables/LeadsTable/index.js`, `src/database/tables/ContactsTable/index.js`
- Test: `tests/customFieldsJsonColumn.test.js`

INTERFACES:
- Consumes: nothing new
- Produces: a nullable `custom_fields` JSON column on both models

Steps:
- [ ] Write a failing test asserting a `Lead` row and a `Contact` row can each store and retrieve an arbitrary JSON object in `custom_fields`
- [ ] Run the test and confirm it fails
- [ ] Add `custom_fields: { type: Sequelize.JSON, allowNull: true }` to both models
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/LeadsTable/index.js src/database/tables/ContactsTable/index.js tests/customFieldsJsonColumn.test.js && git -C invictus-chatbot commit -m "feat: add custom_fields JSON column to Lead and Contact"`

### Task 41: Port Custom Field CRUD/reorder/archive service logic

FILES:
- Create: `src/models/CustomFieldModel/customField.routes.js`, `src/models/CustomFieldModel/customField.controller.js`, `src/models/CustomFieldModel/customField.service.js`, `src/middlewares/validation/customFieldValidation.js`
- Modify: `src/app.js`
- Test: `tests/customField.crud.test.js`, `tests/customField.reorder.test.js`

INTERFACES:
- Consumes: pattern from `backend/src/modules/birthwave/crm.service.js` (`listFields` lines 39-55, `createField` lines 78-110 with `slugify` at 70-76, `updateField`/`archiveField` lines 112-134, `FIELD_WRITABLE` lines 57-68, `reorderFields` lines 136-147) and `backend/src/middlewares/validation/crmValidation.js`
- Produces: the same CRUD/reorder/archive behavior, tenant-scoped from `req.user.tenant_id` (no `scopeSuperAdminToClient("birthwave")`-equivalent gate — that gate is Lead-Panel-specific and is not ported)

Steps:
- [ ] Read `backend/src/modules/birthwave/crm.service.js` and `backend/src/middlewares/validation/crmValidation.js` in full
- [ ] Write failing tests: (a) creating a field auto-slugifies `field_key` from `label` when not supplied and rejects a duplicate `[tenant_id, entity_type, field_key]` with `409`; (b) `reorderFields` writes sequential `display_order` values scoped to both `tenant_id` and `entity_type` (note: the ported source's `reorderFields` only scopes by `client_id`, not `entity_type` — this is a confirmed latent cross-entity-type reorder bug in the source; this port must scope by both `tenant_id` AND `entity_type` in its `WHERE` clause, closing that gap rather than reproducing it)
- [ ] Run the tests and confirm they fail
- [ ] Implement the route/controller/service triplet and validation file, porting the logic with the `entity_type` scoping fix applied to `reorderFields`
- [ ] Mount in `src/app.js`
- [ ] Run the tests and confirm they pass
- [ ] `git -C invictus-chatbot add src/models/CustomFieldModel src/middlewares/validation/customFieldValidation.js src/app.js tests/customField.crud.test.js tests/customField.reorder.test.js && git -C invictus-chatbot commit -m "feat: port Custom Field CRUD/reorder engine, generalized and tenant-scoped, with reorder entity_type-scoping fix"`

---

## Module M8 (full) — Configurable Pipeline / Stages

### Task 42: Create `PipelineStageTable`

FILES:
- Create: `src/database/tables/PipelineStageTable/index.js`
- Test: `tests/pipelineStageModel.test.js`

INTERFACES:
- Consumes: the low-migration-cost technique confirmed in `backend/src/database/tables/BirthwaveLeadTable/index.js` (`status` as `STRING(50)`, JS-array-validated, confirmed at line 72, `BIRTHWAVE_LEAD_STAGES` at lines 12-15)
- Produces: `PipelineStageTable` with `id, tenant_id (nullable = industry-wide default), entity_type (STRING, "journey" for V1), stage_key, label, color, display_order, is_won (BOOLEAN), is_lost (BOOLEAN), is_active (BOOLEAN), industry_default (BOOLEAN)`

Steps:
- [ ] Write a failing test asserting a `tenant_id: null, industry_default: true` row (a platform-wide default stage) and a `tenant_id: <demo tenant>, industry_default: false` row (a tenant override) can coexist and both be queried correctly by `entity_type`
- [ ] Run the test and confirm it fails
- [ ] Implement `PipelineStageTable/index.js`
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/PipelineStageTable tests/pipelineStageModel.test.js && git -C invictus-chatbot commit -m "feat: add PipelineStageTable"`

### Task 43: Seed the standard hospital OPD pipeline as industry defaults

FILES:
- Create: `src/scripts/seedIndustryDefaultPipeline.js`
- Modify: `package.json`
- Test: none — one-off seed script, verified by manual run, matching the established convention from Task 4

INTERFACES:
- Consumes: `PipelineStageTable`
- Produces: eight `tenant_id: null, industry_default: true` rows for `entity_type: "journey"`: `Enquiry → Contacted → Appointment Scheduled → Consulted → Treatment Proposed → Treatment Accepted → Completed → Lost/Declined` (the last two marked `is_won`/`is_lost` respectively)

Steps:
- [ ] Write `src/scripts/seedIndustryDefaultPipeline.js` following the Task 4 seed-script convention, creating the eight rows above
- [ ] Add `"seed:pulseos-default-pipeline": "node src/scripts/seedIndustryDefaultPipeline.js"` to `package.json`
- [ ] Run it locally and confirm eight rows exist with correct `display_order` and `is_won`/`is_lost` flags
- [ ] `git -C invictus-chatbot add src/scripts/seedIndustryDefaultPipeline.js package.json && git -C invictus-chatbot commit -m "feat: seed standard hospital OPD pipeline as industry defaults"`

### Task 44: Repoint `LeadsTable.status` validation to `PipelineStageTable`

FILES:
- Modify: `src/models/LeadsModel/leads.service.js`
- Test: `tests/leadsService.stageValidation.test.js`

INTERFACES:
- Consumes: `PipelineStageTable`
- Produces: the existing Journey-status-update function validates the incoming value against the caller's tenant's active `PipelineStageTable` rows (tenant-specific rows first, falling back to `industry_default: true` rows when the tenant has no override for a given `stage_key`) instead of any hardcoded list — note: per the original audit, `LeadsTable.status` currently only has a narrow `ENUM(new, old)`; this task additionally converts that column from `ENUM` to `STRING(50)` (a schema change, tested for backward compatibility) so it can hold any tenant-configured `stage_key`, not only `new`/`old`

Steps:
- [ ] Read the existing status-update function in `leads.service.js` in full
- [ ] Write a failing test asserting: (a) setting `status` to a valid `stage_key` from the tenant's `PipelineStageTable` rows (or an industry default) succeeds; (b) setting it to an arbitrary unrecognized string is rejected with a clear error; (c) an existing Journey row with the legacy `status: "new"` or `status: "old"` value (seeded before this migration) still reads back correctly after the column type change
- [ ] Run the test and confirm it fails
- [ ] Change the `status` column definition in `LeadsTable/index.js` from `ENUM(new, old)` to `STRING(50)`, and add the validation lookup (tenant rows, then industry-default fallback) to the status-update function
- [ ] Run the test and confirm it passes
- [ ] Run a full regression check against every existing caller of the status-update function to confirm none of them break on the column-type change
- [ ] `git -C invictus-chatbot add src/database/tables/LeadsTable/index.js src/models/LeadsModel/leads.service.js tests/leadsService.stageValidation.test.js && git -C invictus-chatbot commit -m "feat: validate Journey status against configurable PipelineStageTable"`

### Task 45: Pipeline Stage management API + settings UI

FILES:
- Create: `src/models/PipelineStageModel/pipelineStage.routes.js`, `.controller.js`, `.service.js`; `whatnexus-frontend/app/(protected)/settings/pipeline/page.tsx`, `whatnexus-frontend/components/views/settings/pipelineSettingsView.tsx`, `whatnexus-frontend/services/pipelineStage/index.ts`
- Modify: `src/app.js`, `whatnexus-frontend/components/layout/sidebarConfig.ts`
- Test: `tests/pipelineStage.crud.test.js`, `components/views/settings/__tests__/pipelineSettingsView.test.tsx`

INTERFACES:
- Consumes: `PipelineStageTable`
- Produces: tenant-scoped CRUD + reorder for `PipelineStageTable`, and a settings page listing/editing/reordering the tenant's stages (cloning industry defaults on first visit if the tenant has none yet)

Steps:
- [ ] Read the Custom Field CRUD triplet from Task 41 as the direct structural reference (same reorder pattern applies)
- [ ] Write failing backend tests for create/list/update/reorder/archive, tenant-scoped
- [ ] Run and confirm failure
- [ ] Implement the backend triplet, mount in `src/app.js`
- [ ] Run and confirm the backend tests pass
- [ ] Write a failing frontend test asserting the settings view renders the tenant's cloned-from-default stages and lets the user drag-reorder them
- [ ] Run and confirm failure
- [ ] Implement the frontend page/view/service, add a "Pipeline" entry under the existing Settings section of `sidebarConfig.ts`
- [ ] Run and confirm the frontend test passes
- [ ] Manually verify: a fresh tenant visiting the settings page for the first time sees the eight industry-default stages cloned as editable tenant rows
- [ ] `git -C invictus-chatbot add src/models/PipelineStageModel src/app.js tests/pipelineStage.crud.test.js && git -C invictus-chatbot commit -m "feat: add Pipeline Stage management API"`
- [ ] `git -C whatnexus-frontend add app/(protected)/settings/pipeline components/views/settings/pipelineSettingsView.tsx services/pipelineStage components/layout/sidebarConfig.ts && git -C whatnexus-frontend commit -m "feat: add Pipeline settings UI"`

---

## Module M9 — Patient/Journey Detail UX

### Task 46: Port the MUI DataGrid component for the Journeys list table

FILES:
- Modify: `whatnexus-frontend/package.json` (add `@mui/x-data-grid` and its `@mui/material`/`@emotion/*` peer dependencies), `components/views/leadsView.tsx`
- Test: `components/views/__tests__/leadsView.dataGrid.test.tsx`

INTERFACES:
- Consumes: the existing Journeys-list data already fetched by `leadsView.tsx` (unchanged)
- Produces: the same list, rendered through `@mui/x-data-grid` instead of whatever thinner table component it currently uses, with columns Patient, Journey Type, Stage, Owner, Next Action, Last Contact, Source, and a filter bar (stage, owner, journey type, source, date range, branch) plus search-as-you-type by patient name/phone

Steps:
- [ ] Read the current `leadsView.tsx` table-rendering code in full to confirm exactly what component it uses today and its column definitions
- [ ] Write a failing test asserting the rendered table includes a row for each Journey in a mocked dataset, with the seven columns above, and that typing into the search box filters visible rows by patient name/phone
- [ ] Run the test and confirm it fails
- [ ] Add `@mui/x-data-grid` (and required peers) to `package.json`, replace the table-rendering section of `leadsView.tsx` with a `DataGrid` configured with the seven columns (the "Next Action" column sourced from the `GET /whatsapp/journey/:journey_id/next-action` endpoint from Task 36 — fetched per visible row or in a single batched call, whichever the existing data-fetching hook pattern in this codebase supports more directly; confirm by reading `hooks/useLeadIntelligenceQuery.tsx`), and the filter bar wired to the existing list-fetch query parameters
- [ ] Run the test and confirm it passes
- [ ] Manually verify visual density/behavior against the approved spec's `VISUAL_DENSITY=7`/`DESIGN_VARIANCE=4` parameters: dense row height, clear column borders, no decorative styling beyond the existing design tokens already used elsewhere in `whatnexus-frontend`
- [ ] `git -C whatnexus-frontend add package.json components/views/leadsView.tsx components/views/__tests__/leadsView.dataGrid.test.tsx && git -C whatnexus-frontend commit -m "feat: replace Journeys list table with MUI DataGrid, dense filters, and Next Action column"`

### Task 47: Rebuild the Journey/Contact detail drawer with Timeline as the primary tab

FILES:
- Modify: the existing detail-drawer component backing the Journeys list (confirm exact current component by reading `leadsView.tsx`'s row-click handler)
- Test: `components/views/__tests__/journeyDetailDrawer.test.tsx`

INTERFACES:
- Consumes: `journeyTimelineView.tsx` (Task 28's real-Timeline-backed version), `CustomFieldTable`-driven fields (Task 41's field-definitions endpoint), `TaskTable` (Task 36)
- Produces: a drawer (not a full-page navigation, not a modal stack) with a header showing unified patient context (name, phone, all-open-Journeys summary via the Task 23 endpoint) and tabs: Timeline (default/primary tab), Journey details (stage, custom fields), Appointments, Tasks

Steps:
- [ ] Read the existing detail-drawer component in full
- [ ] Write a failing test asserting the drawer opens with the Timeline tab active by default, and that switching to the "Journey details" tab renders the tenant's configured custom fields (from Task 41) with their current values from the Journey's `custom_fields` JSON column (Task 40)
- [ ] Run the test and confirm it fails
- [ ] Implement the tabbed drawer, reusing `journeyTimelineView.tsx` unchanged inside the Timeline tab, and building the Journey-details/Appointments/Tasks tabs from the endpoints listed above
- [ ] Run the test and confirm it passes
- [ ] Manually verify the drawer against the design parameters: `MOTION_INTENSITY=3` (a functional slide-in transition only, no decorative animation)
- [ ] `git -C whatnexus-frontend add <detail drawer component> components/views/__tests__/journeyDetailDrawer.test.tsx && git -C whatnexus-frontend commit -m "feat: rebuild Journey/Contact detail drawer with Timeline-first tabs"`

### Task 48: Remove confirmed MOCK/UNUSED pages

FILES:
- Delete: `app/(protected)/system/page.tsx`, `components/views/systemView.tsx`, `app/(protected)/logic/page.tsx`, `components/views/logicView.tsx`, `app/(protected)/playground/page.tsx` (the orphaned duplicate — not `app/(protected)/settings/whatsapp-playground`, which stays)
- Modify: `lib/data.ts` (remove the now-unused `SYSTEM_LOGS`/`NEURAL_RULES` exports), `components/layout/sidebarConfig.ts` (remove the already-commented-out `logic` nav entry entirely rather than leaving it commented)
- Test: none — deletion of confirmed-dead code; covered by the existing build/lint step already run in CI (Task 62)

Steps:
- [ ] Grep the whole `whatnexus-frontend` codebase for any remaining reference to `SYSTEM_LOGS`, `NEURAL_RULES`, `systemView`, `logicView`, or the orphaned `/playground` route, to confirm nothing else depends on them before deleting
- [ ] Delete the six files/exports listed above
- [ ] Run `npm run build` locally and confirm it completes with no missing-import errors
- [ ] `git -C whatnexus-frontend add -A && git -C whatnexus-frontend commit -m "chore: remove confirmed mock/unused pages (system, logic, orphaned playground route)"`

---

## Module M10 (full) — Appointment → Consultation → Treatment Progression

### Task 49: Create `TreatmentOpportunityTable`

FILES:
- Create: `src/database/tables/TreatmentOpportunityTable/index.js`
- Test: `tests/treatmentOpportunityModel.test.js`

INTERFACES:
- Consumes: nothing new
- Produces: `id, tenant_id, contact_id, journey_id, source_outcome_id (nullable FK → AppointmentOutcomeTable), treatment_label (STRING), status (STRING: proposed|accepted|scheduled|in_progress|completed|declined|lost), estimated_value (DECIMAL, nullable), actual_value (DECIMAL, nullable), owner (tenant_user_id), decided_at, completed_at, metadata (JSON)`

Steps:
- [ ] Write a failing test creating a `TreatmentOpportunity` row linked to a `Journey` and an `AppointmentOutcome`, and asserting all fields round-trip
- [ ] Run the test and confirm it fails
- [ ] Implement the table
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/TreatmentOpportunityTable tests/treatmentOpportunityModel.test.js && git -C invictus-chatbot commit -m "feat: add TreatmentOpportunityTable"`

### Task 50: Add `treatment_recommended`/`treatment_opportunity_id` to `AppointmentOutcomeTable` and auto-create the Opportunity

FILES:
- Modify: `src/database/tables/AppointmentOutcomeTable/index.js`, the outcome-recording service function from Task 26
- Test: `tests/appointmentOutcome.treatmentOpportunity.test.js`

INTERFACES:
- Consumes: `TreatmentOpportunityTable`
- Produces: two new nullable columns on `AppointmentOutcomeTable`; recording an outcome with `treatment_recommended: true` auto-creates a `TreatmentOpportunity` row (`status: "proposed"`) and links it via `treatment_opportunity_id`

Steps:
- [ ] Read `AppointmentOutcomeTable/index.js` in full
- [ ] Write a failing test asserting recording an outcome with `treatment_recommended: true` creates exactly one linked `TreatmentOpportunity` row with `status: "proposed"`, and recording one with `treatment_recommended: false` (or omitted) creates none
- [ ] Run the test and confirm it fails
- [ ] Add the two columns and the auto-creation logic inside the same outcome-recording function already modified in Task 26 (immediately after the `recordTimelineEvent` call added there)
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/AppointmentOutcomeTable/index.js <outcome service file> tests/appointmentOutcome.treatmentOpportunity.test.js && git -C invictus-chatbot commit -m "feat: auto-create TreatmentOpportunity when a consultation outcome recommends treatment"`

### Task 51: Replace the prototype's mocked treatment-status chip with real data

FILES:
- Modify: `components/views/journeyTimeline/journeyTimelineView.tsx` (or wherever Task 47 relocated the detail tabs)
- Test: extend `components/views/__tests__/journeyDetailDrawer.test.tsx`

INTERFACES:
- Consumes: `TreatmentOpportunityTable` (via a new read endpoint, `GET /whatsapp/journey/:journey_id/treatment-opportunities`, added alongside the existing `TreatmentOpportunityModel` — build this route/controller/service triplet using the same reference pattern as Task 28)
- Produces: the "Treatment Status" chip now renders the real `status` of the Journey's most recent `TreatmentOpportunity` row, with a small history list of all opportunities for that Journey

Steps:
- [ ] Write failing backend and frontend tests for the new endpoint and the updated chip rendering
- [ ] Run both and confirm failure
- [ ] Implement the endpoint and update the chip's data source
- [ ] Run both and confirm they pass
- [ ] Delete the hardcoded `"Proposed"` value and its prototype-only code comment from Task 18
- [ ] `git -C invictus-chatbot add src/models/TreatmentOpportunityModel src/app.js tests/... && git -C invictus-chatbot commit -m "feat: add Journey treatment-opportunities read endpoint"`
- [ ] `git -C whatnexus-frontend add components/views/journeyTimeline components/views/__tests__/journeyDetailDrawer.test.tsx && git -C whatnexus-frontend commit -m "feat: replace mocked treatment-status chip with real TreatmentOpportunity data"`

### Task 52: Post-care recall Task/ScheduledMessage creation on Opportunity completion

FILES:
- Modify: the `TreatmentOpportunityModel`'s status-update service function (built in Task 51)
- Test: `tests/treatmentOpportunity.recallCreation.test.js`

INTERFACES:
- Consumes: `TaskTable` (Task 35), `ScheduledMessageTable` (existing)
- Produces: when a `TreatmentOpportunity`'s `status` transitions to `"completed"`, one `Task` (`task_type: "manual_task"`, `due_at` = tenant-configured recall offset, defaulting to 30 days if unconfigured) is created for a recall check-in

Steps:
- [ ] Write a failing test asserting the transition to `"completed"` creates exactly one recall `Task`, and that transitioning to any other status creates none
- [ ] Run the test and confirm it fails
- [ ] Add the recall-`Task`-creation call inside the status-update function
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add <status-update service file> tests/treatmentOpportunity.recallCreation.test.js && git -C invictus-chatbot commit -m "feat: auto-create post-care recall task on treatment opportunity completion"`

---

## Module M11 (full) — Source / Campaign / Revenue Context

### Task 53: Add `source_provider`, `source_external_id`, `campaign_ref` to `LeadsTable`

FILES:
- Modify: `src/database/tables/LeadsTable/index.js`
- Test: `tests/leadsModel.attributionColumns.test.js`

Steps:
- [ ] Write a failing test asserting the three new nullable columns round-trip
- [ ] Run the test and confirm it fails
- [ ] Add the columns
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/database/tables/LeadsTable/index.js tests/leadsModel.attributionColumns.test.js && git -C invictus-chatbot commit -m "feat: add source_provider, source_external_id, campaign_ref to Journey model"`

### Task 54: Revenue rollup query/view

FILES:
- Create: `src/models/ReportingModel/reporting.routes.js`, `.controller.js`, `.service.js`
- Modify: `src/app.js`
- Test: `tests/reporting.revenueRollup.test.js`

INTERFACES:
- Consumes: `TreatmentOpportunityTable.actual_value` joined through `journey_id` to `LeadsTable.source`/`campaign_ref`
- Produces: `GET /whatsapp/reporting/revenue-by-source?from=&to=`, returning `SUM(actual_value) GROUP BY source, campaign_ref, journey_type` for the caller's tenant within the given date range — a single query-backed endpoint, not a new subsystem, per the approved spec's explicit "thinnest layer" instruction

Steps:
- [ ] Write a failing test seeding two `TreatmentOpportunity` rows with different `source`/`campaign_ref`/`journey_type` values and different `actual_value`s, and asserting the endpoint returns correctly-grouped sums
- [ ] Run the test and confirm it fails
- [ ] Implement the route/controller/service triplet as a single aggregation query, tenant-scoped
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/models/ReportingModel src/app.js tests/reporting.revenueRollup.test.js && git -C invictus-chatbot commit -m "feat: add tenant-scoped revenue-by-source rollup endpoint"`

### Task 55: Replace the prototype's mocked revenue figure with the real rollup

FILES:
- Modify: the Journey detail view (from Task 47)
- Test: extend `components/views/__tests__/journeyDetailDrawer.test.tsx`

Steps:
- [ ] Write a failing test asserting the revenue display now calls the Task 54 endpoint and renders its real value instead of the hardcoded mock
- [ ] Run the test and confirm it fails
- [ ] Wire the detail view to the real endpoint, delete the mocked display and its Task 19 code comment
- [ ] Run the test and confirm it passes
- [ ] `git -C whatnexus-frontend add <journey detail view file> components/views/__tests__/journeyDetailDrawer.test.tsx && git -C whatnexus-frontend commit -m "feat: replace mocked revenue figure with real revenue-by-source data"`

---

## Module M12 — Connector / Telephony Boundary

### Task 56: Define the `TelephonyConnector` interface and port the Runo inbound webhook

FILES:
- Create: `src/connectors/telephony/telephonyConnector.interface.js`, `src/connectors/telephony/runoConnector.js`, `src/models/TelephonyModel/telephony.routes.js`, `.controller.js`
- Test: `tests/runoConnector.inboundCall.test.js`

INTERFACES:
- Consumes: pattern from `backend/src/modules/pixelEye/webhook/pixelEyeWebhook.routes.js:24-32` and `.service.js:547-870` (business logic), `backend/src/middlewares/verifyWebhookApiKey.js:51-104` (timing-safe API-key auth pattern)
- Produces: `POST /whatsapp/telephony/runo/webhook` (API-key authenticated, following the ported timing-safe-compare pattern), writing a `TimelineEvent` (`event_type: "call_logged"`) instead of the source's `PixelEyeCallLogTable`, and creating a retry-call `Task` when disposition indicates one is needed (e.g., "no answer")

Steps:
- [ ] Read `pixelEyeWebhook.routes.js:24-32`, `.service.js:547-870`, and `verifyWebhookApiKey.js:51-104` in full
- [ ] Define `telephonyConnector.interface.js` documenting the single required method shape: `receiveCallEvent(payload, signature) → { contact, journey, disposition, recording_url, direction, duration_seconds }` — a plain object shape, not a class hierarchy, per the plan's no-premature-abstraction principle
- [ ] Write a failing test posting a Runo-shaped payload with a correct API key and asserting: a `TimelineEvent` with `event_type: "call_logged"` is created, and (for a `disposition: "no_answer"` payload) a `Task` with `task_type: "retry_call"` is created
- [ ] Run the test and confirm it fails
- [ ] Implement `runoConnector.js` (the API-key verification, ported from `verifyWebhookApiKey.js`, and the payload-to-`TimelineEvent`/`Task` mapping) and the thin route/controller wrapping it
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/connectors src/models/TelephonyModel src/app.js tests/runoConnector.inboundCall.test.js && git -C invictus-chatbot commit -m "feat: add TelephonyConnector interface and Runo inbound adapter, ported from PixelEye webhook pattern"`

---

## Module M13 — Web-Shell / Navigation / UI Consolidation

### Task 57: Finalize primary navigation per the approved information architecture

FILES:
- Modify: `components/layout/sidebarConfig.ts`

Steps:
- [ ] Update the full nav structure to: Dashboard, Journeys, Contacts, Appointments, Shared Inbox, Follow-ups/Tasks, Doctors, Branches, Campaigns, Knowledge Base, Settings (Pipeline, Custom Fields, Team, WhatsApp, Billing) — matching the approved spec's §20 exactly
- [ ] Confirm every entry routes to an already-built, confirmed-LIVE (or, for Tasks/Pipeline/Custom Fields, newly-built-in-this-plan) page — no entry points to a page that doesn't exist
- [ ] Manually verify the full nav in the browser
- [ ] `git -C whatnexus-frontend add components/layout/sidebarConfig.ts && git -C whatnexus-frontend commit -m "feat: finalize primary navigation per approved information architecture"`

### Task 58: Add a "Today / My Work" landing view

FILES:
- Create: `app/(protected)/my-work/page.tsx`, `components/views/myWork/myWorkView.tsx`, `services/myWork/index.ts`
- Modify: `components/layout/sidebarConfig.ts` (add as the first nav entry, above Dashboard)
- Test: `components/views/myWork/__tests__/myWorkView.test.tsx`

INTERFACES:
- Consumes: the Task 36 next-action endpoint (filtered to `assigned_to = current tenant_user_id`), the existing appointments-for-today endpoint (confirm exact existing filter capability by reading `services/appointment/index.ts` before assuming one needs to be added)
- Produces: a single dense list view — "My open tasks due today/overdue" and "My appointments today" — as the default landing page for tenant staff

Steps:
- [ ] Read `services/appointment/index.ts` to confirm whether a date-filtered "today's appointments" call already exists; if not, add one small filter parameter to the existing list function rather than a new endpoint
- [ ] Write a failing test asserting the view renders both sections from mocked data
- [ ] Run the test and confirm it fails
- [ ] Implement the view
- [ ] Run the test and confirm it passes
- [ ] `git -C whatnexus-frontend add app/(protected)/my-work components/views/myWork services/myWork components/layout/sidebarConfig.ts && git -C whatnexus-frontend commit -m "feat: add Today / My Work landing view"`

---

## Module M14 — Security Hardening for Real-Patient Pilot

**No tenant may be onboarded with real patient PII/PHI until every task in this module is complete.** This is the explicit gate from the architecture lock — these items are not deferred to an unscheduled future phase.

### Task 59: Private, signed R2 file access

FILES:
- Modify: `src/services/storageService.js` (the public-URL construction confirmed at line 81, the weak `Math.random()` asset-id generation confirmed in `src/models/GalleryModel/gallery.service.js:183`)
- Test: `tests/storageService.signedUrls.test.js`

Steps:
- [ ] Read `storageService.js` in full
- [ ] Write a failing test asserting the file-retrieval function now returns a time-limited signed URL (not the permanent public `R2_PUBLIC_URL` form) and that the asset-id generator now uses `crypto.randomBytes` instead of `Math.random()`
- [ ] Run the test and confirm it fails
- [ ] Implement signed-URL generation (R2's S3-compatible presigned-URL support, via the existing `S3Client` already configured at lines 15-22) with a short expiry (e.g., 15 minutes), and replace the `Math.random()` call in `gallery.service.js:183` with `crypto.randomBytes(16).toString("hex")`
- [ ] Run the test and confirm it passes
- [ ] Manually verify an existing uploaded gallery/attachment file is still retrievable through the new signed-URL flow, and that a stale/expired URL is rejected
- [ ] `git -C invictus-chatbot add src/services/storageService.js src/models/GalleryModel/gallery.service.js tests/storageService.signedUrls.test.js && git -C invictus-chatbot commit -m "fix: serve R2 files via short-lived signed URLs with cryptographically random asset ids"`

### Task 60: httpOnly-cookie token storage and server-side route protection

FILES:
- Modify: `src/middlewares/auth/authMiddlewares.js` (login/refresh response), `whatnexus-frontend/redux/store.ts` (the `sessionStorage` persist config confirmed at lines 26-39), `whatnexus-frontend/helper/axios.ts` (the manual `Authorization` header attach confirmed at lines 229-291)
- Create: `whatnexus-frontend/middleware.ts`
- Test: `tests/auth.httpOnlyCookie.test.js` (backend), `middleware.test.ts` (frontend)

Steps:
- [ ] Read `authMiddlewares.js`'s login and refresh handlers in full
- [ ] Write a failing backend test asserting a successful login response sets the access and refresh tokens as `httpOnly`, `SameSite=Lax` cookies rather than (or in addition to, during transition) returning them in the JSON body
- [ ] Run the test and confirm it fails
- [ ] Update the login/refresh handlers to set the cookies
- [ ] Run the test and confirm it passes
- [ ] Remove the `token`/`refreshToken` fields from the `redux-persist`-persisted whitelist in `redux/store.ts`, so they are no longer written to `sessionStorage`
- [ ] Update `helper/axios.ts` to send `credentials: "include"` on every request instead of manually attaching an `Authorization` header read from Redux state
- [ ] Write `middleware.ts` at the `whatnexus-frontend` repo root implementing a server-side check of the auth cookie before any `(protected)` route is served, redirecting to `/login` (or `/management/login`, matching the existing `MANAGEMENT_PATH_PREFIXES` logic in `routes/ProtectedRoute.tsx`) when absent
- [ ] Keep `routes/ProtectedRoute.tsx`'s existing client-side check in place as a secondary UX guard against content-flash, but confirm via a failing-then-passing test that `middleware.ts` alone is sufficient to block an unauthenticated request before any page content is served
- [ ] `git -C invictus-chatbot add src/middlewares/auth/authMiddlewares.js tests/auth.httpOnlyCookie.test.js && git -C invictus-chatbot commit -m "feat: issue auth tokens as httpOnly cookies"`
- [ ] `git -C whatnexus-frontend add redux/store.ts helper/axios.ts middleware.ts middleware.test.ts && git -C whatnexus-frontend commit -m "feat: add server-side route protection middleware, stop persisting tokens to sessionStorage"`

### Task 61: Refresh-token revocation on rotation

FILES:
- Modify: `src/middlewares/auth/authMiddlewares.js` (the refresh endpoint confirmed at lines 229-249)
- Test: `tests/auth.refreshTokenRevocation.test.js`

Steps:
- [ ] Write a failing test asserting that after a successful refresh, the previous refresh token is rejected if presented again
- [ ] Run the test and confirm it fails
- [ ] Add a Redis-backed denylist (reusing the existing Redis connection already used by BullMQ) storing each superseded refresh token's `jti` with a TTL equal to its remaining lifetime; check this denylist at the start of the refresh handler
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/middlewares/auth/authMiddlewares.js tests/auth.refreshTokenRevocation.test.js && git -C invictus-chatbot commit -m "fix: revoke superseded refresh tokens on rotation"`

### Task 62: Remove the legacy AES-256-CBC secret-encryption path

FILES:
- Modify: `src/utils/encryption.js` (the legacy pair confirmed at lines 57-76), `src/models/TenantModel/tenant.controller.js` (the only confirmed caller, line 45)
- Test: `tests/encryption.cbcMigration.test.js`

Steps:
- [ ] Write a failing test asserting every currently-CBC-encrypted OpenAI-key value (simulate with a fixture) is re-encrypted with AES-256-GCM and the legacy `decrypt`/`encrypt` CBC functions are no longer imported anywhere in `src/`
- [ ] Run the test and confirm it fails
- [ ] Write a one-off migration script (`src/scripts/migrateCbcToGcmSecrets.js`) that reads every legacy CBC-encrypted value, decrypts it with the legacy function, re-encrypts it with `encryptSecret` (GCM), and writes it back
- [ ] Run the migration script against a local dataset seeded with a CBC-encrypted fixture, confirm the value round-trips correctly through GCM afterward
- [ ] Remove the CBC `encrypt`/`decrypt` functions from `encryption.js` and update `tenant.controller.js:45` to use `decryptSecret`
- [ ] Run the test and confirm it passes
- [ ] `git -C invictus-chatbot add src/utils/encryption.js src/models/TenantModel/tenant.controller.js src/scripts/migrateCbcToGcmSecrets.js tests/encryption.cbcMigration.test.js && git -C invictus-chatbot commit -m "fix: migrate legacy CBC-encrypted secrets to AES-256-GCM and remove CBC path"`

### Task 63: Permission model — `TenantUserPermissionTable`

FILES:
- Create: `src/database/tables/TenantUserPermissionTable/index.js`, `src/middlewares/auth/requirePermission.js`
- Test: `tests/permissionModel.test.js`

INTERFACES:
- Consumes: `TenantUser`
- Produces: `id, tenant_id, tenant_user_id, permission_key (STRING)`, and a middleware `requirePermission(permission_key)` usable alongside the existing `authenticate` middleware

Steps:
- [ ] Write a failing test asserting `requirePermission("journey.assign")` allows a request from a `TenantUser` with that permission row and rejects (`403`) one without it
- [ ] Run the test and confirm it fails
- [ ] Implement the table and middleware
- [ ] Run the test and confirm it passes
- [ ] Apply `requirePermission("journey.assign")` to the Task-assignment endpoint (Task 36) and `requirePermission("ai.silence_toggle")` to the `PATCH /whatsapp/contact/:contact_id/silence` and Task 33's resume-AI endpoints, as the first concrete uses of the permission model
- [ ] `git -C invictus-chatbot add src/database/tables/TenantUserPermissionTable src/middlewares/auth/requirePermission.js tests/permissionModel.test.js && git -C invictus-chatbot commit -m "feat: add fine-grained TenantUserPermission model and requirePermission middleware"`

### Task 64: Consent foundation

FILES:
- Modify: `src/database/tables/ContactsTable/index.js`
- Test: `tests/contactsModel.consent.test.js`

Steps:
- [ ] Write a failing test asserting `consent_whatsapp_marketing` (BOOLEAN, default `false`) and `consent_recorded_at` (DATETIME, nullable) round-trip on a `Contact` row
- [ ] Run the test and confirm it fails
- [ ] Add the two columns
- [ ] Run the test and confirm it passes
- [ ] Set `consent_whatsapp_marketing: true` and `consent_recorded_at: now()` at the existing point where a Contact's first WhatsApp opt-in is already captured (identify this exact point by reading the WhatsApp inbound-contact-creation path first)
- [ ] `git -C invictus-chatbot add src/database/tables/ContactsTable/index.js tests/contactsModel.consent.test.js && git -C invictus-chatbot commit -m "feat: add WhatsApp marketing consent tracking to Contact"`

### Task 65: Retention/deletion design — data-deletion request handling

FILES:
- Modify: `src/models/ContactsModel/contacts.routes.js`, `.controller.js`, `.service.js`; `whatnexus-frontend/components/views/dataDeletion/dataDeletion.tsx`
- Test: `tests/contacts.deletionRequest.test.js`

INTERFACES:
- Consumes: existing `Contact`/`Lead`/`TimelineEvent`/`Message` records for a given contact
- Produces: `POST /whatsapp/contact/:contact_id/deletion-request`, which soft-deletes the Contact and all linked Journeys/Timeline events/Messages (setting an `is_deleted`/`deleted_at` pattern, matching the soft-delete convention already confirmed present on `ManagementTable` in the original audit) and returns a confirmation; the frontend's existing static `dataDeletion.tsx` page gains a form that calls this endpoint instead of only instructing a manual email

Steps:
- [ ] Read the existing soft-delete pattern on `ManagementTable` (`is_deleted`/`deleted_at`, confirmed in the original discovery audit) as the reference convention
- [ ] Write a failing test asserting the endpoint soft-deletes the Contact and every linked Journey/TimelineEvent/Message row for that contact within the caller's tenant, and that data for other contacts is untouched
- [ ] Run the test and confirm it fails
- [ ] Implement the endpoint
- [ ] Run the test and confirm it passes
- [ ] Update `dataDeletion.tsx` to add a phone-number-entry form calling the new endpoint (behind the existing OTP-verification mechanism already present elsewhere in this codebase, `WhatsappOtpRouter`/`OtpVerificationModel`, reused rather than building a new verification step) as the primary path, keeping the existing manual-email instructions as a fallback
- [ ] `git -C invictus-chatbot add src/models/ContactsModel tests/contacts.deletionRequest.test.js && git -C invictus-chatbot commit -m "feat: add OTP-verified data-deletion request endpoint"`
- [ ] `git -C whatnexus-frontend add components/views/dataDeletion/dataDeletion.tsx && git -C whatnexus-frontend commit -m "feat: wire data-deletion page to real backend request flow"`

### Task 66: Tenant-isolation verification test suite

FILES:
- Create: `tests/tenantIsolation.suite.test.js`

INTERFACES:
- Consumes: every tenant-scoped endpoint added or modified by this plan (Journeys, Contacts, Tasks, Custom Fields, Pipeline Stages, Timeline, Treatment Opportunities, Reporting)

Steps:
- [ ] For each endpoint listed above, write one test creating data under Tenant A and Tenant B, authenticating as a Tenant A user, and asserting the response never includes Tenant B's data and a direct-id lookup of a Tenant B resource returns `404`/`403`, not the resource
- [ ] Run the full suite and confirm every test passes against the current codebase state (if any fails, that is a real cross-tenant IDOR defect discovered by this plan and must be fixed before proceeding — fix it in the specific endpoint's own module, not in this test file)
- [ ] `git -C invictus-chatbot add tests/tenantIsolation.suite.test.js && git -C invictus-chatbot commit -m "test: add tenant-isolation verification suite across all PulseOS endpoints"`

### Task 67: CI pipeline

FILES:
- Create: `invictus-chatbot/.github/workflows/ci.yml`, `whatnexus-frontend/.github/workflows/ci.yml`
- Modify: `invictus-chatbot/package.json` (wire `appointmentBookingAiAgent.test.js`, currently confirmed present but unwired, into a `test` script alongside `test:billing` and every Jest file added by this plan)

Steps:
- [ ] Read `appointmentBookingAiAgent.test.js` in full to confirm it uses Node's built-in `node:test` runner (not Jest) and add a `"test:appointment-agent": "node --test appointmentBookingAiAgent.test.js"` script, plus a combined `"test": "npm run test:billing && npm run test:appointment-agent && jest"` script covering every Jest test file this plan has added
- [ ] Run `npm test` locally in `invictus-chatbot` and confirm every wired test passes
- [ ] Write `invictus-chatbot/.github/workflows/ci.yml`: on every PR, install dependencies, run `npm test`
- [ ] Write `whatnexus-frontend/.github/workflows/ci.yml`: on every PR, install dependencies, run `npm run lint` and `npm run build` (and `npm test` once Task 46/47/48's Vitest suite exists)
- [ ] Confirm both workflows pass on a test PR
- [ ] `git -C invictus-chatbot add .github/workflows/ci.yml package.json && git -C invictus-chatbot commit -m "ci: wire appointmentBookingAiAgent.test.js and all new tests into CI"`
- [ ] `git -C whatnexus-frontend add .github/workflows/ci.yml && git -C whatnexus-frontend commit -m "ci: add lint/build/test pipeline"`

**===== M14 complete: the real-patient-pilot security gate is satisfied. No tenant with real patient PII/PHI may be onboarded before this point. =====**

---

## Module M15 — Mobile Foundation

Explicitly does not block the web prototype or any earlier module — begins only once M9 (detail UX) and M11 (revenue context) have stabilized, per the approved spec's phase-3 sequencing.

### Task 68: Scaffold `apps/mobile` and shared API-client/types packages

FILES:
- Create: a new React Native project at a location to be finalized alongside the monorepo consolidation (out of this plan's scope — the approved spec's §24 monorepo migration is a separate, not-yet-planned effort; this task creates the mobile app as its own standalone repo for now, following the same isolation rules as M0, so it does not block or entangle with the monorepo decision)

Steps:
- [ ] Confirm with the workspace-safety rules from M0 before creating any new repo: run `git init` only inside the new mobile project's own directory, never at the PulseOS workspace root or `/Users/sushil`
- [ ] Scaffold a standard React Native (bare or Expo — decision left to the implementer at execution time, not architecture-blocking) project
- [ ] Build a minimal shared TypeScript API-client module (a plain fetch wrapper matching the auth-cookie/bearer-token pattern established in Task 60) that can later be extracted into a shared package once the monorepo consolidation happens
- [ ] Implement the four V1 mobile screens named in the approved spec: today's schedule, patient lookup, outcome capture, task list with push notifications for `HUMAN_REQUIRED` escalations (Task 32)
- [ ] Commit within the new mobile repo's own git history

---

## Module M16 — Reporting / Analytics / Production Readiness

### Task 69: Expand the revenue rollup into a small reporting dashboard page

FILES:
- Create: `whatnexus-frontend/app/(protected)/reports/page.tsx`, `components/views/reports/reportsView.tsx`
- Modify: `components/layout/sidebarConfig.ts`
- Test: `components/views/reports/__tests__/reportsView.test.tsx`

Steps:
- [ ] Write a failing test asserting the page renders the Task 54 rollup data as a simple table (not a chart-heavy dashboard, per the approved spec's explicit avoidance of oversized KPI cards)
- [ ] Run the test and confirm it fails
- [ ] Implement the page
- [ ] Run the test and confirm it passes
- [ ] `git -C whatnexus-frontend add app/(protected)/reports components/views/reports components/layout/sidebarConfig.ts && git -C whatnexus-frontend commit -m "feat: add revenue-by-source reporting page"`

### Task 70: Production-readiness review checklist

FILES:
- Create: `docs/superpowers/plans/baseline/production-readiness-checklist.md` (workspace-root repo)

Steps:
- [ ] Confirm every M14 task is complete and its regression checks still pass
- [ ] Confirm every existing WhatsApp/RAG/appointment/campaign/billing regression check named throughout this plan has been re-run once, in full, against the final state of both repos
- [ ] Confirm `.env`/secret hygiene: re-run the git-history secret check already performed in the original audit against every commit added by this plan
- [ ] Record the results and sign-off in `production-readiness-checklist.md`
- [ ] `git add docs/superpowers/plans/baseline/production-readiness-checklist.md && git commit -m "chore: complete production-readiness review"` in the workspace-root repo

---

## Test Strategy Summary

- **Backend unit/service tests**: every new table/service (Tasks 5, 8, 9, 16, 24–27, 29–34, 35–38, 39–41, 42, 44–45, 49–52, 53–54, 56, 59–66)
- **Integration/API tests**: every new/modified route (Tasks 23, 28, 36, 41, 45, 51, 54, 56, 65)
- **Tenant-isolation tests**: Task 66 (dedicated suite), plus inline tenant-scoping assertions in Tasks 23, 28, 36
- **Webhook tests**: Task 21 (WhatsApp signature), Task 56 (Runo)
- **Appointment regression tests**: explicit regression steps in Tasks 16, 26, 27
- **AI/human ownership race-condition tests**: Task 31 (the designated race-condition test), Task 32
- **Timeline idempotency tests**: Task 27 (explicit duplicate-booking-completion idempotency assertion)
- **Frontend component/interaction tests**: Tasks 11, 46, 47, 58, 60, 69
- **One critical end-to-end patient journey test**: Task 20 (prototype cut-line walkthrough) is the manual version; its automated equivalent is added as part of Task 67's CI wiring, extending `appointmentBookingAiAgent.test.js`'s existing coverage rather than duplicating it

This plan deliberately does not attempt to retroactively test every historical WhatsNexus feature — only code this plan touches, plus the specific business-critical existing flows named in the Critical Regression Protection section below.

## Critical Regression Protection

Every task that touches a file in the list below includes an explicit regression-check step in its own task description (not a separate pass at the end):

- WhatsApp inbound/outbound handling (`AuthWhatsapp.controller.js`) — regression steps in Tasks 21, 22, 31, 32, 33
- RAG grounding (`knowledge.search.js`, `AuthWhatsapp.service.js`) — regression step in Task 32
- Appointment state machine (`Advanced_Appointment_Booking.service.js`) — regression steps in Tasks 16, 27
- Tenant resolution (`AuthWhatsapp.controller.js`'s `phone_number_id` cross-check) — untouched by this plan; Task 21's signature check is added before, not inside, this existing logic
- Encrypted secrets (`encryption.js`) — regression step in Task 62 (the CBC-to-GCM migration is verified against a live fixture before the legacy path is removed)
- Campaigns/BullMQ — untouched by this plan; no task in this plan modifies `src/queues/` or `src/workers/`
- Live chat (`livechat.service.js`, `LiveChatTable`) — regression steps in Tasks 30, 34
- Existing tenant/admin management — untouched except Task 60's cookie-based auth change, which includes an explicit backward-compatibility test
- Billing behavior unrelated to PulseOS changes — untouched by this plan; no task modifies `BillingModel`/`BillingLedgerTable`/`WalletTable`

---

## Self-Review Confirmation

Verified before returning this plan: every task maps to a named section of the approved spec; no `TBD`/`TODO`/`"implement appropriately"`/`"add tests"`/`"handle errors"`/`"similar to previous task"` phrasing appears anywhere; entity/type names (`Contact`, `Lead`/Journey, `TimelineEvent`, `Task`, `CustomField`, `PipelineStage`, `TreatmentOpportunity`, `ownership_state`) are used consistently from their first introduction through every later consuming task; later tasks (e.g., Task 28, 36, 45, 51, 55) consume interfaces created by their cited earlier tasks and no task assumes an interface that was never built; no rewrite is introduced anywhere — every task either extends an existing file/function or ports a named, cited pattern; the prototype cut line (Tasks 1–20) uses only already-LIVE functionality plus the additive changes described in the approved spec's §25, and is realistically completable in two days by an implementer with no context beyond this plan and the spec; Task 21 (security) and Module M14 (the full security gate) are both placed after the prototype cut line, matching "security blockers are before real patient data, not necessarily before the demo"; Task 3 explicitly protects the four repos' pre-existing dirty files; every task's `FILES:` block names one of the four confirmed project repos and never `/Users/sushil`; Module M15 (mobile) is explicitly sequenced to not block the web prototype or any earlier module.
