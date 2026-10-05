# PulseOS Greenfield Foundation Design

- **Status**: Architecture reset — supersedes `2026-09-12-pulseos-foundation-design.md` and the Task 16–20 continuation plan.
- **Date**: 2026-09-12
- **Decision**: PulseOS is a **new, clean platform**. `invictus-chatbot`, `whatnexus-frontend`, and the Lead Panel (`backend`/`frontend`) are **reference/module sources only** — not the product foundation. No old application is copied wholesale. Old worktrees (Tasks 5–15) are untouched, kept as reference, not deleted.
- **Product**: India-first Patient Engagement CRM and Hospital Operations Command Centre. Not a full EMR/HIS.

---

## 1. Greenfield Architecture

```
apps/
  web/      — new frontend (framework TBD at implementation start: Next.js, role-based shell)
  api/      — new backend (Node/TypeScript, REST), clean domain model from §4
  mobile/   — not built yet (post-prototype)

packages/
  ui/               — new design system (tokens, primitives, charts, data-grid, drawer, timeline)
  types/            — shared API contract types
  validation/       — shared zod/schema validation
  api-client/       — typed client used by web (and later mobile)
  design-tokens/    — color/spacing/type scale (see §18)
```

Every existing repo (`backend`, `frontend`, `whatnexus-frontend`, `whatnexus-frontend-pulseos-work`, `invictus-chatbot`, `invictus-chatbot-pulseos-work`) stays where it is, untouched, and is read from — never imported via `git subtree`, never merged, never used as the monorepo's starting point. `apps/web` and `apps/api` start empty and grow from the domain model in this spec, not from a copied route tree or table set.

**Why this reset**: the prior spec (`2026-09-12-pulseos-foundation-design.md`) treated `invictus-chatbot`/`whatnexus-frontend` as the production base to extend in place. That inherits legacy naming (`leads` table, "Lead" vocabulary), legacy navigation, a WhatsApp-support-tool visual language, and schema decisions (JSON custom fields bolted onto a chat-support table) made for a different product. This is now an explicit product decision to not do that — PulseOS earns its own schema, its own screens, its own design system, informed by but not constrained by the old code.

---

## 2. Old Code Status — Reference Only

| Repo | Status | Use |
|---|---|---|
| `invictus-chatbot` (+ `-pulseos-work`) | Reference only | Study WhatsApp Cloud API integration, RAG pipeline, appointment state machine, Redis/BullMQ patterns, tenant-secret encryption |
| `whatnexus-frontend` (+ `-pulseos-work`) | Reference only | Study shared-inbox UX, appointment drawers — not a UI base |
| `backend` (Lead Panel) | Reference only | Study custom-field engine, activity/timeline pattern, assignment/follow-up logic, audit/redaction pattern |
| `frontend` (Lead Panel) | Reference only | Study CRM table/filter UX, lead-detail drawer pattern |

None of these are deployed as PulseOS. None of their tables, routes, or components are imported directly into `apps/*`. They remain on disk, untouched, as a knowledge source.

---

## 3. Reuse / Extraction Policy

Three-step test before porting anything:

1. **Read it** — understand the actual mechanism, not just that it "exists."
2. **Extract the smallest useful unit** — a function, a state machine, a table shape, a security pattern. Never a whole module, never a whole page, never a whole table with its legacy columns.
3. **Adapt to PulseOS boundaries** — rename to PulseOS vocabulary, fit the domain model in §4, drop any legacy-tenant-specific gating (e.g., Lead Panel's `scopeSuperAdminToClient("birthwave")`), then write a test for it.

**Never port wholesale**: legacy navigation, legacy table names, legacy UI components as-is, legacy CORS/security config (WhatsNexus's `origin: true` is a known defect, not a pattern), the ~20 duplicated flat-table client verticals in Lead Panel, groq-sdk or other unused dependencies.

**Extraction candidates** (evaluate at implementation time, port only when a clean boundary exists):

From WhatsNexus (`invictus-chatbot`):
- WhatsApp Cloud API webhook handling → becomes `WhatsAppProvider` adapter (§16)
- RAG/knowledge retrieval (`embedding.js`, cosine search) → becomes `LLMProvider`-adjacent knowledge service
- Appointment state machine (`Advanced_Appointment_Booking.service.js`) → informs (not = ) PulseOS appointment booking flow
- Redis/BullMQ scheduling patterns → reused for follow-up/reminder scheduling
- Tenant-secret AES-256-GCM encryption → reused for connector credential storage

From Lead Panel (`backend`/`frontend`):
- Custom-field table shape and CRUD pattern → informs `CustomFieldDefinition`/`CustomFieldValue` (§4)
- Activity/timeline event catalog technique (open string `event_type`, not DB enum) → informs `Interaction`/timeline design
- Assignment/round-robin + follow-up task pattern → informs `Task`/`NextAction`
- Audit/redaction middleware pattern → reused for `AuditEvent` logging
- CRM table/filter UX (not code) → reference only for Patients/Journeys list design

---

## 4. Domain Model

Clean entities, not inherited tables. Evaluated and decided below.

```
Tenant                  — hospital/clinic group
Branch                  — physical location under a Tenant
User                    — staff login (reception, counsellor, doctor, admin)
Role / Permission        — coarse role + fine-grained permission grants
Patient                 — person (was "Contact" in the old spec)
PatientIdentity          — phone/WhatsApp id, linked-family relationship (guardian → dependent)
Journey                  — one engagement/concern for one Patient (see §9 for the Journey decision)
Interaction               — atomic event (message, call, note) — feeds the Timeline
Conversation / Message    — WhatsApp/other-channel thread and messages within it
Call                      — telephony event (inbound disposition, from a TelephonyProvider adapter)
Appointment                — scheduled/attended/no-show visit, tied to a Journey and Doctor
ConsultationOutcome        — outcome recorded after an Appointment
TreatmentOpportunity       — commercial next step after a ConsultationOutcome
Task / NextAction          — human-owned follow-up work, always has one obvious next action
CampaignTouchpoint         — source/campaign attribution event at Journey creation
RevenueEvent               — realized value tied to a TreatmentOpportunity
CustomFieldDefinition       — tenant-defined field (per entity_type)
CustomFieldValue            — value storage (JSON per entity row, or narrow table — decide at build time)
Pipeline / PipelineStage    — tenant-configurable stage set per Journey type
Consent                    — WhatsApp marketing / DPDP consent record
Connector                  — configured instance of a provider adapter (§16) per tenant
AuditEvent                  — security/audit log entry
```

This list is intentionally close to the old spec's §2 domain list — that part of the old spec was sound. What changes is that every entity above is a **new table in a new schema**, not a column bolted onto `LeadsTable`/`ContactsTable`/`AppointmentOutcomeTable`. No `journey_type` STRING added to a chat-support `leads` table; no `custom_fields JSON` retrofitted onto a table designed for something else.

---

## 5. Role / Permission Model

One application, permission-driven — not five separate apps.

**Roles (V1)**: `SUPER_ADMIN` (platform), `HOSPITAL_ADMIN`, `RECEPTION`, `COUNSELLOR`, `DOCTOR`.

**Model**: coarse `role` on `User` + a `Permission` grant table (`user_id`, `permission_key`) for fine-grained capability (`journey.reassign_any`, `appointment.manage_all_doctors`, `ai.silence_toggle`, `billing.view`). This avoids a role-enum migration every time a new job title appears — same technique validated in the old spec's §5, kept because it's sound regardless of which codebase it sits in.

Every screen, nav item, and dashboard widget reads role + permission to decide visibility — one codebase, role-adapted rendering, not a role-specific app.

---

## 6. Admin Command Centre

One screen, drill-down everywhere. Sections:

- **Today strip** (compact KPI row): new enquiries, uncontacted patients, follow-ups due, appointments today, waiting/checked-in, consultations completed, no-shows, treatment decisions pending. Each number clicks into the filtered list.
- **Conversion funnel**: enquiry → contacted → appointment booked → attended → consultation completed → treatment advised → treatment scheduled → treatment completed. Click a stage to see the patients in it.
- **Patient flow**: waiting / checked-in / with doctor / consultation complete / follow-up required — a live status board, clickable per bucket.
- **Attention / SLA queue**: overdue callbacks, missed follow-ups, no-shows, high-intent uncontacted enquiries, treatment-decision follow-ups — a ranked, clickable list, not a chart. This is the "what needs a human right now" surface.
- **Marketing/source panel**: volume, appointments, consultations, treatment conversion, revenue context, broken down by Meta / Google / Website / WhatsApp / Walk-in / Referral. Source distribution + trend line, each segment clickable into filtered patients.
- **Team panel**: receptionist/counsellor workload (open tasks, active journeys), outstanding tasks, activity — compact bars, clickable to that person's queue.
- **Branch/doctor panel**: branch performance, doctor appointment/consultation volume, waiting load — compact table, clickable to branch/doctor detail.

Every chart or card exists to answer "where do I act right now" and links to the filtered record set. No decorative charts.

---

## 7. Doctor Command Centre

A different home screen, not a filtered admin view. Doctor logs in and sees:

- Today's appointments (list, next patient highlighted)
- Waiting / checked-in patients right now
- Next patient card: name, journey context, why they're here, last relevant note
- Consultations awaiting outcome entry
- Treatment follow-ups and post-care patients assigned/relevant to them
- Callbacks/reviews due

Revenue and marketing data appear only where permission allows and only if operationally useful (e.g., a treatment-conversion note on their own patients) — never a marketing dashboard as the doctor's landing view.

---

## 8. Patient 360

Second flagship screen. Header (identity strip, always visible): name, preferred language, branch, all active Journeys, current stage, current owner, source, last interaction, next action, appointment, doctor, consultation outcome, treatment status, revenue context (if permitted).

Body: one chronological **Timeline** — WhatsApp, calls, notes, tasks, appointments, consultations, treatment events, post-care, AI/human ownership changes — interleaved across all of the patient's Journeys by default, filterable to one Journey.

Design goal: a team member never needs to ask "who is this," "what did we last discuss," or "what happens next" — all three are answered without navigating away from this screen.

---

## 9. Journey Architecture — Decision

**Compared**:

**A. Dedicated `Journey` entity** — a first-class table, `patient_id` FK, `journey_type`, own stage/pipeline, own owner, own Timeline scope, can open/close independently, a Patient has zero-to-many concurrently or over time.

**B. Legacy Lead-as-Journey** — reuse a `leads`-shaped table (as the old spec chose, for a real reason: `leads.contact_id` was already non-unique in the legacy schema, so no migration was needed). "Journey" becomes a product-layer rename over a table still shaped like a sales lead.

**Recommendation: A — dedicated `Journey` entity.**

The old spec chose B under a real constraint: it was extending a live production table and a migration was expensive to justify. That constraint doesn't exist here — this is greenfield. Building `Journey` as its own entity means:
- The schema says what the product is (a patient's engagement over a concern), not what it isn't (a sales lead).
- No legacy columns (`lead_score`, `assigned_admin_id`-as-sales-owner, etc.) drag along that don't map to a hospital workflow.
- `PipelineStage`, `Task`, `TreatmentOpportunity`, and `Interaction` all FK cleanly to `journey_id` from day one, no retrofit.
- A Patient's multiple concurrent journeys (fertility + paediatrics for a dependent) are naturally many rows against one `Patient`, with no reused sales-CRM semantics to work around.

Keep legacy terminology only where it survives on its own merits (e.g., "pipeline," "stage" are fine general CRM words) — never keep a name because renaming would be costly. There is no renaming cost here; there is only a table that doesn't exist yet.

---

## 10. Unified Timeline

`Interaction` table, keyed by `patient_id` (nullable `journey_id` for patient-level-not-journey-specific events): `event_type` (open string catalog — WhatsApp message, call logged, appointment booked/attended/no-show, stage changed, task created/completed, AI silenced/resumed, outcome recorded, treatment status changed, follow-up scheduled, note added), `actor_type` (system/ai/user), `actor_id`, `title`, `description`, `previous_value`/`new_value`, `metadata` JSON, `occurred_at`.

This is the system of record for "what happened," written by every domain service at the moment of the event — not assembled live by joining four unrelated tables (the old spec's own prototype-only shortcut, §25 there). Raw channel data (full WhatsApp message bodies, call recordings) lives in its own table (`Message`, `Call`) and is referenced from the Timeline by id, not duplicated into it.

---

## 11. Inbox / Conversation UX

WhatsApp-style familiarity is scoped to the Inbox module only — conversation list, thread view, quick replies, AI/human ownership indicator. This is the one place a chat-app visual language is appropriate because the underlying interaction genuinely is a chat.

Explicit ownership state per conversation: `AI_ACTIVE → HUMAN_REQUIRED → HUMAN_ASSIGNED → HUMAN_ACTIVE → AI_RESUME_PENDING` (same state machine validated in the old spec's §12 — the mechanism was sound, only the table it lives on changes to a new `Conversation`/`Journey`-scoped entity rather than a WhatsNexus `LiveChatTable` retrofit). Communication modes (Manual / AI Assist / AI First / Hybrid / Scheduled) are expressed as defaults and per-stage overrides on this same state machine — no separate subsystem per mode.

---

## 12. Tasks / Follow-up

`Task`: `patient_id`, `journey_id`, `assigned_to`, `created_by`, `parent_task_id` (self-FK for retry/follow-up chains), `task_type` (open catalog: initial_call, retry_call, follow_up, appointment_confirmation, no_show_recovery, manual_task), `status`, `priority`, `due_at`, `completed_at`, `completion_reason`.

The single open Task with the nearest `due_at` on a Journey is that Journey's **Next Action** — shown everywhere a Journey/Patient row appears (lists, Patient 360 header, dashboards). Assignment supports simple round-robin per team/branch/journey-type.

---

## 13. Appointments

`Appointment`: `patient_id`, `journey_id`, `doctor_id`, `branch_id`, slot/date/time, state (scheduled → checked-in → with-doctor → completed / no-show / cancelled), outcome link. State transitions write Timeline events. The WhatsNexus appointment state machine is a useful reference for the AI-driven booking conversation flow, not for the table shape — the table shape here is designed for the Journey/Patient 360 model in this spec, always FK'd to `journey_id` from creation (not retrofitted later, as the old spec had to).

---

## 14. Treatment / Post-care

`ConsultationOutcome` (per Appointment): outcome summary, `treatment_recommended`, links to `TreatmentOpportunity`.

`TreatmentOpportunity`: `patient_id`, `journey_id`, `source_outcome_id`, `treatment_label` (free text/tenant catalog, not clinical taxonomy), `status` (proposed → accepted → scheduled → in_progress → completed / declined / lost), `estimated_value`, `actual_value`, `owner`. A Journey can carry several over time (declined cycle 1, accepted cycle 2 — both same Journey, separate Opportunities).

Post-care is Tasks + scheduled follow-ups against a completed `TreatmentOpportunity` — not a new entity. Recall completion is a Timeline event and may open a new Journey if it's genuinely a new concern (staff judgment, not automation).

---

## 15. Marketing / Revenue Context

`CampaignTouchpoint` recorded at Journey creation: `source` (meta, google, website, whatsapp, incoming_call, referral, walk_in, other), `source_provider`, `source_external_id`, `campaign_ref`. Attribution is passed-in at creation time (webhook sets it, or staff picks from a dropdown) — no live ad-platform pull in V1; that's a `AdsProvider` connector addition later, not a domain-model change.

`RevenueEvent` reads from `TreatmentOpportunity.actual_value` joined through `journey_id → CampaignTouchpoint`. One rollup view: `SUM(actual_value) GROUP BY source, campaign_ref, journey_type, date_range`. No forecasting, no multi-touch modeling in V1.

---

## 16. Integration Adapters

External systems are adapters; PulseOS core never depends on a specific provider.

```
WhatsAppProvider   — Cloud API today, informed by invictus-chatbot's proven webhook/encryption pattern
TelephonyProvider  — Runo (inbound-only first), Superfone/Exotel later, same interface
AdsProvider        — Meta/Google attribution, deferred until a tenant needs it
EmailProvider       — deferred to V1.1
StorageProvider     — signed-URL object storage (R2 or equivalent)
LLMProvider         — chat/completions, model-agnostic interface
SpeechProvider       — deferred
HISConnector         — deferred, clinical system integration boundary only
```

PulseOS core owns: Patient, Journey, Timeline, Next Action, Ownership, Attribution, operational context. Providers execute transport/specialized capability only — `Runo`/`Superfone`/`Exotel` (or any WhatsApp/LLM vendor) never appear as a type in the domain model, only inside the adapter that implements a provider interface.

---

## 17. Web Information Architecture

```
Command Centre
Patients
Journeys
Inbox
Appointments
Follow-ups / Tasks
Treatment
Campaigns / Sources
Analytics
Team
Integrations
Settings
```

Doctors get a reduced nav: Command Centre (their own), Appointments, Patients (scoped), Follow-ups — no Campaigns/Analytics/Team/Integrations unless permission-granted. Compact top-level nav, drawer-based detail views (Patient 360, Journey detail) rather than full-page navigation for record detail.

---

## 18. Design System Direction

New design system — does not resemble Lead Panel or WhatsNexus visually.

- `DESIGN_VARIANCE = 5`, `MOTION_INTENSITY = 3`, `VISUAL_DENSITY = 7` — a defined visual language, functional transitions only (drawer slide, row-expand, toast), information-dense but hierarchical (not a wall of identical cards).
- Feel: simple, premium, professional, enterprise-grade, hospital-specific, fast, calm, highly usable.
- WhatsApp-style chat familiarity is scoped to Inbox only (§11) — never the whole app's visual language.
- Avoid: glassmorphism, excessive gradients, giant decorative cards, generic AI-SaaS dashboard look, unnecessary animation, brochure layouts, huge empty spaces, endless undifferentiated card grids.
- New `packages/ui` and `packages/design-tokens` — token-first (color, spacing, type scale), a real data-grid component, a timeline component, a drawer component, a KPI-strip component, a funnel component — built once, reused across every screen in §6–§8.

---

## 19. Prototype Scope and Build Order

**First build** (visible progress, no invisible-integration weeks):

1. New PulseOS application shell (nav, auth shell, role switch for demo)
2. Login
3. Admin Command Centre (seeded data)
4. Doctor Command Centre (seeded data)
5. Patients list
6. Patient 360
7. Journeys (list + detail, using the dedicated Journey entity from §9)
8. Unified Timeline (real `Interaction` table, not assembled client-side)
9. Follow-ups / Tasks
10. Appointments
11. Treatment progression
12. Source / revenue context (static/seeded, real rollup query once data exists)
13. Inbox shell (conversation list + thread view, ownership-state indicator, no live WhatsApp send required for the shell to be reviewable)

Seed realistic hospital demo data (patients, journeys across fertility/paediatrics/general OPD, doctors, branches, sources) so every screen above is reviewable with real-looking numbers, not empty states.

**Deferred past this prototype**: mobile app, live WhatsApp send/receive wiring, live telephony receive, live ad-platform attribution, full DPDP compliance program, CI/test buildout beyond what's needed to keep the prototype from regressing.

---

## 20. Self-Review

- **Legacy coupling**: none — no table in §4 is a renamed/retrofitted legacy table; §9 explicitly chose the option that avoids inheriting sales-CRM schema semantics.
- **Over-engineering**: Pipeline/stage config stays a fixed mapping (stage/outcome → task template), not a rule-automation engine (matches old spec's restraint, kept deliberately). No forecasting/multi-touch attribution in V1.
- **Duplicated old products**: explicitly avoided — §1 and §2 state no repo is imported wholesale; the design system (§18) is stated to not resemble either old product.
- **Generic SaaS dashboard risk**: addressed by making every dashboard element (§6, §7) drill-down into real filtered records, and by naming the specific hospital-operational sections (Today/Conversion/Patient Flow/Attention/Marketing/Team/Branch) rather than a generic KPI-card grid.
- **Role-specific workflows**: §5–§7 give Doctor a genuinely different home screen, not an admin view with fewer columns; §17 gives Doctor a reduced nav.
- **Drill-down from graphics**: stated as a requirement in §6 for every card/chart.
- **Ownership ambiguity**: §16 states plainly what PulseOS core owns vs. what a provider adapter owns.

No open issues found that require rewriting a section; the one substantive judgment call (Journey entity design) is resolved in §9 with reasoning, not left ambiguous.

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
