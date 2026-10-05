# PULSEOS — CENTRAL PLATFORM READINESS AUDIT

Audit date: 2026-09-28. Read-only, multi-agent (7 parallel agents: A Product/Journey, B
Integrations/CDP/CCS, C Calls/WhatsApp/Telecalling, D Backend/Data Integrity, E Frontend/UI, F
Responsive/Accessibility, G QA/Regression/Code Efficiency), controller-synthesized. No application code,
schema, or CCS configuration was changed. No merge, no deploy.

## EXECUTIVE SUMMARY

PulseOS's core Patient≠Journey data model, identity resolution, source-attribution immutability, and the
recently-built CommunicationEndpoint/Runo/WhatsApp omnichannel layer (documented 2026-09-22) are **genuinely
solid and independently reproduced today**, in code and against the live running system, by multiple agents
working separately. Zero regressions were found against the specific, checkable claims in the 2026-09-22
final audit doc — everything that doc said was fixed is still fixed, six days later.

That solid foundation sits under three real, structural gaps that stop PulseOS from being a trustworthy
central platform *today*, in order of severity:

1. **Revenue/Attribution — the second half of the product's own name — has zero production write path.**
   `revenueEvents` is inserted exactly once anywhere in the codebase: in the seed script. A real treatment
   completed in the running app today generates **zero** attributed revenue, permanently. Every "Attributed
   Revenue" figure a user sees is either seed fiction or will read as a stuck zero.
2. **A live, reproducible, PHI-adjacent access-control gap**: `GET /tasks` lets any authenticated
   `VIEW_TASKS` role (including Doctor, who has no task-management permission at all) read every task in the
   tenant, including other staff members' free-text notes, by omitting or varying one query parameter. Three
   agents independently reproduced this live with real data.
3. **WhatsApp conversations are never linked to a Journey.** `conversations.journeyId` is written nowhere —
   not on create, not on update. Every WhatsApp Timeline event is permanently `journeyId: null`, which
   silently breaks the product's own per-journey Timeline filter (built specifically for the "multiple
   concurrent journeys" north-star scenario) for every WhatsApp message, for every patient, always.

Below those three, the omnichannel work itself (multi-hospital-number endpoints, Runo/WhatsApp resolution,
the Telecaller reason-pill filter) is real and well-tested but **currently invisible in a freshly-seeded
demo** — zero `calls` or `communicationEndpoints` rows are seeded — and the two headline UI affordances built
on it (the "New Enquiries" pill, any endpoint label anywhere) have no data path to ever populate for a normal
user, because auto-generated tasks are created with no owner.

Given the size of what's actually solid vs. gapped, a category count is more honest here than an invented
percentage:

- **Verified built and independently reproduced**: 9/9 items on the Patient Journey core chain except the
  final Revenue link; the full CommunicationEndpoint/Runo/WhatsApp resolution layer (3 previously-fixed
  Opus-review bugs, all reconfirmed unchanged); tenant isolation on every mutation route sampled; idempotency
  on every provider webhook path; the appointment and treatment transition graphs (with one new gap each,
  see below).
- **Built but partial**: 3 (WhatsApp→Journey linking is written but null; Patient 360's active-journey count
  includes `lost` journeys; the whole endpoint/calls feature is dormant in fresh demo data).
- **Missing**: 1 structural (Revenue write path), plus several smaller UX gaps (click-to-call/WhatsApp
  affordance, WhatsApp delivery-status read path, WhatsApp media support).
- **New, previously-undocumented findings this pass**: `rescheduleAppointment` has zero status guard;
  `GET /tasks` leaks org-wide by default (broader than the 2026-09-22 docs' own framing of the same gap); a
  real React state-reset race in the Add Lead drawer (see Test Baseline).

## CANONICAL RUNTIME

- **Worktree**: `/Users/sushil/Documents/CODE FILES SUSHIL/PulseOS/.claude/worktrees/pulseos-foundation-convergence` — confirmed via `pwd`.
- **Branch**: unknown — `git` is non-functional in this environment (see below).
- **HEAD**: unknown — same reason.
- **Git**: **BLOCKED.** `git rev-parse --show-toplevel` (and every other git command, including read-only
  `git status`) fails with: *"You have not agreed to the Xcode license agreements. Please run
  'sudo xcodebuild -license' from within a Terminal window..."* This has been true continuously across many
  days of this engagement and requires the user to run that command themselves in a real Terminal (outside
  this tool's reach — it needs interactive sudo). Every change described anywhere in this document and its
  referenced predecessor audits exists only as **uncommitted working-tree state**. This is the single
  largest risk to all work done in this engagement, independent of anything else in this report.
- **WEB**: `http://localhost:3310` — PID 12064, `cwd` confirmed = `.../pulseos-foundation-convergence/apps/web`, `GET /login` → 200.
- **API**: `http://localhost:4310` — PID confirmed same worktree, `cwd` = `.../apps/api`, `GET /health` → `{"ok":true}`.
- **DB**: local Postgres, `postgres://localhost:5432/pulseos_dev`, live and reachable (`psql` connects
  cleanly). WEB and API are proven to belong to the **same** canonical worktree by direct `lsof -p <pid> |
  grep cwd` on both PIDs.
- **Methodology caveat, important for reading every "live" claim below**: 5 parallel audit agents plus the
  controller's own baseline-testing runs all hit this same shared dev Postgres instance concurrently during
  this audit. Multiple agents independently observed patient counts, tenant UUIDs, and session validity
  shifting between their own consecutive requests. Every agent flagged this itself and re-verified
  code-level claims fresh rather than trusting a single stale snapshot; the controller performed a final
  clean `pnpm db:seed` before locking in this document's own direct verifications. Any specific row count
  quoted anywhere in this report (agent-sourced or the controller's own) should be read as "true at the
  moment it was captured," not as the current live count at the instant you read this.

## TEST BASELINE

All run today, in the order specified, on a freshly reseeded DB unless noted.

- **Lint**: `pnpm -r lint` — **CLEAN.** apps/api, apps/web both pass with zero errors/warnings.
- **Typecheck**: `pnpm -r typecheck` — **6 of 7 packages CLEAN**; `apps/web`'s standalone `tsc --noEmit`
  script reports 2 "Duplicate identifier" errors. **Classified ENVIRONMENT, not a product defect**: the
  errors are both inside the gitignored `.next/types/` build-cache directory, in a pair of byte-identical
  duplicate files (`routes.d.ts` vs `routes.d 2.ts`, `cache-life.d.ts` vs `cache-life.d 2.ts`, etc. —
  `diff` confirms zero difference between each pair, only different mtimes: one from a `pnpm -r build` run
  six days ago, one from the dev server's own later regeneration). `apps/web/tsconfig.json`'s own `include`
  glob (`.next/types/**/*.ts`) picks up both, so the plain `tsc --noEmit` script sees two conflicting
  declarations of the same Next.js-generated globals. This is **not** picked up by Next's own internal
  type-checking pass — `pnpm -r build`'s "Running TypeScript..." step (which DOES gate the production build)
  passed cleanly both before and after this finding, confirmed twice. Not fixed here: deleting `.next` risked
  destabilizing the live dev server mid-audit (forbidden — "leave WEB+API running"), and narrowing the
  tsconfig glob is a source change (forbidden — audit only). Likely root cause: this Mac's `~/Documents`
  path is commonly iCloud Drive-synced, and macOS/iCloud append " 2" to a file on a sync conflict — consistent
  with the observed pairing.
- **Unit/API**: `pnpm vitest run` (apps/api) — **271/271 tests, 40/40 files, PASS.** Run twice consecutively
  fresh after reseed (15.9s and clean); a third run without an intervening reseed correctly reproduced the
  project's own long-documented "needs reseed between back-to-back runs" pattern (4 failures, all fixed-literal
  `providerRef` 409s) — this is TEST DATA POLLUTION, not a product bug, and Agent G independently root-caused
  the exact 2 files/4 lines responsible (see REGRESSIONS FOUND).
- **Build**: `pnpm -r build` — **CLEAN.** `apps/api`'s `tsc -p tsconfig.json` and `apps/web`'s `next build`
  (Turbopack) both succeed; all 18 web routes compile; Next's own internal TypeScript pass succeeds (proving
  the standalone-script typecheck failure above is real but not build-blocking).
- **Playwright**: `npx playwright test` (apps/web, full suite) — **56/58 passed, 1 pre-existing skip, 1
  FAILED** (`crm-critical-flows.spec.ts` FLOW 2). Classified **PRODUCT BUG, reproduced twice** (once in the
  full suite, once in isolation with `-g "FLOW 2"` immediately after a fresh reseed — same failure both
  times). Root-caused via the saved Playwright trace/error-context snapshot: at the moment of failure, the
  reopened Add Lead drawer's Phone field is **empty** and every other field has reverted to its default
  ("Select specialty…", "Select branch…") — i.e., the drawer silently reset itself sometime after the test's
  `.fill(phone)` call landed. Traced to a real, systemic pattern: all four Quick Create drawers
  (`AddLeadDrawer.tsx:112-120`, `AddPatientDrawer.tsx:31-40`, `AddTaskDrawer.tsx:48-58`,
  `NewAppointmentDrawer.tsx:55-66`) stay mounted across close/reopen (each has `if (!open) return null;`
  inside the component, not in the parent) and reset their form state via a `useEffect` watching `[open]` —
  which runs *after* paint, not synchronously with the click that made the drawer visible. This creates a
  real (if narrow, in normal human-speed usage) window where a fast typist or fast automation can fill the
  now-visible field before the reset effect fires, and have it silently wiped moments later. This project's
  own 2026-09-21 ledger documents this exact test passing 55/55 twice consecutively (including with no
  reseed between runs) five days before this audit, and neither this agent's session nor any of today's 6
  parallel audit agents touched `AddLeadDrawer.tsx` or any of the other 3 drawer files (confirmed: none of
  today's file-level findings from any agent name these 4 files as edited, and `find ... -newer <2026-09-22
  audit doc>` — run independently by Agent A — found zero touched source files anywhere in `apps/`). The most
  likely explanation is a **latent race that has always existed** in this shared drawer pattern, and today's
  unusually high concurrent system load (5-7 parallel audit agents plus the controller's own test/build runs,
  all on one machine) was enough to reliably expose a timing window that a quieter machine on 2026-09-21
  apparently did not hit. Flagged as PRODUCT BUG (the race is real and reproducible) with an ENVIRONMENT-load
  contributing factor honestly noted — not fixed in this audit pass.

## CURRENT PRODUCT MAP

### BUILT + VERIFIED
Patient≠Journey schema separation · multiple concurrent journeys per patient (live-proven, real seeded
patients with 2 active journeys) · phone-normalization + existing-patient-reuse identity resolution (same
mechanism used by every entry point: manual intake, lead ingestion, both webhooks) · Journey association for
calls and lead-ingestion · Timeline writes for the large majority of domain events · Next Action computation
· specialty custom fields (capture + historical-value preservation, deliberately not filtered to
active-only on Patient 360) · source-attribution immutability (`journeys.source` set exactly once at
INSERT, zero UPDATE call sites touch it; campaign touchpoints append-only) · CommunicationEndpoint schema,
migrations, service layer, routes, and permission split · Runo/WhatsApp endpoint resolution (both
directions — inbound AND outbound, the Addendum-4 fix) · all 3 previously-fixed Opus-review bugs
(Attention-Queue whitelist, conversation-merge-by-endpoint, outbound-send-honors-resolved-line) ·
webhook signature verification before any DB write, on every provider · real DB unique-constraint
idempotency (calls, messages, connector events, endpoints) · tenant isolation on every mutation route
sampled (5/5, always session-derived) · Runo/WhatsApp/Meta/Google Ads/GBP/Website Form all genuinely wired
· the missed-call → CALLBACK task mechanism · the Task architecture as the sole, unduplicated follow-up
mechanism (no competing entity) · appointment and treatment transition graphs enforced server-side (with
one new gap each — see below) · secrets never leaked via any connector-reading route.

### BUILT BUT PARTIAL
- WhatsApp/Runo endpoint labeling: code-complete, zero demo rows seeded, invisible in a fresh demo.
- Calls card: fetches `provider`/`phone`/`journeyId` but never renders them.
- WhatsApp `deliveryStatus`: written on both send and status-webhook, never read back anywhere (no API
  field, no UI).
- Patient 360's "N active journeys" header: includes `lost` journeys in the count (no stage filter),
  inconsistent with the same product's own `activeJourneyCount` on the Patients list one screen over.
- 6 real Timeline eventTypes (`website_form_submitted`, `meta_lead_received`, etc. — acquisition-channel
  first-touch events) fall through to category "other," and there is no "Other" filter button in the
  Timeline UI, so a patient's very first touchpoint can only ever be seen under "All."

### FRONTEND ONLY
None found — every frontend-facing capability this audit checked has a real backend behind it (no
frontend-only mocked features detected).

### BACKEND ONLY
- `revenueEvents` — read in 3 places, written in exactly one (seed.ts). The read side (dashboards, Patient
  360) is real UI; the write side does not exist for real data.
- `GET /connectors/:id/endpoints/resolve` — a real, working, permission-gated route with zero consumers
  outside its own test.
- `connectorDispositionMappings` / `connectorConfigAuditEvents` — full schema, zero reads or writes anywhere.

### NOT CONNECTED END-TO-END
- `conversations.journeyId` — the column exists, is read by the frontend's per-journey Timeline filter, and
  is never written by either the insert or any of the 6 UPDATE call sites that touch `conversations`.
- Auto-generated `new_lead` / no-journey missed-call tasks — created with `assignedTo: null`, and every My
  Work query (all 5 date tabs) always filters by the current viewer's own id, so these tasks are invisible
  to literally every individual user, with no "team queue" view anywhere to catch them.

### NOT BUILT
Click-to-call / click-to-WhatsApp affordance anywhere in the product (not even a plain `tel:`/`wa.me` deep
link, which needs no provider API at all) · structured task outcome/disposition capture beyond a free-text
note · branch/specialty/source/owner filters in My Work · WhatsApp media support (type system has no media
field at all; any non-text inbound message collapses to a literal placeholder string) · WhatsApp Coexistence
/ message echoes / history import · signed/proxied call-recording playback (still a raw permanent link) ·
call transcription/AI summary · retry/reconciliation for any webhook delivery (fire-and-forget everywhere) ·
Exotel/Superfone provider adapters (connector rows exist as "Not configured" placeholders with zero wiring
behind them).

### EXTERNAL BLOCKERS
- **CCS/IVRSMS**: zero codebase footprint (confirmed by fresh grep, independently, by 2 agents). Portal
  (`https://ccs.ivrsms.com/admin/webhook-configuration`) is reachable but sits behind a full auth wall
  (email/password + mobile OTP + a security question) — no credentials exist in this environment, none were
  attempted or guessed, nothing was submitted. Every requested field (event types, payload, auth mechanism,
  provider call ID, caller/hospital number, agent, direction, timestamps, duration, status, disposition,
  missed-call signal, recording, retry/test capability) is **UNKNOWN / PROVIDER_BLOCKED**. See the dedicated
  CCS section below.
- Runo click-to-call, real-time call polling, recording fetch — confirmed architecturally absent from
  Runo's actual public API (not assumed; verified against their real OpenAPI spec in a prior session, and
  the adapter's declared capabilities — `RECEIVE_CALL_EVENT`, `RECEIVE_RECORDING` only — reconfirmed today).
- WhatsApp Coexistence, message echoes, history import — all require a real Meta Solution-Partner account;
  not fixture-buildable.

### INTENTIONALLY DEFERRED
Full Telecaller Workspace restructure beyond the reason-pill row · signed-proxy recording playback pending
a verified real Runo webhook payload · `JOURNEY_LINK_REQUIRED` ambiguous-journey UI state · a second-tenant
fixture for genuine cross-tenant test coverage (systemic gap, named twice now, not yet built) · deciding
default ownership/assignment policy for auto-generated tasks.

## PATIENT / JOURNEY CORE
Solid. Patient≠Journey is enforced at the schema level (separate tables, non-unique FK index — nothing
prevents N journeys per patient) and live-proven with real seeded patients carrying 2 simultaneous
non-terminal journeys of different sources/stages. Identity resolution (`phone.ts`'s `normalizePhone` +
`identity.service.ts`'s `resolveOrCreatePatient`) is the single mechanism used by manual intake, lead
ingestion, and both webhooks — no duplicate/competing identity logic found anywhere. Journey association for
calls/leads correctly reuses `findMostRecentActiveJourney`. The one real crack: `getPatient360`'s journey
query has no stage filter (unlike the Patients list and lead-lookup, which both correctly exclude `lost`),
so a dead journey can render as "1 active journey" on Patient 360 — live-reproduced on a real seeded patient.

## LEADS / SOURCES
Lead intake captures specialty custom fields with server-side required-field validation (not just UI).
Source is set once at journey creation and never touched again by any UPDATE call site — attribution
immutability is structural, not policy. Exotel/Superfone exist only as unwired connector placeholders;
walk-in/referral/manual-phone are pure `source` enum values with zero connector backing (by design — they're
not automatable channels).

## TASKS / FOLLOW-UPS
Confirmed the Task architecture (`tasks` + `taskReasonEnum`) is the sole follow-up mechanism — no parallel or
competing entity exists anywhere in the 30-table schema (`consultationOutcomes.status`'s
`FOLLOW_UP_REQUIRED` value is a status field, not a scheduling entity; it still routes through `tasks`).
**Critical, live-reproduced finding**: `GET /tasks` has no default self-scoping at all. `getTaskCounts` (My
Work's own badge numbers) is correctly scoped to the caller; `listTasks`/`GET /tasks` is not — any
`VIEW_TASKS` role, with or without `MANAGE_TASKS`, sees the whole tenant's task queue including other staff
members' free-text notes, by default, with no query parameters needed at all. Reproduced live, independently,
by 3 separate agents (B, C, D) using different accounts (`doctor@pulseos.local`, `coordinator@pulseos.local`)
against real seeded task notes ("Post-op check-in call," "Confirm tomorrow's 11am slot with patient"). This
is broader than the 2026-09-22 docs' own framing (which described only "an unscoped `assignedTo` param");
omitting the param entirely leaks the same data.

## APPOINTMENTS
`applyAppointmentAction`'s `VALID_FROM_STATUSES` graph is real, enforced, and self-consistent — confirmed
reachable/exitable for every non-terminal state. **New finding, not in any prior doc**:
`rescheduleAppointment` (`appointment.service.ts:221-232`) has **zero** status guard — no
`VALID_FROM_STATUSES` check, no route-level guard — and unconditionally sets `status: "scheduled"`
regardless of current status. Every other appointment mutation in the same file enforces the graph;
`completeAppointment` requires `with_doctor`; the frontend's own `CAN_RESCHEDULE` set deliberately excludes
`checked_in`/`waiting`/`with_doctor`/`completed`. A direct `PATCH /appointments/:id/reschedule` call — same
`MANAGE_APPOINTMENTS` permission any legitimate front-desk reschedule already uses — can silently revert a
completed consultation back to "scheduled." Confirmed by code read only (not live-mutated, correctly, given
the audit's read-only/no-destructive-action constraint).

## TREATMENTS
`VALID_TRANSITIONS` graph confirmed complete and correctly enforced, all completion side-effects (post-care
task, recall task, conversion-feedback event) fire correctly — but conversion-feedback is a marketing-platform
signal, not a revenue record (see Revenue Attribution's own section — the treatment-completion path never
creates a `revenueEvents` row despite `estimatedValue` being right there on the same row it already reads).
Minor hygiene: `treatment_status`'s `LOST` value is unreachable via the real transition graph (only appears
in seed fixtures) and `appointment_status`'s `requested` value is never written by any code path — neither
is a functional bug, both are undocumented dead-enum-value hygiene.

## PATIENT 360
Strong overall (custom fields, historical-value preservation, Calls card, Timeline). Two real gaps: the
active-journey-count/`lost`-journey mislabeling above, and the Calls card silently omitting
`provider`/`phone`/`journeyId` despite the API already returning them.

## TIMELINE
The large majority of domain events write a real Timeline row with correct `relatedEntityType`/
`relatedEntityId` traceability (calls, tasks, appointments, treatment status changes, manual leads, both
inbound and outbound WhatsApp messages). The one structural break: every WhatsApp-sourced Timeline event
carries `journeyId: null` forever, because `conversations.journeyId` itself is never set (see below) — this
silently defeats Patient 360's own per-journey Timeline filter for WhatsApp specifically, for every patient,
always. Demo-seeded conversations/messages have **no** Timeline representation at all (seed.ts inserts them
directly with no matching `timelineEvents` row).

## TELECALLER WORKSPACE
- **New Leads**: pill exists ("New Enquiries," correctly avoiding "Lead" per CLAUDE.md's own wording rule),
  but structurally always empty for every real user — every `new_lead` task is created unassigned, and My
  Work always filters by the viewer's own id. Confirmed live: 8/8 real `new_lead` tasks tenant-wide were
  unassigned at time of check.
- **Follow-ups**: pill exists, correctly groups `overdue_callback`+`treatment_decision_pending`+
  `high_intent_uncontacted`, populated with real data in the demo (3 in one live check).
- **Overdue**: the existing date-tab mechanism (not reason-based), unaffected by this pass, working.
- **Missed Calls**: pill exists and correctly filters, but suffers the same unassigned-task invisibility
  when the caller is brand-new with no prior journey.
- **Appointments/Callbacks**: no dedicated pill; covered generically by the `CALLBACK` task type within the
  existing tabs, not a distinct queue.
- **Source filters**: none exist in My Work at all — no branch, specialty, source, or owner filter, only the
  5 date tabs × 5 reason pills.
- **Outcome capture**: free-text note only; no structured disposition field on task completion.
- **Contact affordance**: none. No click-to-call or click-to-WhatsApp anywhere in the product — a telecaller
  must leave PulseOS entirely to actually contact a patient, even via a plain `tel:`/`wa.me` link that would
  need no provider API.

## OMNICHANNEL
- **Calls**: read path real and tested (status, duration, disposition, agent, recording link, endpoint
  label all render), but `provider`/`phone`/`journeyId` fetched-and-unused; transcript/summary honestly
  absent (Runo has no such capability — confirmed, not silently omitted).
- **WhatsApp**: inbound/outbound both real, both endpoint-resolved (the Addendum-4 fix), Timeline-echoed on
  both directions. Delivery status written, never read back. Media entirely unsupported at the type level,
  not just the UI. Journey linking never set (see Timeline section).
- **Unified conversation**: the underlying mechanism (Timeline's `relatedEntityType`/`relatedEntityId`, the
  "Communication" category filter) genuinely interleaves calls and WhatsApp chronologically where both have
  a `journeyId` — which Calls do and WhatsApp currently doesn't, so "unified" is real for calls, broken for
  WhatsApp specifically when a per-journey filter is active.
- **Summaries**: not built (needs the transcript pipeline first, which needs a verified real Runo webhook
  payload first — honestly sequenced as blocked-behind-blocked, not silently promised).
- **Recordings**: real link-out, unsigned, permanent — documented limitation, unchanged.
- **Transcripts**: not built, provider-blocked (Runo has no such API).

## COMMUNICATION ENDPOINTS
- **Multiple hospital numbers**: schema/service/routes/permission-split all real and correct — reconfirmed
  live, including the `VIEW_COMMUNICATION_ENDPOINTS` boundary (front desk/coordinator: 200; doctor: 403).
  Currently **zero rows exist in a freshly seeded demo DB** — the feature is real but dormant out of the box.
- **Branch/service mapping**: `branchId` is a real optional field on an endpoint, correctly optional (a
  specialty line can span branches) — built.
- **Provider mapping**: WhatsApp resolves via the real `phone_number_id` (provider-verified); Runo resolves
  only via "exactly one active endpoint" (an honest, non-guessing default) — both correctly documented as
  different confidence levels in the type system's own comments, not glossed over.

## CCS / IVRSMS
- **Portal access**: reachable, but behind a full auth wall (email/password + mobile OTP + security
  question). No credentials available in this environment; none attempted.
- **Verified webhook capabilities**: NONE — zero codebase integration exists today (fresh `grep` for
  "ccs"/"ivrsms" across the entire codebase returns zero hits, confirmed independently twice).
- **Payload**: UNKNOWN / PROVIDER_BLOCKED.
- **Authentication**: UNKNOWN / PROVIDER_BLOCKED.
- **Inbound**: UNKNOWN / PROVIDER_BLOCKED.
- **Outbound**: UNKNOWN / PROVIDER_BLOCKED.
- **Missed**: UNKNOWN / PROVIDER_BLOCKED.
- **Agent**: UNKNOWN / PROVIDER_BLOCKED.
- **Endpoint**: UNKNOWN / PROVIDER_BLOCKED.
- **Disposition**: UNKNOWN / PROVIDER_BLOCKED.
- **Recording**: UNKNOWN / PROVIDER_BLOCKED.
- **Unknowns**: every field the master prompt asked for, listed above — none invented, none assumed.
- **Required implementation**: none possible until real CCS credentials/API documentation are obtained from
  the user or the provider directly. Once available, the existing Runo adapter (`adapters/runo.ts`) and its
  webhook-verification pattern are the correct template to follow — CCS would become a 4th telephony adapter
  in the same `registry.ts` pattern, not a new architecture.

## RUNO
**Current implementation**: real, webhook-verified (timing-safe HMAC-equivalent API-key check before any DB
write), idempotent (real DB unique constraint on `externalCallId`), missed-call → task, disposition mapping,
endpoint resolution (exactly-one-active-endpoint rule). **Real capabilities**: receive call event, receive
recording URL (raw link only). **Known limitations**: no click-to-call, no real-time polling, no recording
fetch (Runo's API architecturally does not offer these — confirmed against their real OpenAPI spec, not
assumed). **Remaining gaps**: endpoint resolution goes silently ambiguous (`null`) the moment a second Runo
line is configured — an honest, documented cliff-edge, not a hidden one, but worth surfacing to whoever
completes the "N hospital lines" story for telephony specifically.

## WHATSAPP
**Current implementation**: Cloud API inbound+outbound, both endpoint-resolved. **Cloud API**: real, tested,
idempotent. **Coexistence**: not built, provider-blocked (needs a real Meta Solution-Partner account).
**Endpoint resolution**: real, bidirectional, live-verified. **Inbox**: real, full ownership lifecycle
(claim/assign/return-to-AI/close) working live. **Patient history**: real for calls and text messages;
broken specifically for the per-journey filtered view (journeyId always null). **Remaining gaps**: no media
support at the type level; delivery status write-only; no Coexistence/history-import/message-echoes.

## META / GOOGLE / WEBSITE / GBP
All 4 confirmed genuinely wired (real webhook routes, real signature/key verification, real idempotency).
Website Form is deliberately not adapter-pattern (it's PulseOS's own first-party endpoint, by design, not a
gap).

## CONNECTOR / EVENT RELIABILITY
- **Event inbox**: real (`connectorEvents` table + `recordConnectorEvent`), used by all wired providers.
- **Idempotency**: real DB unique constraints back every provider (calls, messages, connector events,
  communication endpoints), not just app-level logic — confirmed by direct schema introspection against the
  live DB, not just source reading.
- **Retries**: **none exist anywhere.** Confirmed by grep across the entire connector domain — a failed/
  dropped webhook is recorded (`markEventFailed`, `touchConnectorError`) but never re-attempted or
  reconciled against the provider's own API. Fire-and-forget, permanently, for every provider.
- **Reconciliation**: none — no periodic job diffs `connectorEvents` against any provider's own event log.
- **Errors**: surfaced via `connectors.lastError`, visible in the Integrations UI — real, but only after the
  fact, with no operator alerting.

## ATTRIBUTION
- **Original source**: structurally immutable — set once at journey creation, zero UPDATE call sites ever
  touch `journeys.source` anywhere in the non-seed codebase.
- **Interaction channel**: tracked separately and correctly on `calls`/`conversations`, never conflated with
  source.
- **Provider**: tracked on the connector, correctly denormalized onto `calls`/`communicationEndpoints`.
- **Endpoint**: the 4th, genuinely orthogonal dimension this session's earlier work added — correctly kept
  separate from source/channel/provider, not collapsed into any of them.
- **Revenue**: **broken.** See Executive Summary — no production write path exists for `revenueEvents` at
  all. Every attribution chain in this product currently terminates at a real, measured Journey/Treatment
  state, then falls off a cliff into fictional (seed-only) revenue numbers.

## UI AUDIT

Graded against docs/ui/pulseos-visual-reference-notes.md's own established hierarchy (not generic taste),
from the 1440-width captures in review-artifacts/2026-09-28-central-platform-audit/, cross-referenced
against source to separate real defects from deliberate, documented decisions.

| Page | Grade | Top issues |
|---|---|---|
| Login | A− | Clean, matches reference closely. Dev-login controls render collapsed in every capture — contents unverified from a screenshot. |
| Command Centre | A− | Strongest page in the app. `PatientFlowBoard` is a genuinely well-built segmented bar (zero-count buckets render as a subdued sliver, not nothing) — closes a gap the reference notes had previously flagged. Looks sparse today only because demo data has 1 appointment (data, not design). |
| Leads | A− | Strong table/KPI strip/tabs. "Normal" priority renders as plain text next to a badge for "High" — deliberate de-emphasis, reads slightly inconsistent at a glance. |
| Patients | A− | Clean dense table; no pagination footer, immaterial at 26 demo rows, would matter at real scale. |
| Journeys | A− | Strongest "operational" table in the app; 6-cell KPI strip including Revenue/Spend-at-risk. |
| Patient 360 | B | Solid execution of the current layout; the tab-based redesign the reference doc itself calls a priority is explicitly, honestly deferred, not silently skipped. |
| Campaigns/Sources | A− | Dense, well-organized; Spend-at-Risk severity coloring correctly follows CLAUDE.md's warning-color rule. |
| Campaign Detail | A− | Consistent header pattern; patient names are real links to Patient 360. |
| Integrations | A− | Master-detail layout reads like a real ops tool, not a template. |
| Settings | **C** | Functionally correct (custom-field editor fully wired) but the page is one card floating in empty white space — no Hospital Info/Branches/notification sections, "Team" nav item correctly grayed as not-built. Reads as an unfinished admin panel to a cold reviewer even though what's there works. |
| Appointments | B | Correctly wired tabs/filters/table; "Today" shows 1 row against a mostly-empty page — thin demo data, not a layout bug, but the least visually convincing static screenshot in the app. |
| Treatments | A− | Clean status-summary + table; contextual actions correctly disappear once a treatment is Completed. |
| Global Search (open) | B+ | Screenshot only shows the pre-2-character state (component correctly requires a 2-char minimum before firing) — not a bug, just an unverified state. |
| Add Lead Drawer | A− | Comprehensive, well-grouped, disabled-until-valid submit — good UX discipline. |
| Add Patient Drawer | B+ | Clean but visibly emptier than Add Lead's drawer shell — same sticky-footer pattern, thinner form. |
| Quick Create Menu | A− | Correctly role-scoped (e.g. Doctor sees none of these items). |
| Front Desk | A | Best match anywhere in the app to the reference collage's own description — KPI strip, segmented flow bar, Waiting Queue, grouped-reason panels. |
| New Appointment Drawer | B+ | Functional but visually sparse, same emptiness pattern as Add Patient. |
| My Work | B | Functionally rich (date tabs + reason pills with live counts, inline notes, contextual actions — all verified wired), but in this data snapshot ~4 of 6 visible rows get the same full-row red overdue tint simultaneously, diluting the signal's meaning — a real information-hierarchy issue, not a code bug. |
| Inbox | A− | 3-pane split matches the reference; ownership-state badges are a strong, non-generic pattern. |
| Doctor Home | A− | Tight, role-appropriate dashboard matching the reference's own callout for this page. |

**AI-slop patterns found: none.** Specifically checked for and did not find gradient cards, oversized
decorative icons, giant KPI tiles, glassmorphism, emoji icons, card-grid overload, or generic
dashboard-template filler anywhere. Buttons are centralized through a shared `Button` primitive; a couple of
pages (`settings/page.tsx`, `my-work/page.tsx`) hand-roll near-identical button classNames instead of
importing it — a minor code-hygiene drift with no current visible difference, not a defect.

**Significant problems: none rise to "broken" or "inaccessible."** The worst finding (Settings, grade C) is
a scope/completeness gap — what's built is clean and correctly wired — not a functional or visual defect.

**UI risks**: Settings' single-card layout is the one page most likely to read as "unfinished" to a cold
stakeholder review. Thin demo data (1 appointment) makes several flagship panels look sparser than their
actual design intent across Command Centre/Front Desk/Appointments/Doctor Home simultaneously — a reviewer
unfamiliar with the seed could mistake this for a layout problem rather than a data-volume artifact. My
Work's simultaneous-red-rows pattern will only get more diluted as more tasks go overdue, since there's no
intermediate severity tier.

**UI test gaps (unverifiable from a static screenshot)**: the dev-login dropdown's expanded contents;
global search's populated/loading/no-results states; Inbox's patient-context side panel's open state; table
pagination/scroll behavior beyond visible rows; toast/inline error states; drawer field-validation-error
styling.

**UI top priorities**: (1) Settings needs either more sections or an explicit "more settings coming soon"
treatment so it stops reading as broken. (2) My Work needs a secondary overdue-severity tier (e.g. full red
tint only past some longer threshold, a lighter treatment for just-overdue) so the red signal stays
meaningful. (3) Add Patient/New Appointment drawers should either tighten to their content height or gain a
lightweight secondary element. (4) Give Leads' "Normal" priority a neutral-tone badge instead of plain text
for visual consistency with the Status column. (5, low urgency) Route the two hand-rolled button instances
through the shared `Button` primitive.

## RESPONSIVE AUDIT

Compared each critical route's captures across 1440/1280/1024/768/390, all findings source-confirmed (not
guessed from pixels alone).

**Clean at every breakpoint**: Login, Front Desk, My Work, Inbox (390 collapses to list-only single pane, a
reasonable mobile pattern), Integrations (390 correctly drops the detail pane), Appointments, Doctor Home.
Tables on Leads/Patients/Journeys/Campaigns/Campaign Detail/Treatments all use an intentional
horizontal-scroll container (`Card overflow-x-auto` + `Table min-w-[...]`, confirmed in source for each) —
data isn't lost at narrow widths, just no visible scroll-affordance cue (minor, shared nit across all of
them, not 5 separate bugs).

**3 real, source-confirmed responsive bugs found**:
1. **Patient 360 at 1024px** — the built-in Journeys panel's label/value rows (`apps/web/app/(app)/patients/[patientId]/page.tsx:84-98`) run together with no gap ("Next appointment26 Sept, 09:00 am"), because these `flex justify-between` dt/dd rows have no `gap`, unlike the custom-fields row one line below (`:104`) which already has `gap-3`.
2. **Patient 360 at 390px** — the Timeline category filter row (`packages/ui/src/Timeline.tsx:71`) has no `flex-wrap`/`overflow-x-auto`, so "Tasks" clips to "Task" at the card edge.
3. **Settings at 390px** — the custom-field-count label (`apps/web/app/(app)/settings/page.tsx:289-298`) has no `whitespace-nowrap`, so on a row with enough fields it wraps and visually collides with the Disable button ("custoDisable").

**Command Centre at 390** — cosmetic-only topbar title truncation ("Command…"), everything else (KPI grid,
donut) reflows correctly. Campaigns at 1024 initially looked like merging KPI values but a zoomed check
confirmed all 6 divider lines are genuinely present — dense, not broken.

## ACCESSIBILITY

Evidence is from source (keyboard/focus/ARIA behavior cannot be proven from a screenshot), cross-referenced
against the 2 existing focus-management/search E2E specs to establish what's already proven vs. what isn't.

- **Escape-to-close on drawers**: VERIFIED BUILT, all 5 (each of the 4 creation drawers has its own bare
  listener; `AppointmentDrawer` goes through the shared hook).
- **Focus trap + focus-return-to-trigger**: **PARTIAL — a real, evidenced gap.** A shared, well-built hook
  (`packages/ui/src/useDialogFocus.ts`) already exists and correctly handles focus-in, Tab-trapping,
  Escape, and focus-restore-on-close — but it's adopted in only 3 of the 6+ modal surfaces
  (`AppointmentDrawer`, `ConfirmDialog`, the Inbox patient-context drawer), each covered by
  `drawer-focus-management.spec.ts`. **The 4 highest-frequency data-entry drawers — Add Lead, Add Patient,
  Add Task, New Appointment — only wire a bare Escape listener, with no Tab-trap and no focus-return.** A
  keyboard-only front-desk/coordinator user can Tab out of any of these into the dimmed page behind the
  modal, with no way back except clicking. This is a real, correctly-scoped fix (retrofit the existing hook
  — mechanical, low-risk, not a new pattern to design) rather than a hypothetical concern.
- **Sidebar mobile off-canvas nav**: MISSING — has a click-to-close backdrop but zero keyboard handling at
  all (grep-confirmed no `keydown`/`useEffect` anywhere in `Sidebar.tsx`): no Escape, no focus trap, no
  focus-return when the hamburger-triggered panel closes.
- **Global search keyboard nav**: VERIFIED BUILT and genuinely solid (`role="combobox"`, `aria-expanded`,
  `role="listbox"`/`"option"`, full Arrow/Enter/Escape handling, covered by its own E2E spec) — but the
  entire search box is `hidden` below the `sm` breakpoint with no confirmed mobile replacement, removing the
  fastest patient-lookup path on any phone-width device.
- **QuickCreateMenu / My Work tabs**: PARTIAL — correct ARIA roles/states present, but neither has
  arrow-key movement between items (menu items/tabs are still independently Tab-reachable and
  Enter/Space-activatable, just short of the full native pattern).
- **ARIA/labels generally**: VERIFIED BUILT and consistent everywhere checked — `role="dialog"`+`aria-modal`+
  `aria-label` on all 5 drawers, every icon-only control labelled, every form input correctly paired via
  `htmlFor`/`id`, zero bare `<img>` usage (avatars are text-initial circles; the one real `<svg>` chart has
  `role="img"`+`aria-label`+per-segment `<title>`).
- **Color-only status signaling**: VERIFIED BUILT, **zero violations found** — every tone map in
  `packages/ui/src/status.ts` is paired with a label map, and `Badge` always renders the label text inside
  the colored pill; confirmed visually too (My Work's red rows always carry "3d overdue"/"Missed
  follow-up" text, Campaigns' red Spend-at-Risk bars always carry a reason + amount).
- **`prefers-reduced-motion`**: PARTIAL/MISSING — no global media-query rule exists anywhere (checked
  `globals.css` and the design-tokens package in full); instead there's a blanket unconditional
  `* { transition-duration: 120ms; }`. Tailwind's `motion-reduce:` variant is used in only 3 places, all
  sharing the `useDialogFocus` lineage — the same 4 creation drawers missing focus-trap also have no
  reduced-motion guard on their own transitions. Severity is mitigated by the transitions being short
  (120-200ms) opacity/transform fades, not large motion, but handling is inconsistent, not centralized.

**Responsive+accessibility risk worth flagging together**: the two responsive bugs and the focus-trap gap
share a root-cause shape — a working, shared solution exists (the `gap-3` pattern already used correctly one
line away; the `useDialogFocus` hook already proven in 3 other places) but wasn't consistently applied
everywhere it should have been. `AppointmentDrawer.tsx:96-98` uses the same unprotected `flex
justify-between` pattern as the Patient 360 bug and simply hasn't hit it yet because its content happens to
be short — a plausible latent repeat, flagged proactively.

**Test gaps**: `command-centre-responsive.spec.ts`'s `scrollWidth > clientWidth` overflow-assertion technique
is strong and already proven at 1024px, but wired to Command Centre only — Patient 360, Settings, and
Campaigns have no equivalent assertion-based test, which is exactly how these 3 bugs went uncaught.
`drawer-focus-management.spec.ts` covers only the 2 hook-adopting surfaces it was written for; no equivalent
spec exists for the 4 creation drawers (the test gap and the code gap line up exactly). No test covers the
Sidebar mobile drawer's keyboard behavior at all, or global search's sub-640px state.

## FRONTEND/BACKEND PARITY

| Feature | Backend | Frontend | Tests | E2E | Status |
|---|---|---|---|---|---|
| Patient≠Journey, multi-journey | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Identity resolution (phone norm + reuse) | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Source attribution immutability | VERIFIED | VERIFIED | PARTIAL | NOT BUILT | PARTIAL |
| CommunicationEndpoint (multi-line) | VERIFIED | VERIFIED | VERIFIED | VERIFIED | PARTIAL (dormant, no seed data) |
| Runo call read path | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Runo click-to-call | EXTERNAL BLOCKER | NOT BUILT | — | — | EXTERNAL BLOCKER |
| WhatsApp inbound/outbound | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| WhatsApp→Journey link | NOT CONNECTED | VERIFIED (reads it) | NOT BUILT | NOT BUILT | NOT CONNECTED |
| WhatsApp delivery status | VERIFIED (write) | NOT BUILT (no read) | PARTIAL | NOT BUILT | NOT CONNECTED |
| WhatsApp media | NOT BUILT | NOT BUILT | — | — | NOT BUILT |
| Telecaller reason pills | VERIFIED | VERIFIED | NOT BUILT | VERIFIED | PARTIAL (empty for new_lead) |
| Click-to-call/WhatsApp in My Work | — | NOT BUILT | — | — | NOT BUILT |
| Task outcome capture | PARTIAL (note only) | PARTIAL | PARTIAL | NOT BUILT | PARTIAL |
| `GET /tasks` scoping | NOT BUILT (security gap) | N/A | NOT BUILT | NOT BUILT | **RISK** |
| Appointment transition graph | VERIFIED (mostly) | VERIFIED | VERIFIED | VERIFIED | PARTIAL (reschedule gap) |
| Treatment transition graph | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Revenue events (real) | NOT BUILT | VERIFIED (reads seed data) | NOT BUILT | NOT BUILT | **NOT BUILT** |
| CCS/IVRSMS (any capability) | NOT BUILT | NOT BUILT | NOT BUILT | NOT BUILT | EXTERNAL BLOCKER |
| Webhook retry/reconciliation | NOT BUILT | — | NOT BUILT | NOT BUILT | NOT BUILT |
| Endpoint Config admin UI | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |

## SECURITY / PRIVACY

- **Confirmed live, high-severity**: `GET /tasks` org-wide task/notes enumeration by any `VIEW_TASKS` role
  (see Tasks section) — 3 independent live reproductions.
- Tenant isolation: sampled 5 representative mutation routes, all correctly derive `tenantId` from session,
  never from request body — no violation found in the sample.
- Secrets: connector secrets confirmed never leaked via any reading route (explicit test assertions plus
  independent agent spot-check).
- Recording links: permanent, unsigned, auth-gated-by-normal-session-only — documented, unchanged limitation.
- Minor defense-in-depth gap: `findOrCreateConversation`'s SELECT doesn't independently filter by
  `tenantId` (relies on `connectorId` already being tenant-unique) — not practically exploitable, flagged
  for consistency only.
- No new tenant-isolation violation found beyond what the 2026-09-22 docs already knew about.

## CODE QUALITY

- 3 confirmed dead UI components, zero importers anywhere (verified by grep, not guessed):
  `packages/ui/src/SpendAtRiskPanel.tsx` (superseded by `SpendAtRisk.tsx`, which is the one actually wired
  into Command Centre), `packages/ui/src/ExecutiveStripSection.tsx` (superseded by `KpiStrip.tsx`'s
  `KpiStripSection`), `packages/ui/src/OutcomeActionList.tsx`.
- 2 oversized files that grew during the most recent omnichannel work session and are worth splitting before
  more logic accretes: `apps/web/app/(app)/inbox/page.tsx` (647 lines), `apps/web/app/(app)/integrations/page.tsx`
  (492 lines) — no other `.tsx` file in the repo exceeds ~320 lines, so these two are genuine outliers, not a
  repo-wide pattern. `packages/ui/src/AddLeadDrawer.tsx` (506 lines, pre-existing) is the third outlier.
- No duplicated formatters, status/label maps, or permission-check reimplementations found anywhere (all
  correctly route through the single shared source — `packages/ui/src/format.ts`, `status.ts`,
  `packages/types`' `hasPermission`).
- No unnecessary data-fetching `useEffect`, no unnecessary `"use client"` directives, no material duplicated
  responsive-Tailwind blocks found.
- 3 genuine N+1 query patterns confirmed by reading the actual loop bodies (not speculated): `getPatient360`
  (per-journey, low severity — bounded by a patient's own journey count), `getSourcePerformance` (per-campaign,
  more meaningful — scales with real campaign volume), `getSpendAtRisk` (bounded by a constant, low severity).
- `connectorDispositionMappings`/`connectorConfigAuditEvents`: fully dead schema, zero consumers — flagged as
  a **reseed landmine**: if either table ever gets a writer without a matching `seed.ts` teardown entry added
  in the same change, the very next reseed will hit an FK violation.

## REGRESSIONS FOUND

**Zero regressions against the 2026-09-22 audit docs' specific, checkable claims** — every fix that doc
described (the 3 Opus-review bugs, the permission split, the migrations, the dead-table observations) was
independently re-verified today, by multiple agents working separately, and matches exactly.

Two genuine **test-file regressions** found (not product bugs — these will break `pnpm test` on a second
consecutive run without a reseed, a previously-diagnosed recurring category for this project):
- `apps/api/src/__tests__/communication-endpoints.integration.test.ts:83,97` — fixed `providerRef` literals
  (`"main-reception-line"`, `"phone-number-id-fertility"`) in the one test in that file that doesn't follow
  the file's own established `Date.now()`-suffix convention.
- `apps/api/src/__tests__/runo-webhook.integration.test.ts:196,221` — same bug, same pattern
  (`"runo-sole-line"`, `"runo-second-line"`).
- Related, different mechanism: `apps/api/src/__tests__/inbox.integration.test.ts:60-141` permanently
  consumes both of the only 2 seeded `HUMAN_REQUIRED` conversations across its first 2 tests — will
  `TypeError` on a second consecutive run once the pool is empty, rather than 409.

One genuine **product bug** newly found this pass (see Test Baseline for full root-cause detail): a real
React effect-timing race in the shared Quick Create drawer reset pattern, reproduced via
`crm-critical-flows.spec.ts` FLOW 2, affecting all 4 drawers (Lead/Patient/Task/Appointment) structurally,
though only empirically observed for Add Lead today.

## TEST GAPS

- Systemic: every "(tenant isolation)" — named test in the suite can only prove "unknown id → 404," never
  genuine cross-tenant exclusion, because the seed only ever creates one tenant. Applies repo-wide, not to
  one test file.
- No test covers `GET /tasks`' org-wide enumeration — neither guarding against it nor documenting it as
  known-risky-but-intentional.
- No test covers `rescheduleAppointment`'s missing status guard (new finding, either direction).
- No test asserts `conversations.journeyId` is ever non-null, or that a WhatsApp Timeline event's journeyId
  matches the patient's active journey.
- No test asserts `getPatient360`'s journey list correctly excludes (or documents inclusion of) `lost`
  journeys.
- No test covers `updateTreatmentStatus("COMPLETED")` creating (or knowingly not creating) a `revenueEvents`
  row.
- No test locks in "the New Enquiries pill is currently always empty" as expected-but-undesirable, so it can
  silently persist across future changes without anyone noticing it's still broken.
- No test exercises Exotel/Superfone (nothing to test — unwired).
- No Playwright coverage of the Add Lead drawer reopen-and-refill race found this pass.

## PROVIDER HONESTY MATRIX

| Provider | Mode | Proven Capability | Missing/Blocked |
|---|---|---|---|
| Runo | Fixture (real webhook shape, verified against live API docs previously) | Receive call event, receive recording URL, disposition mapping, missed-call task | Click-to-call, real-time polling, recording fetch (architecturally absent from their API) |
| WhatsApp Cloud API | Fixture (real webhook shape, verified against live Meta docs previously) | Inbound/outbound text messages, endpoint resolution both directions, delivery-status write | Coexistence, history import, message echoes (need real Meta Solution-Partner account), media, delivery-status read |
| Meta Lead Ads | Fixture | Webhook receive, signature verification | — |
| Google Ads Lead Forms | Fixture | Webhook receive, key verification | — |
| Google Business Profile | Fixture | Sync-based performance ingestion | — |
| Website Form | Live (first-party, not a 3rd-party adapter) | Full ingestion | — |
| Exotel | NOT_CONFIGURED | None — connector row only | No adapter, no webhook route at all |
| Superfone | NOT_CONFIGURED | None — connector row only | No adapter, no webhook route at all |
| CCS/IVRSMS | Unknown | None — zero codebase integration | Everything — auth-walled portal, no credentials available |

## PILOT READINESS MATRIX

| Area | Grade | Why |
|---|---|---|
| Patient identity | A | Solid, live-proven, single unified mechanism |
| Journeys | A | Multi-journey real; one cosmetic labeling bug (`lost` count) |
| Leads | B | Solid intake; source attribution structurally correct |
| Tasks | C | Architecture solid, but `GET /tasks` is a real live access-control gap |
| Follow-ups | C | Same Task architecture; new_lead/missed-call tasks structurally invisible to any user |
| Appointments | B | Graph solid except one new, real gap (`rescheduleAppointment`) |
| Treatments | B | Graph fully solid; the chain it feeds (Revenue) is not |
| Telecaller | C | Real reason pills, but no contact affordance, no filters, empty flagship pill |
| Calls | B | Real read path; fetched-but-unrendered fields; dormant without seed data |
| Missed calls | C | Task created correctly, but same unassigned-invisibility issue as new_lead |
| WhatsApp | B | Real bidirectional flow; journey-linking gap breaks per-journey Timeline view |
| Patient 360 | B | Strong; one labeling bug, Calls card under-renders available fields |
| Inbox | B | Real full lifecycle; delivery status write-only |
| Campaigns | A− | Dense, well-organized, correct warning-color usage; graded A− in UI Audit |
| Attribution | D | Source/channel/provider/endpoint all correct; Revenue itself has zero real write path |
| CCS | E | Zero integration, fully external-blocked |
| Runo | B | Real, honest about its own limits |
| Communication endpoints | C | Fully built, correct, but dormant — zero seed data, so unobservable out of the box |
| Responsive | B | 3 precise, small, source-located bugs (Patient 360 ×2, Settings ×1); everything else clean across 5 breakpoints |
| Accessibility | C | Solid ARIA/color-signal foundation and a good shared focus-trap hook — but that hook covers only 3 of 6+ modals, leaving the 4 highest-frequency data-entry drawers keyboard-trap-free |
| Security | C | One live, reproduced, PHI-adjacent leak (`GET /tasks`); everything else sampled clean |
| Testing | B | 271/40 + 57/58 green; real, precisely-located gaps found and documented, not hidden |

---

## TODAY'S 5-HOUR IMPLEMENTATION ORDER

Scoped tightly to the master prompt's own explicit stated priority: *External call/event →
CommunicationEndpoint → Patient → Journey → Conversation/Timeline → Follow-up/Next Action → telecaller
visibility*, plus one orthogonal security item that can't wait regardless of feature priority. **Revenue's
write-path gap is the single most severe finding in this whole audit** (see Executive Summary) but is
deliberately placed at P1, not P0, because the master prompt's own priority chain above doesn't include it —
flagging this explicitly so the decision to defer it is visible and overridable, not silently made.

### P0 — must finish today

**P0.1 — Fix `GET /tasks` org-wide enumeration**
- GOAL: `GET /tasks` defaults to the caller's own assignment unless the caller holds `MANAGE_TASKS` (or a
  new, explicit "view org tasks" capability) — matching the pattern `getTaskCounts` already uses correctly.
- WHY: live, reproduced, PHI-adjacent leak — any `VIEW_TASKS` role (including Doctor) can read every other
  staff member's free-text task notes tenant-wide today, confirmed independently by 3 agents.
- DEPENDENCIES: none.
- BACKEND WORK: `apps/api/src/domain/task/task.service.ts`'s `listTasks` — when the caller lacks
  `MANAGE_TASKS`, force `assignedTo := callerId` regardless of the query param. `task.routes.ts` passes the
  caller's own id/permission through (already has both via `request.sessionUser`).
- FRONTEND WORK: none required — My Work already only ever requests its own scope; no UI relies on the
  broad behavior.
- RESPONSIVE WORK: none.
- TESTS: failing test first — a `doctor@pulseos.local` `GET /tasks?assignedTo=<another-user>` and a
  parameterless `GET /tasks` must both return only the doctor's own tasks; an `admin`/coordinator with
  `MANAGE_TASKS` must still be able to see org-wide/other-assignee results explicitly requested.
- AGENT OWNERSHIP: single-owner (one small, security-sensitive file) — do not parallelize.
- FILES: `apps/api/src/domain/task/task.service.ts`, `apps/api/src/__tests__/` (new or extended test file).
- ACCEPTANCE CRITERIA: doctor account can no longer see coordinator's/front-desk's task notes via any `GET
  /tasks` call; My Work's own existing behavior for every role is unchanged; full API suite still green.
- PROVIDER BLOCKER: none.

**P0.2 — Wire `conversations.journeyId` at write time (WhatsApp → Journey link)**
- GOAL: every new WhatsApp conversation gets a real `journeyId`, resolved the same way calls already do,
  so WhatsApp messages appear in Patient 360's per-journey-filtered Timeline.
- WHY: this is the exact "Conversation/Timeline" link in the master prompt's own stated priority chain, and
  it's currently silently broken for every WhatsApp message, for every patient, always — directly
  undermines the north-star "multiple concurrent journeys" scenario the whole product is built around.
- DEPENDENCIES: none (the pattern to reuse, `findMostRecentActiveJourney`, already exists and is already
  proven correct for calls).
- BACKEND WORK: `apps/api/src/domain/connector/whatsapp-webhook.service.ts`'s `findOrCreateConversation` —
  resolve `journeyId` via the same `findMostRecentActiveJourney` call `call-webhook.service.ts` already
  makes, stamp it on the conversation INSERT. Decide and implement whether an existing conversation's
  `journeyId` should ever be updated on a later message (likely: only backfill if currently null, to avoid
  fighting a `JOURNEY_LINK_REQUIRED`-style future feature). Also replace `getConversationDetail`'s own
  separate, inconsistent lazy-journey-lookup fallback (`conversation.service.ts`) with the persisted column
  once it's reliably set.
- FRONTEND WORK: none required — the per-journey Timeline filter already reads `journeyId` correctly; it
  will simply start working once the backend stamps it.
- RESPONSIVE WORK: none.
- TESTS: failing test first — fire a real WhatsApp webhook for a patient with an active journey, assert
  the created conversation's `journeyId` matches, assert the resulting Timeline event is visible under that
  journey's filtered view (not just "All").
- AGENT OWNERSHIP: single-owner (shared webhook file, avoid touching while P0.4's seed changes are also
  landing in the same session).
- FILES: `apps/api/src/domain/connector/whatsapp-webhook.service.ts`, `apps/api/src/domain/conversation/conversation.service.ts`.
- ACCEPTANCE CRITERIA: a fresh WhatsApp message to a patient with one active journey shows up when that
  journey (not "All") is selected on Patient 360; existing tests (whatsapp-webhook, inbox) still green.
- PROVIDER BLOCKER: none.

**P0.3 — Give auto-generated tasks (new_lead, no-journey missed-call) real visibility**
- GOAL: a `new_lead` or ownerless missed-call task is visible to SOMEONE — either a default-assignment
  policy (e.g. a branch's default coordinator / round-robin) or a "Team Queue" view in My Work that doesn't
  filter by the current viewer.
- WHY: this is the literal final step of the master prompt's own priority chain — "telecaller visibility" —
  and it's currently a hard dead end: 8/8 real `new_lead` tasks were unassigned in a live check, and every
  My Work tab (all 5) always filters by the current viewer's own id, so this category of work is invisible
  to every individual user today. The flagship "New Enquiries" pill built earlier this week can never show
  anything for any real user without this.
- DEPENDENCIES: none functionally, but this is a real product-policy decision (who owns an unassigned
  enquiry?) — recommend the simpler, safer option for a 5-hour slice: add an "Unassigned"/"Team Queue" tab
  to My Work (org-wide, gated by an existing broad permission like `MANAGE_TASKS`) rather than inventing an
  auto-assignment/round-robin algorithm, which is a bigger, riskier decision to make unilaterally today.
- BACKEND WORK: extend `task.service.ts`'s `listTasks`/`TaskFilters` with an explicit "unassigned" filter
  (`assignedTo IS NULL`), gated the same way P0.1 gates org-wide visibility (`MANAGE_TASKS` or equivalent) so
  this doesn't reopen the P0.1 leak.
- FRONTEND WORK: a new tab/pill in `apps/web/app/(app)/my-work/page.tsx` for "Unassigned" alongside the
  existing date tabs and reason pills, visible only to roles with the gating permission; a way to claim/
  self-assign a task from that view (reuse the existing `reassignTask` mutation).
- RESPONSIVE WORK: match the existing tab/pill row's established mobile wrapping behavior — no new pattern.
- TESTS: a `new_lead` task with `assignedTo: null` must appear in the Unassigned view for a permitted role
  and NOT appear in any other role's personal My Work tabs (unchanged); claiming it assigns and moves it.
- AGENT OWNERSHIP: two files, low collision risk with P0.1/P0.2 (different domain) — could run in parallel
  with P0.4, not with P0.1 (both touch `task.service.ts`'s `TaskFilters`; sequence P0.1 first, quick).
- FILES: `apps/api/src/domain/task/task.service.ts`, `task.routes.ts`, `apps/web/app/(app)/my-work/page.tsx`.
- ACCEPTANCE CRITERIA: a freshly-ingested website-form/Meta lead's task is visible somewhere in the product
  without needing to know its raw UUID; a coordinator can claim it from that view.
- PROVIDER BLOCKER: none.

**P0.4 — Seed realistic CommunicationEndpoint + Calls demo data**
- GOAL: `pnpm db:seed` produces at least 2 real `communicationEndpoints` (one Runo phone line, one WhatsApp
  line) and a handful of realistic `calls` rows linked to real seeded patients, so the multi-line/endpoint-
  label feature is visible out of the box instead of requiring manual curl/UI setup every time.
- WHY: the entire CommunicationEndpoint feature (schema, resolution, UI) is real, tested, and currently
  100% invisible in a fresh demo — 2 agents independently flagged this as their #1 priority, and it directly
  blocks anyone (including the user) from seeing this week's work without knowing to fire webhooks first.
- DEPENDENCIES: none.
- BACKEND WORK: extend `apps/api/src/seed/seed.ts` — insert 2-3 `communicationEndpoints` rows (after
  connectors/branches are seeded, matching the existing FK-safe ordering already audited as correct by
  Agent G), and a handful of `calls` rows with `communicationEndpointId` set, realistic timestamps, and
  varied status (completed/missed) so the Missed Calls pill also has real data.
- FRONTEND WORK: none required.
- RESPONSIVE WORK: none.
- TESTS: no new test required (seed data isn't unit-tested elsewhere in this codebase), but re-run the full
  suite after the seed change to confirm nothing assumes today's zero-calls/zero-endpoints baseline.
- AGENT OWNERSHIP: single-owner (`seed.ts` is one file everyone else's tests implicitly depend on — do not
  parallelize with anything else touching seed.ts).
- FILES: `apps/api/src/seed/seed.ts`.
- ACCEPTANCE CRITERIA: a fresh `pnpm db:seed` followed by opening Patient 360 for a seeded patient with a
  call shows a real Calls card with an endpoint label; Inbox's "All lines" filter renders (not hidden).
- PROVIDER BLOCKER: none.

### P1 — next if P0 finishes

1. **Wire a real (estimated-value-based) `revenueEvents` write on treatment completion.** The single most
   severe finding in this audit, deliberately P1 per the reasoning above. Smallest correct slice: insert a
   `revenueEvents` row from `treatment.service.ts`'s existing `COMPLETED` branch using
   `treatmentOpportunities.estimatedValue` (already read on the same row), clearly typed/labeled as
   estimated (not payment-reconciled) revenue — a real invoicing/payment-reconciliation system is
   deliberately out of scope for a 5-hour slice. FILES: `apps/api/src/domain/treatment/treatment.service.ts`.
2. **Add a status guard to `rescheduleAppointment`**, matching `VALID_FROM_STATUSES`/the frontend's own
   `CAN_RESCHEDULE` set — the only appointment mutation with zero server-side transition enforcement today.
   FILES: `apps/api/src/domain/appointment/appointment.service.ts`.
3. **Add click-to-call / click-to-WhatsApp deep links (`tel:`/`wa.me`) in My Work** — needs no provider API,
   directly closes the single biggest daily-workflow gap Agent C found. FILES:
   `apps/web/app/(app)/my-work/page.tsx`.
4. **Surface WhatsApp delivery status in the Inbox thread** — data already exists end-to-end on the write
   side; add it to the Message VM and a small tick-mark UI treatment. FILES: `packages/types/src/index.ts`,
   `apps/api/src/domain/conversation/conversation.service.ts`, `apps/web/app/(app)/inbox/page.tsx`.
5. **Fix the 2 confirmed test-file regressions** (fixed `providerRef` literals in
   `communication-endpoints.integration.test.ts:83,97` and `runo-webhook.integration.test.ts:196,221`) plus
   `inbox.integration.test.ts`'s seeded-row-exhaustion fragility — small, precisely-located, prevents this
   project's own previously-diagnosed recurring test-flake class from recurring again.
6. **Fix `getPatient360`'s "N active journeys" to exclude `lost` journeys**, matching the Patients list's
   existing, correct convention.
7. **Investigate the Add Lead drawer reopen-and-refill race** found in today's Playwright baseline — reproduce
   deliberately (not just via the flaky-looking E2E symptom), confirm the effect-timing hypothesis, and fix
   the shared reset pattern across all 4 Quick Create drawers if confirmed.
8. **Retrofit `useDialogFocus` onto the 4 creation drawers** (Add Lead, Add Patient, Add Task, New
   Appointment) — the hook already exists, is already proven in 3 other modals, and this closes the
   largest accessibility gap found: today, a keyboard-only user can Tab out of the highest-frequency
   data-entry flows into the dimmed page behind the modal. Mechanical, low-risk (adopting an existing
   pattern, not designing a new one). Add matching specs alongside `drawer-focus-management.spec.ts`.
9. **Fix the 3 source-located responsive bugs** found this pass: `patients/[patientId]/page.tsx:84-98`
   (missing `gap` on the Journeys panel's label/value rows, breaks at 1024px), `Timeline.tsx:71` (missing
   `flex-wrap` on the category filter row, clips at 390px), `settings/page.tsx:289-298` (missing
   `whitespace-nowrap` on the field-count label, collides with the Disable button at 390px). All three are
   1-line CSS-class fixes with a known, precise location — no investigation needed, just apply and verify.

### P2 — defer safely

CCS adapter implementation (blocked — no credentials; the only same-day-actionable CCS work is documenting
the exact adapter contract it will need, using `adapters/runo.ts` as the template, so it's ready to wire the
moment credentials arrive) · WhatsApp media support · structured task-outcome/disposition capture beyond a
free-text note · branch/specialty/source/owner filters in My Work · N+1 query batching
(`getSourcePerformance`, `getPatient360`, `getSpendAtRisk` — all confirmed real but low/moderate severity,
not urgent) · deleting the 3 confirmed-dead UI components (`SpendAtRiskPanel.tsx`, `ExecutiveStripSection.tsx`,
`OutcomeActionList.tsx`) · splitting the 3 oversized files (`inbox/page.tsx`, `integrations/page.tsx`,
`AddLeadDrawer.tsx`) · a second-tenant fixture for genuine cross-tenant test coverage · Calls card rendering
`provider`/`phone`/`journeyId` · adding the 6 missing eventTypes to Timeline's category map / an "Other"
Timeline filter button · Exotel/Superfone adapters (no stated business need surfaced this pass) · webhook
retry/reconciliation (real gap, but a bigger design decision than a 5-hour slice).

## IMPLEMENT PROMPT INPUT

**1. Verified starting state**: WEB `:3310` / API `:4310`, both confirmed live and healthy from the
canonical worktree; DB freshly reseeded; full baseline green (271/271 API tests, 57/58 Playwright — the one
failure is a real, root-caused product bug in the Quick Create drawer reset pattern, see P1.7, not a
baseline blocker); `git` still blocked (Xcode license — user action required, outside this session's reach).
Zero regressions against the 2026-09-22 audit doc's specific claims. Three headline gaps: `GET /tasks`
org-wide leak, `conversations.journeyId` never set, `revenueEvents` has zero production write path.

**2. P0 tasks in dependency order**: P0.1 (`GET /tasks` fix) has no dependencies, do first or in parallel.
P0.2 (`conversations.journeyId`) has no dependencies. P0.3 (task visibility) should sequence its
`task.service.ts` `TaskFilters` change after P0.1's own edit to the same file lands, to avoid a merge
collision — everything else in P0.3 (the new My Work tab) can proceed in parallel. P0.4 (seed data) is
fully independent of P0.1-P0.3 but should run AFTER P0.2 if possible, so seeded calls/conversations can
exercise the newly-fixed journey-linking path rather than needing a second seed-data pass later.

**3. Safe parallel-agent groups**: {P0.1} and {P0.2} and {P0.4} can run as 3 truly parallel agents (disjoint
files: `task.service.ts` for P0.1, `whatsapp-webhook.service.ts`+`conversation.service.ts` for P0.2,
`seed.ts` for P0.4). P0.3's backend half must wait for P0.1 to land in `task.service.ts` first (same file,
real collision risk); P0.3's frontend half (`my-work/page.tsx`) can start immediately in parallel with
everything else. Do not parallelize P1 items against P0 items that touch the same file (P1.1 `treatment.
service.ts` is fully independent; P1.2 `appointment.service.ts` is fully independent; P1.3 `my-work/page.tsx`
collides with P0.3's frontend half — sequence P0.3 first).

**4. Shared files that must remain single-owner** (per this session's own established, working pattern for
avoiding agent collisions): `apps/api/src/domain/task/task.service.ts` (P0.1 then P0.3), `apps/api/src/seed/seed.ts`
(P0.4 alone), `packages/types/src/index.ts` (touched only by P1.4 this round — keep single-owner if any other
task also needs it), `apps/web/app/(app)/my-work/page.tsx` (P0.3 then P1.3, sequence not parallelize).

**5. Exact acceptance tests**:
- P0.1: `curl` as `doctor@pulseos.local` (no `MANAGE_TASKS`) to `GET /tasks` and `GET /tasks?assignedTo=<other-user-id>` — both must return only the doctor's own tasks.
- P0.2: fire a real WhatsApp webhook for a patient with an active journey; `GET /patients/:id/timeline?journeyId=<id>` must include the new `whatsapp_message` event.
- P0.3: an unassigned `new_lead` task must appear in the new Unassigned/Team Queue view for a `MANAGE_TASKS` role and nowhere in a personal My Work view; claiming it must reassign it.
- P0.4: fresh `pnpm db:seed` → `GET /communication-endpoints` returns ≥2 rows; `GET /patients/:id/360` for a seeded patient with a call returns a non-empty `calls` array with a non-null `endpointLabel`.

**6. Provider blockers**: CCS/IVRSMS — fully blocked, no credentials available in this environment; portal
requires email/password + mobile OTP + security question, none of which exist here. Runo click-to-call /
real-time polling / recording fetch — architecturally absent from Runo's real public API, confirmed against
their live OpenAPI spec in a prior session. WhatsApp Coexistence / history import / message echoes — require
a real Meta Solution-Partner account, not fixture-buildable.

---

*All 7 agents (A–G) reported and are synthesized above. Screenshots referenced throughout this document are
at `review-artifacts/2026-09-28-central-platform-audit/`. Both dev servers (web :3310, API :4310) remain
running from the canonical worktree, confirmed live immediately before this document was finalized. Git
remains blocked — see Canonical Runtime.*
