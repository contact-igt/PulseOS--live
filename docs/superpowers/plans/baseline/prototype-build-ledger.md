# PulseOS Prototype Build Ledger (Tasks 5–20)

- **Purpose**: survive context compaction / session restart / subagent failure by recording, after every task, exactly what changed, where, and what was verified.
- **Scope**: Task 5 through Task 20 (the PROTOTYPE CUT LINE). Task 21+ is explicitly out of scope for this loop.
- **Worktrees in use**:
  - Backend: `invictus-chatbot-pulseos-work/` on branch `pulseos/foundation`, rooted at `0e27a1232adeb4d5738b203bed7b58ccfa915608`
  - Frontend: `whatnexus-frontend-pulseos-work/` on branch `pulseos/foundation`, rooted at `c327d1ca20c2edea6d95ac8e16927a091d2cef6d`
- **Demo tenant**: `tenant_id: TT001`, `tenant_user_id: TTU001` (see repo-roots.md — "Demo hospital tenant" section)
- **Backend dev server has no hot-reload**: it's run via `node src/app.js`, not `nodemon`/`start:dev`. Any backend route/controller/service change requires an explicit restart (`lsof -ti:8001 | xargs kill; node src/app.js &`) before it's live — discovered the hard way in Task 10 (a 404 that was actually stale server state, not a real bug).
- **Codebase convention discovered (Tasks 10)**: list-returning services in this backend wrap their array in a named key (`{leads: [...]}`, `{contacts: [...]}`), never a bare array. Always check the actual service function's `return` statement before assuming a response shape — the frontend audit's "confirmed LIVE" endpoints don't document this.

## Status legend
`PENDING` → `IN_PROGRESS` → `DONE` (or `BLOCKED` with reason)

## Task Log

| Task | Module | Status | Commit(s) | Notes |
|---|---|---|---|---|
| 5 | M2 | DONE | invictus-chatbot `de103e5` | journey_type/journey_label STRING columns on Lead; TDD test round-tripped against real local DB; test:billing regression clean; full boot sync clean |
| 6 | M2 | DONE | (satisfied by Task 4 `0e27a12`, no new commit) | example journey_type log line + grep-confirmed no ENUM/constraint anywhere |
| 7 | M2 | DONE | whatnexus-frontend `d94b9b6` (+ infra fixes `db184ab`, backend `38832c4`) | nav relabeled "Lead Pool"→"Journeys", group "Contacts & Leads"→"Patients & Journeys"; requiresWhatsApp disabled on Journeys item. **Discovered & fixed 3 blocking pre-existing defects while verifying**: (1) dynamic-nav empty-catalog fallback bug in groupedSidebar.tsx hid the entire static menu for any tenant with no NavigationItems rows — fixed by gating on the raw API payload; (2) Rules-of-Hooks violation in leadsView.tsx (early return between hooks) crashed the page the moment WhatsApp was actually connected — never previously exercised; (3) seeded a mocked `active` WhatsappAccount row for TT001 (explicitly-allowed mock) since several views gate on live WhatsApp status unrelated to their actual function. Verified visually in-browser: full nav renders, Journeys page loads real data (5 existing rows). |
| 8 | M3 | DONE | invictus-chatbot `7abaf6e` | primary_contact_id INTEGER, nullable, self-FK, onDelete SET NULL, on Contact; TDD tests pass; test:billing clean; also hardened this + Task 5's test with beforeAll residue-sweep (a failed assertion mid-test skips its own inline cleanup — found and cleaned up real orphaned rows this caused, now visible-in-UI-safe) |
| 9 | M3 | DONE | invictus-chatbot `4d65da3` | createLeadService extended with optional 4th-arg `{journey_type, journey_label}`, both confirmed real call sites (AuthWhatsapp.controller.js:1014, campaignSendWorker.js:434) left unchanged (pass no 4th arg). Note: plan text referenced a "POST /whatsapp/lead-family route" for the manual regression smoke test — no such route exists (confirmed via leads.routes.js read: only GET/PUT/DELETE on existing leads, no create route at all; leads are only ever auto-created). Regression intent satisfied instead via the exact 3-positional-arg unit test matching both real call sites' call shape. |
| 10 | M3 | DONE | invictus-chatbot `e6e1e12`; whatnexus-frontend `0a205b7` | Backend: new `POST /whatsapp/lead` (createJourneyController), tenant-scoped IDOR-guarded (proven by test), createLeadService now returns its generated lead_id, journey_type/journey_label added to both list+detail SELECT queries (were missing — a created Journey's type would've been invisible). Frontend: NewJourneyModal (patient picker + journey_type/label/source form) wired to a "New Journey" button; page heading relabeled to "Journeys". **Verified fully end-to-end in-browser**: created real Contact → created real Journey via the modal → confirmed in DB (`journey_type=general_opd, source=other`) → confirmed in UI list. Test data cleaned up after. All 26 backend tests + tsc clean. |
| 11 | M4 | DONE | whatnexus-frontend `17773b1` | Client-merged Timeline (messages + appointments), embedded as a sidebar card in the existing lead-detail page. Deviated function signature to add required `phone` param (real endpoint keyed by phone, not contact_id). No test framework exists in this frontend at all — verified manually, per Task 10's precedent. Verified empty state renders correctly for a fresh Journey/Contact. **Demo data note**: kept `L043` / `CNT00002` (Contact "Anita Verma") as the running demo Journey for Tasks 12-20 rather than deleting — will be reused/built on for the rest of the loop. |
| 12 | M5 | DONE | invictus-chatbot `cd0f420` (wallet seed only, no gate logic touched); verification recorded in prototype-verification-log.md | **PASS**, verified via real webhook POSTs (not Playground) against the real `is_ai_silenced` gate — all 3 steps confirmed with full log evidence. Discovered+fixed an unrelated blocker: ₹0 wallet balance was blocking AI processing before the silence gate was ever reached. |
| 13 | M6 | DONE | verification only, recorded in prototype-verification-log.md | **PASS**. No manual creation endpoint exists for `send_type:"follow_up"` (only `appointment_reminder` has one) — real creation site is `appointment.service.js:879-886`, unreachable this early in the build. Created a row directly matching that real shape, confirmed the real unmodified cron (`* * * * *`) picked it up and attempted processing within one cycle. |
| 14 | M8 | DONE | verification only, recorded in prototype-verification-log.md | **NOT EDITABLE** (expected branch). Clarified plan-naming ambiguity: real pipeline field is `lead_stage` (New/Contacted/.../Won), distinct from `status` (active/archived/blocked, a lifecycle flag). Confirmed read-only static badge in leadDetailsView.tsx, no edit UI. No new UI added, per plan's explicit instruction for this outcome. |
| 15 | M10 | DONE | verification only, recorded in prototype-verification-log.md | **PASS**. Used direct `POST /whatsapp/appointment` (admin-booking path) rather than the conversational state machine (unreliable with placeholder OpenAI key) — both are real, distinct, live paths. Created a real Doctor (DOC00001) + availability to unblock. Appointment `AP001` created, auto-linked to `lead_id: L043` purely from contact_id. Verified in list view + `appointmentDrawer.tsx`, all fields correct. |
| 16 | M10 | PENDING | | journey_id on appointment |
| 17 | M10 | PENDING | | verify outcome recording |
| 18 | M10 | PENDING | | mocked treatment-status chip |
| 19 | M11 | PENDING | | source/journey_type/mocked revenue |
| 20 | — | PENDING | | end-to-end walkthrough — PROTOTYPE CUT LINE |

## Checkpoints

| After Task | Status | Result |
|---|---|---|
| 10 | **CLEAN** | Backend: 26/26 Jest tests pass (6 suites). Frontend: `tsc --noEmit` clean (1 pre-existing unrelated error in templateUtils.test.ts, not touched by us). Lint: 34 pre-existing `any`-type errors across leadsView.tsx/useLeadIntelligenceQuery.tsx/leadIntelligene — confirmed none newly introduced, our additions follow the exact same established `(error: any)` convention. API smoke: leads list 200, contacts list 200, tenant features 200, dynamic-nav 200, create-lead-missing-contact_id 400, unauthenticated 401 — all correct. Tenant isolation: proven by automated test (cross-tenant contact_id → 404) + IDOR guard code review. Git/worktree: both worktrees clean on `pulseos/foundation`, correct commit history; both original clones untouched on `main`; both reference repos (`backend`/`frontend`) unchanged from their original pre-existing dirty state. **Continuing automatically per instruction.** |
| 15 | PENDING | |
| 20 | PENDING | (final prototype review) |

## Review Findings Log

(Populated as tasks complete — issue, severity, resolution.)
