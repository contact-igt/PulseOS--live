# PulseOS Foundation Design Specification

- **Status**: Final design — approved decisions ready for implementation planning
- **Date**: 2026-09-12
- **Source of truth**: PulseOS Discovery Audit (2026-09-12) and PulseOS Gap-Closing Architecture Report (2026-09-12), both produced in this repository's audit sessions against the four source repos:
  - Backend base: `invictus-chatbot` ("WhatsNexus")
  - Frontend base: `whatnexus-frontend` ("WhatsNexus")
  - Selective-port source: `backend` + `frontend` ("Lead Panel" / Invictus Lead Admin)
- **Scope of this document**: architecture and domain design only. No implementation plan, no code changes.

This spec resolves every open decision from the gap-closing audit into one concrete, buildable design. Where the audit offered a recommendation, this spec locks it in. Where the audit left something genuinely open, that item is listed in the final "Decisions Requiring Approval" note in the return message — not inside this document, which contains only settled decisions.

---

## 1. Product Scope and Non-Goals

PulseOS is a **standalone, India-first Patient Engagement CRM** for hospitals and clinics. It is not a plugin, add-on, or integration layer for LeadSquared, Luma, or any third-party CRM — it replaces that category for its customers.

**In scope (V1):**
- Patient identity and multi-journey tracking (enquiry → treatment → post-care → revenue)
- WhatsApp-based patient engagement (manual, AI-assisted, AI-first, hybrid, scheduled)
- Appointment booking, rescheduling, cancellation, outcome capture
- Follow-up and task management
- Human takeover from AI at any point, always
- Configurable pipelines/stages and custom fields per tenant, without schema migrations per field
- Source/campaign attribution feeding into a lightweight revenue view
- Multi-branch, multi-doctor, multi-tenant (hospital/clinic group) operation
- Telephony as a pluggable adapter (starting with Runo, receive-only for V1)

**Explicit non-goals (V1 and beyond unless revisited):**
- **Not an EMR/HIS.** No clinical charting, no prescriptions, no lab/imaging results storage, no ICD coding. PulseOS tracks *engagement and commercial* journey state, not medical record state. Where a hospital already runs a HIS/EMR, PulseOS integrates via the connector layer (§17) rather than duplicating it.
- **Not a full no-code automation engine.** Pipelines/stages and custom fields are configurable; arbitrary workflow automation (trigger/action builders) is out of scope for V1 — see §15.
- **Not a telephony dialer.** PulseOS receives call outcomes from telephony providers; it does not place calls or replace the provider's own dialer app in V1 — see §17.
- **Not multi-backend.** There is exactly one production backend going forward. The Lead Panel backend (`backend`) is not deployed in production once its proven capabilities are ported; see §2.
- **Not AI-mandatory.** Every capability must work with AI fully disabled for a tenant. AI is an engagement *mode*, not a dependency.

---

## 2. Existing-Code Reuse Strategy

Three-way classification, per the locked foundation decision. No new backend or frontend is created from scratch.

### 2.1 Keep as-is (WhatsNexus / `invictus-chatbot` + `whatnexus-frontend`)

| Capability | Evidence | Disposition |
|---|---|---|
| WhatsApp Cloud API webhook (inbound message handling, tenant resolution, billing hook) | `src/models/AuthWhatsapp/AuthWhatsapp.controller.js` | Keep; harden (§22) |
| OpenAI RAG pipeline (embeddings, cosine search, grounding) | `src/utils/ai/embedding.js`, `src/models/Knowledge/knowledge.search.js` | Keep as-is (§13) |
| Appointment state machine | `src/models/AppointmentModel/Advanced_Appointment_Booking.service.js` (states `COLLECT_NAME…BOOKING_COMPLETE`) | Keep as-is (§8) |
| Appointment meaning classifier + confidence routing | `src/models/AppointmentModel/appointmentOperationRouter.service.js`, `appointmentMeaningClassifier.service.js` | Keep as-is |
| Encrypted tenant secrets (AES-256-GCM, per-tenant derived key) | `src/utils/encryption.js`, `src/models/TenantSecretsModel/tenantSecrets.service.js` | Keep as-is; remove legacy CBC path (§22) |
| Redis / BullMQ campaign queue + workers | `src/queues/campaignQueue.js`, `src/workers/campaignDispatchWorker.js`, `campaignSendWorker.js` | Keep as-is; reused for follow-up/reminder scheduling |
| Tenants / Tenant Users / Management identity model | `src/database/tables/TenantsTable`, `TenantUsersTable`, `ManagementTable` | Keep as base identity model (§5) |
| Branches / Doctors | `src/database/tables/BranchesTable`, `DoctorsTable`, related routes/services | Keep as-is |
| Appointments (slot, state log, outcome) | `AppointmentSlotTable`, `AppointmentStateLogTable`, `AppointmentOutcomeTable` | Keep as-is (§8, §9) |
| Live chat / shared inbox | `src/models/LiveChatModel/*`, `whatnexus-frontend/app/(protected)/shared-inbox/*` | Keep; extend ownership model (§12) |
| Module / Feature / Plan / Industry access gating | `src/models/ModuleAccessModel/*`, `TenantFeatureAccessModel/*`, `PlanSaaSModule*`, `IndustrySaaSModules*` | Keep as-is — this is the mechanism that makes PulseOS "hospital-first, industry-configurable later" |
| WhatsApp campaigns / billing ledger, wallet | `WhatsappCampaignTable(+Recipient)`, `BillingLedgerTable`, `WalletTable`, `src/models/BillingModel/*` | Keep as-is where a tenant needs bulk WhatsApp outreach and usage-based billing |
| Frontend page shell (contacts, leads, appointments, doctors, branches, inbox, campaigns, knowledge, management/*) | confirmed LIVE in the frontend audit against `app/(protected)/*` | Keep; relabel Lead→Journey at the UI copy layer only (§4) |

### 2.2 Port selectively (from Lead Panel `backend`/`frontend`)

| Capability | Source | Port strategy |
|---|---|---|
| Custom field engine | `backend/src/database/tables/CrmCustomFieldTable/index.js`, `backend/src/modules/birthwave/crm.routes.js` + `.controller.js` + `.service.js` | Port the table shape and CRUD/reorder/archive service pattern into `invictus-chatbot`, generalized beyond the single-tenant gate it currently has (`scopeSuperAdminToClient("birthwave")` is Lead-Panel-specific and is **not** ported — replaced by normal tenant scoping already native to Stack B). See §14. |
| Field mapping | `backend/src/database/tables/CrmFieldMappingTable/index.js` | Port table shape only; used by the connector layer (§17, §18) to map external-provider fields onto PulseOS custom fields |
| Activity/timeline pattern | `backend/src/database/tables/BirthwaveLeadActivityTable/index.js` (32-value `event_type` catalog) | Port the *pattern* (typed event catalog, actor, previous/new value, occurred_at) as the new unified Timeline table in Stack B — Stack B has no equivalent table today (confirmed absent). See §6. |
| Configurable stage concept | `backend/src/database/tables/BirthwaveLeadTable/index.js` (`status` is `STRING(50)`, JS-array-validated, not a DB ENUM) | Port the *technique* (plain string column + app-level validated value set), not the table — new `PipelineStageTable` designed fresh per §15, informed by this proof that no migration is required per tenant to add a stage |
| Assignment / follow-up patterns | `backend/src/database/tables/BirthwaveLeadAssignmentTable`, `BirthwaveAssignmentRuleTable`, `BirthwaveAssignmentCursorTable`, `BirthwaveTaskTable` | Port the *pattern* (round-robin assignment cursor, task table with `parent_task_id` self-relation for retry chains) into a new Task/Follow-up model in Stack B (§7) — Stack B has no Task table today (confirmed absent) |
| Audit/redaction pattern | `backend/src/middlewares/apiAuditLogger.js` | Port the redaction discipline (regex-block on `password|token|authorization|secret|api_key|signature`) as a cross-check layered onto Stack B's existing `src/middlewares/apiRequestLogger/index.js`, which already avoids storing body content — the two patterns are complementary, not competing |
| CRM detail UX patterns | `frontend/src/pages/birthwave/{lead-detail,assignment-rules,follow-ups}/*` | Port UX/interaction patterns only (drawer-based detail view, timeline rendering, assignment-rule builder screen) as design reference for the WhatsNexus frontend's Journey detail view — no code is copied, the components are rebuilt inside `whatnexus-frontend`'s existing component conventions |

### 2.3 Do not port

- All ~20 duplicated flat-table client verticals (`VLS*`, `PixelEye` product tables outside the webhook receiver, `AaravEyeCare`, `AntardrashtiNetralaya`, `Rio`, `ShantiEyeTech`, `PhoenixFitness`) — disposable, client-specific boilerplate, superseded by the generic custom-field/pipeline engine.
- The Lead Panel's Express/CORS/rate-limit configuration — Stack A's `origin: true` open CORS is a known defect, not a pattern to inherit.
- The Lead Panel's Google Sheets sync, Geoapify, and Repli (Instagram) integrations — not evidenced as PulseOS-relevant; revisit only if a specific tenant requires them.
- `groq-sdk` dependency in `invictus-chatbot/package.json` — confirmed unused anywhere in `src/`; remove during cleanup, do not build on it.
- The orphaned/mock frontend pages `app/(protected)/system`, `app/(protected)/logic` (hardcoded data from `lib/data.ts`, no nav entry, no API calls) and the duplicate `/playground` route — delete, do not extend.

---

## 3. Target System Architecture

```
                         ┌─────────────────────────────┐
                         │   apps/web (Next.js)         │
                         │   from whatnexus-frontend     │
                         └───────────────┬───────────────┘
                                          │
                         ┌───────────────┴───────────────┐
                         │   apps/mobile (React Native)   │
                         │   new, phase-2                 │
                         └───────────────┬───────────────┘
                                          │  REST (JSON), JWT bearer
                                          ▼
                         ┌─────────────────────────────────────────┐
                         │  apps/api (Express) — from invictus-chatbot │
                         │  ┌─────────────────────────────────────┐ │
                         │  │ Identity: Tenant / TenantUser /       │ │
                         │  │ Management + Module/Feature/Plan/     │ │
                         │  │ Industry access gating                │ │
                         │  ├─────────────────────────────────────┤ │
                         │  │ CRM: Contact, Journey(Lead), Task,    │ │
                         │  │ Timeline, CustomField, PipelineStage  │ │
                         │  ├─────────────────────────────────────┤ │
                         │  │ Appointments: Slot/StateLog/Outcome   │ │
                         │  ├─────────────────────────────────────┤ │
                         │  │ AI runtime: prompt build, RAG, intent,│ │
                         │  │ appointment state machine             │ │
                         │  ├─────────────────────────────────────┤ │
                         │  │ Engagement ownership: AI/human state  │ │
                         │  ├─────────────────────────────────────┤ │
                         │  │ Billing/Campaigns/LiveChat (existing) │ │
                         │  └─────────────────────────────────────┘ │
                         └───────┬───────────────┬───────────────────┘
                                 │               │
                    ┌────────────┘               └────────────┐
                    ▼                                          ▼
     ┌───────────────────────────┐              ┌───────────────────────────┐
     │ CONNECTOR LAYER (adapters) │              │  Redis + BullMQ (existing) │
     │ - WhatsApp Cloud API (real)│              │  campaign sends, reminders,│
     │ - Telephony/Runo (inbound) │              │  follow-up scheduling      │
     │ - Email (new, V1.1)        │              └───────────────────────────┘
     │ - Future HIS/EMR (deferred)│
     └───────────────────────────┘
                    │
                    ▼
     ┌───────────────────────────┐              ┌───────────────────────────┐
     │  MySQL (existing schema,   │              │  Cloudflare R2 (existing,  │
     │  extended, FK-hardened      │              │  fixed to signed URLs)     │
     │  incrementally)             │              └───────────────────────────┘
     └───────────────────────────┘
```

**Primary data flow**: Source (WhatsApp / website / Meta / Google / referral / walk-in / incoming call) → Contact created/matched → Journey opened (Lead row, `journey_type` set) → Timeline event recorded → engagement proceeds in one of five modes (§ "Communication modes" below) with an explicit AI/human ownership state (§12) → Appointment booked via the existing state machine (§8) → Consultation Outcome recorded (§9) → Treatment status updated (§10) → Follow-up/Recall scheduled (§7, §11) → Revenue attribution rolled up to the originating source/campaign (§19).

**Repo-to-app mapping**: `apps/api` = `invictus-chatbot` (extended per §2.2); `apps/web` = `whatnexus-frontend` (extended per §4/§20); `apps/mobile` = new. See §24 for the repository consolidation mechanics and §21 for mobile scope.

---

## 4. Contact / Journey Domain Model

**Contact = patient/person.** Backed by the existing `ContactsTable` (`src/database/tables/ContactsTable/index.js`), which already carries `tenant_id`, phone/`wa_id`, and identity fields. One addition:

- `primary_contact_id` (nullable, self-referencing FK to `contacts.id`) — represents a dependent relationship (e.g., a child whose journeys are managed through a parent's WhatsApp thread). The dependent still gets their own `Contact` row (their own identity, their own Timeline, their own Journeys) — `primary_contact_id` only records *who messages on their behalf* and is used to route WhatsApp threads and to show "linked family" context in the UI. This directly resolves the audit's "Priya → child's paediatrics journey" example without inventing a new entity.

**Lead = patient journey, for MVP and beyond.** This is the deliberate resolution of the audit's Lead/Contact/Journey ambiguity:

- The physical table remains `leads` (Sequelize model `Lead`, `src/database/tables/LeadsTable/index.js`) — **no rename migration**, because `contact_id` is already a non-unique join key on this table in the existing schema (confirmed: one Contact already can have multiple Lead rows today with zero schema change).
- At the **product and API-contract layer**, the term "Lead" is retired. The frontend, API response shapes, and all new documentation use **"Journey."** The underlying table/model name (`leads`/`Lead`) is a Phase-2 rename candidate (§26), not a blocker — renaming a live table is strictly more expensive than renaming the words above it, so it is deliberately deferred.
- Two additions to `LeadsTable` (both additive, non-breaking):
  - `journey_type` (STRING, tenant-defined free text or a small fixed set per tenant e.g. `fertility`, `pregnancy`, `paediatrics`, `general_opd`) — distinguishes concurrent journeys for the same Contact.
  - `journey_label` (STRING, optional human-friendly override, e.g. "Priya — 2nd IVF cycle")
- **One Contact → many Journey rows, concurrently or sequentially.** A Journey is opened per distinct patient engagement (a new enquiry for a new concern) and is never reused across unrelated concerns — this keeps stage/pipeline/ownership/appointments/outcome all scoped correctly per concern, matching the audit's fertility/pregnancy/paediatrics example exactly.
- **Unified patient context across journeys**: the Contact record is the single source of identity (name, phone, demographics, consent flags — §22); the Timeline (§6) is queried by `contact_id` by default (showing all journeys interleaved) and can be filtered to a single `journey_id` — this is how "one unified context even across multiple journeys" is satisfied without merging journey-specific state (stage, owner, outcome) into one row.

**Do not build a separate `Journey` table for V1.** The audit's own evidence (non-unique `contact_id` already on `leads` in both source schemas) proves the existing table already supports the required cardinality; a new entity would add a join and a migration for no functional gain. This is revisited only if a journey ever needs to itself contain multiple concurrent sub-engagements — no such requirement exists today.

---

## 5. Authentication / Tenancy / Permissions

**Canonical identity model = Stack B's, extended.** `Tenant` (`TenantsTable`, already has `type` enum including `hospital`/`clinic` and `industry_type` including `healthcare`) + `TenantUser` (`TenantUsersTable`) for tenant-side staff + `Management` (`ManagementTable`) for platform operators. JWT payload continues to carry `{id, unique_id, user_type, tenant_id, role}` (`src/middlewares/auth/authMiddlewares.js`), differentiating `management` vs `tenant` identity via `user_type` as today.

This is chosen over Stack A's `Client`+`Management` model because it is the only one of the two with a live, working Module/Feature/Plan/Industry gating system (§2.1) — the exact mechanism PulseOS needs to ship different capability sets to a hospital vs. a single clinic vs. a diagnostics chain without forking code.

**Required hardening (not architecture changes, additive):**
- Add FK constraints from every `tenant_id` STRING column to `tenants.id` where new tables are introduced by this spec (Timeline, Task, PipelineStage, CustomField) — existing tables are hardened opportunistically, not in one migration sweep (§24).
- Expand the role model from the current flat `tenant_admin`/`staff` pair. PulseOS introduces a **permission-set model** rather than growing the enum indefinitely: `TenantUsersTable.role` stays as a coarse tier (`tenant_admin`/`staff`), and a new `TenantUserPermissionTable` (`tenant_user_id`, `permission_key`) grants fine-grained capabilities (`journey.assign`, `journey.reassign_any`, `appointment.manage_all_doctors`, `ai.silence_toggle`, `billing.view`, etc.) to individual staff — this is how receptionist / counsellor / doctor-as-login / marketing-user distinctions are expressed without a role-enum migration every time a new job title appears. Doctors remain primarily a data entity (`DoctorsTable`); a doctor gets a login only when explicitly linked via the existing nullable `tenant_user_id` field on `DoctorsTable`.
- Frontend token storage moves from `sessionStorage` (via `redux-persist`, `whatnexus-frontend/redux/store.ts:26-39`) to an **httpOnly, `SameSite=Lax` cookie** issued by the backend on login; `helper/axios.ts` drops manual `Authorization` header attachment in favor of `credentials: 'include'`. This closes the confirmed XSS-exposure finding.
- Route protection moves from client-side-only (`whatnexus-frontend/routes/ProtectedRoute.tsx`) to a real Next.js `middleware.ts` performing a server-side cookie check before a protected page ships to the browser — the client-side check remains as a secondary UX guard (avoids content flash), not the sole gate.
- Refresh-token rotation gains a denylist: on `POST /management/refresh-token` (`authMiddlewares.js:229-249`), the previous refresh token's `jti` is recorded in a small `RevokedTokenTable` (or a Redis set with TTL = remaining token lifetime, reusing the existing Redis infrastructure) so a superseded refresh token cannot be replayed.

---

## 6. Unified Interaction Timeline

**New table**, modeled on the proven Lead Panel pattern (`backend/src/database/tables/BirthwaveLeadActivityTable/index.js`), because Stack B has no equivalent today (confirmed absent across an exhaustive table search).

```
TimelineEventTable:
  id, tenant_id, contact_id, journey_id (nullable — some events are contact-level, not journey-specific),
  event_type (STRING — WhatsApp message, call logged, appointment booked/attended/no-show,
              stage changed, task created/completed, AI silenced/resumed, outcome recorded,
              treatment status changed, follow-up scheduled, note added — open catalog, not a DB ENUM,
              matching the low-migration-cost technique proven in BirthwaveLeadTable.status),
  actor_type (system | ai | tenant_user), actor_id (nullable),
  title, description, previous_value, new_value, metadata (JSON),
  occurred_at, created_at
```

This table does **not** replace `MessagesTable`, `AppointmentStateLogTable`, or `LeadScoreHistoryTable` — those remain the systems-of-record for their own domains (raw WhatsApp messages, chatbot conversation-flow state, score changes). The Timeline is a **write-through projection**: whenever a Journey-relevant event happens in any of those domains (a message is a poor timeline entry, but "AI silenced," "appointment booked," "outcome recorded" are), the relevant service also writes one `TimelineEventTable` row. This keeps the Timeline focused and fast to query per Contact, rather than requiring the UI to merge four tables live (which is the deliberate *prototype-only* shortcut in §25, replaced by this real table in production).

The frontend's Journey/Contact detail view (§20) renders this table as its primary "what happened" feed, filterable by `journey_id`.

---

## 7. Follow-ups / Tasks / Next Action

**New table**, modeled on `backend/src/database/tables/BirthwaveTaskTable/index.js` — Stack B has no Task table today (confirmed absent).

```
TaskTable:
  id, tenant_id, contact_id, journey_id, assigned_to (tenant_user_id), created_by,
  parent_task_id (nullable self-FK — retry/follow-up chains, same pattern as BirthwaveTaskTable),
  task_type (STRING: initial_call, retry_call, follow_up, appointment_confirmation,
             no_show_recovery, manual_task — open catalog, not DB ENUM),
  status (STRING: pending, in_progress, completed, cancelled),
  priority (STRING: normal, high),
  due_at, started_at, completed_at, cancelled_at, completion_reason, metadata (JSON)
```

Every open Task with a `due_at` is the source for a Contact/Journey's **"Next Action"** — the single most important field surfaced on every list/table view in the UI (§20). Assignment reuses the round-robin pattern from `BirthwaveAssignmentRuleTable`/`BirthwaveAssignmentCursorTable`, ported as a small `AssignmentRuleTable` (per-tenant rule: round-robin among a team for a given `journey_type`/branch) — this is additive, not a rebuild.

`ScheduledMessageTable` (existing, `send_type` enum `follow_up|noshow|appointment_reminder`) remains the mechanism for **automated WhatsApp follow-up sends**; `TaskTable` is for **human-owned** follow-up work. A scheduled WhatsApp follow-up firing successfully writes a Timeline event but does not itself create a Task — a Task is created only when a message needs a human response or a call needs to happen.

---

## 8. Appointments

**Kept as-is.** The existing state machine (`src/models/AppointmentModel/Advanced_Appointment_Booking.service.js`, states `COLLECT_NAME → COLLECT_EMAIL → SELECT_DOCTOR → SELECT_DATE → SELECT_TIME → COLLECT_REASON → BOOKING_COMPLETE`, persisted on a session's `current_step`) is proven, deterministic, and directly reusable for hospital OPD-style booking. `AppointmentSlotTable` (with its `[tenant_id, doctor_id, appointment_date, appointment_time]` concurrency-guard index) and `AppointmentStateLogTable`/`AppointmentOutcomeTable` are kept unchanged.

One addition: `AppointmentTable` (or `AppointmentSlotTable` once booked) gains `journey_id` (currently appointments join to a contact but not explicitly to a journey) so that an appointment is always attributable to the specific patient journey it belongs to, not just the patient generally — required for the revenue-attribution rollup in §19.

The separate AI-intake-only agent (`appointmentBookingAiAgent.service.js`) remains explicitly barred from creating real bookings — it only *collects* details; the state machine is the sole writer of confirmed appointments, preserving the existing, deliberate safety boundary.

---

## 9. Consultation Outcomes

**Kept as-is, extended.** `AppointmentOutcomeTable` already captures `follow_up_type` (`Call/Visit/WhatsApp`) and an outcome category (`Revisit/Enquiry`). This becomes the consultation-outcome record: after an appointment is marked attended, the doctor/staff records outcome via the existing `VisitOutcomeDrawer.tsx` (`whatnexus-frontend/components/views/appointments/`) pattern, which already traces to a real backend endpoint (confirmed LIVE in the frontend audit).

Addition: `AppointmentOutcomeTable` gains `treatment_recommended` (BOOLEAN) and `treatment_opportunity_id` (nullable, see §10) — the hinge point between "the consultation happened" and "there is now a commercial next step."

Recording an outcome always writes a Timeline event (`event_type: outcome_recorded`) and, if `treatment_recommended` is true, triggers creation of a Treatment Opportunity (§10) and a default post-consultation Task (§7) if the tenant's pipeline configuration marks that stage as requiring one (§15).

---

## 10. Treatment Opportunity / Status

**New table**, deliberately small — this is the "commercial next step" object, distinct from both the Journey (the engagement/pipeline wrapper) and the clinical Outcome (which PulseOS does not model beyond a free-text/structured summary).

```
TreatmentOpportunityTable:
  id, tenant_id, contact_id, journey_id, source_outcome_id (nullable FK → AppointmentOutcomeTable),
  treatment_label (STRING — free text or tenant-configured catalog value, not a fixed clinical taxonomy),
  status (STRING: proposed, accepted, scheduled, in_progress, completed, declined, lost — open catalog),
  estimated_value (DECIMAL, nullable), actual_value (DECIMAL, nullable, filled at completion),
  owner (tenant_user_id), decided_at, completed_at, metadata (JSON)
```

A Journey can have zero, one, or several Treatment Opportunities over its life (e.g., "IVF cycle 1" declined, "IVF cycle 2" accepted six months later — both belong to the same Journey, each is its own Opportunity). `status` changes are Timeline events. This table is intentionally *not* a clinical record — no procedure codes, no consent forms, no clinical notes beyond `treatment_label`/`metadata` free text. It exists purely to connect a consultation to a revenue outcome (§19), which is the explicit product requirement ("marketing attribution must eventually reach treatment/revenue") without becoming EMR functionality.

---

## 11. Post-care / Recall

Post-care is modeled as **Tasks + scheduled follow-ups against a completed Treatment Opportunity**, not a new entity. When a `TreatmentOpportunityTable` row reaches `status = completed`, the tenant's configured pipeline rules (§15, kept minimal — a simple "on stage X, create task template Y after N days" mapping, not a general automation engine) create:
- A `TaskTable` row for a recall check-in (`task_type: manual_task`, `due_at` offset by tenant-configured days), and/or
- A `ScheduledMessageTable` row (`send_type: follow_up`) for an automated WhatsApp recall nudge, reusing the existing scheduler infrastructure unchanged.

Recall completion (patient responds, rebooks, or is marked "no further action") is a Timeline event and may open a **new Journey** if it represents a genuinely new concern, or simply close the loop on the existing one — this is a staff judgment call in the UI, not an automated branch, keeping the system simple per the "avoid premature automation" instruction.

---

## 12. AI / Human Ownership and Handoff

This is the most important correction this spec makes to the current WhatsNexus implementation (see §12 note at the end of this section and the "Important Changes" summary in the return message).

**Current state (confirmed by audit)**: `contacts.is_ai_silenced` (BOOLEAN, `ContactsTable`) is checked on every inbound message before any AI call (`AuthWhatsapp.controller.js:1082-1087`) and is a real, working suppression switch. However, it is **completely disconnected** from `LiveChatTable.status`/`assigned_admin_id` (the "claim a chat" mechanism, `livechat.service.js:183-236`) — a human can claim a chat while the AI keeps auto-replying in parallel. There is no named ownership state, and `ChatLocksTable` is confirmed to be an unrelated duplicate-webhook debounce lock, not an ownership arbiter.

**PulseOS design — explicit engagement ownership state**, added to `LiveChatTable` (or a new `EngagementOwnershipTable` keyed by `contact_id` if a chat-scoped column proves too narrow once phone/webchat channels are added — decision deferred to implementation, not architecture-blocking):

```
ownership_state: AI_ACTIVE | HUMAN_REQUIRED | HUMAN_ASSIGNED | HUMAN_ACTIVE | AI_RESUME_PENDING
```

- `AI_ACTIVE` (default): AI replies normally, subject to existing grounding/confidence gates.
- `HUMAN_REQUIRED`: set automatically when (a) the AI's own confidence/grounding layer forces a "missing knowledge" fallback twice in a row, (b) the meaning-classifier confidence stays below the ask-confirm threshold (0.55) across two turns, or (c) the patient explicitly asks for a human (existing intent-classification vocabulary is extended with a `request_human` intent). AI stops replying automatically the moment this state is set — this is the closure of the confirmed handoff gap.
- `HUMAN_ASSIGNED`: set when a staff member claims the chat (`livechat.service.js` claim flow) — **this now also flips `ownership_state`**, replacing today's disconnected `is_ai_silenced` toggle as the primary mechanism (`is_ai_silenced` becomes a derived/legacy field kept for backward compatibility during migration, not a second source of truth).
- `HUMAN_ACTIVE`: set on the assigned staff member's first reply.
- `AI_RESUME_PENDING`: staff explicitly hands back to AI (one click, mirrors today's "Unsilence AI" button in `ChatDetails.tsx:376-401`) — AI resumes on the next inbound message, and the resume path explicitly re-reads the last N Timeline events (not just raw chat history) so the AI has structured context on what the human covered, not just replayed text.

**Concurrent-response protection**: the existing `tryAcquireLock`/`ChatLocksTable` mechanism is kept unchanged for its actual purpose (duplicate-webhook debounce). A new, simple guard is added at the point the AI is about to send a reply: re-check `ownership_state === AI_ACTIVE` immediately before sending (not just at the start of processing) — closes the race where a human claims mid-processing. This is a single extra read, not new infrastructure.

**AI is optional by design**: a tenant can set a tenant-level flag (already structurally possible via the existing Feature/Module access system, §2.1) to force every new conversation to `ownership_state = HUMAN_REQUIRED` from creation — this is how "PulseOS must be usable without AI" and "communication mode = Manual" are satisfied without a parallel code path; it is the same state machine with a different default entry state.

**Communication modes**, expressed entirely through `ownership_state` defaults and existing scheduler infrastructure — no new subsystem:
- **Manual**: tenant flag forces `HUMAN_REQUIRED` on every new conversation.
- **AI Assist**: `AI_ACTIVE` default, but every AI-drafted reply is queued for one-tap staff approval before sending (a small addition to the existing reply-send path — a `requires_approval` flag on the outbound message, checked before `AuthWhatsapp.controller.js` actually calls the WhatsApp send API).
- **AI First**: `AI_ACTIVE` default, sends autonomously, escalates to `HUMAN_REQUIRED` per the rules above — this is today's WhatsNexus behavior, unchanged.
- **Hybrid**: per-`journey_type` or per-stage default (e.g., AI First for initial enquiry triage, Manual once a Treatment Opportunity is `accepted`) — implemented as a lookup against the pipeline configuration (§15), not a separate engine.
- **Scheduled**: existing `ScheduledMessageTable` mechanism, unchanged — outbound-only, no ownership-state interaction needed since it's not a live conversation turn.

---

## 13. Knowledge / RAG Reuse

**Kept entirely as-is.** `src/utils/ai/embedding.js` (OpenAI embeddings) and `src/models/Knowledge/knowledge.search.js` (cosine similarity search, `SIMILARITY_THRESHOLD = 0.12`, top-12 chunks, automatic embedding backfill with retry) are proven and require no architectural change for PulseOS. The grounding-enforcement layer in `AuthWhatsapp.service.js` (forcing a "missing knowledge" fallback rather than letting the model guess) is a genuine safety asset for a healthcare-adjacent product and is explicitly preserved.

The only addition: knowledge sources become **per-journey-type filterable** — a hospital's fertility-department FAQ content should not surface when answering a paediatrics enquiry. This is a `journey_type` (nullable) tag added to `KnowledgeSourcesTable`/`KnowledgeChunksTable` rows and an additional filter clause in `knowledge.search.js`'s candidate-fetch query — additive, not a redesign.

---

## 14. Custom Fields

Port `CrmCustomFieldTable` (`backend/src/database/tables/CrmCustomFieldTable/index.js`) into `invictus-chatbot`, generalized:

```
CustomFieldTable:
  id, tenant_id, entity_type (STRING — "journey", "contact", "treatment_opportunity", open-ended),
  field_key, label, field_type (STRING — text/long_text/number/date/datetime/
                                  single_select/multi_select/boolean/email/phone/url —
                                  JS-array-validated, not a DB ENUM, per the proven Lead Panel technique),
  options (JSON), required, active, show_in_form, show_in_detail, show_in_table, filterable,
  display_order
  UNIQUE (tenant_id, entity_type, field_key)
```

Values are stored as a `custom_fields JSON` column added to `LeadsTable` (Journeys) and `ContactsTable` — the same technique the Lead Panel already proves works (`BirthwaveLeadTable.custom_fields`). **This is exactly how "custom healthcare fields must not require new DB columns for every field" is satisfied**: a hospital adding "Referring Doctor Name" or a fertility clinic adding "Cycle Number" is a row in `CustomFieldTable` plus a JSON key, never an `ALTER TABLE`.

CRUD/reorder/archive service logic is ported from `backend/src/modules/birthwave/crm.service.js` (`listFields`, `createField`, `reorderFields`, `archiveField`) near-verbatim, with the Lead-Panel-specific `scopeSuperAdminToClient("birthwave")` gate removed and replaced by Stack B's native tenant scoping (every field-admin route already sits behind `authenticate` + tenant-derived `tenant_id`, per the confirmed IDOR-safe pattern in §22).

---

## 15. Configurable Pipeline / Stages

**New table**, small and deliberately not over-built (per the explicit instruction to avoid a full no-code automation engine):

```
PipelineStageTable:
  id, tenant_id (nullable = industry-wide default, cloned/overridden per tenant),
  entity_type (STRING — "journey" today; open for future use),
  stage_key, label, color, display_order,
  is_won (BOOLEAN), is_lost (BOOLEAN), is_active (BOOLEAN), industry_default (BOOLEAN)
```

`LeadsTable.status`/`stage` (currently `STRING(50)`, JS-array-validated per the Lead Panel's `BirthwaveLeadTable` precedent) is repointed to validate against a tenant's `PipelineStageTable` rows instead of a hardcoded JS array — **no column-type migration required**, confirming the audit's low-migration-cost finding in practice.

**What is explicitly NOT built in V1**: per-stage entry/exit rules, required-field-per-stage enforcement, trigger/action automation builders, SLA timers beyond the existing `BirthwaveAttentionTable`-style pattern (deferred, not ported in V1). The only automation retained is the narrow, already-proven post-outcome task/follow-up creation described in §9/§11 — a fixed, small mapping (stage/outcome → task template), not a general rule engine. This is the direct application of "avoid building a full no-code automation engine in V1."

Industry defaults (e.g., a standard hospital OPD pipeline: `Enquiry → Contacted → Appointment Scheduled → Consulted → Treatment Proposed → Treatment Accepted → Completed → Lost/Declined`) ship as `tenant_id = NULL, industry_default = true` rows that a new hospital tenant clones on onboarding and can then freely edit — reusing the same `IndustrySaaSModules`-style default/override pattern Stack B already has for feature access (§2.1), applied to a new domain rather than inventing a new mechanism.

---

## 16. WhatsApp Architecture

**Kept entirely as-is** at the integration level: `AuthWhatsapp.controller.js`'s webhook handling, tenant/`phone_number_id` resolution, billing hook, and encrypted-token access pattern (`tenant_secrets` via `src/utils/encryption.js`) are all proven and unchanged.

**One mandatory hardening**: inbound `POST /webhook/:tenantId?` currently has no `X-Hub-Signature-256` verification (confirmed gap — `AuthWhatsapp.routes.js:9-10`, `receiveMessage` handler). PulseOS adds signature verification using the tenant's `META_APP_SECRET` (already an existing env/config concept) before any payload is trusted, matching the pattern the codebase already uses correctly for Razorpay (`RAZORPAY_WEBHOOK_SECRET`) and campaign-event webhooks (`CAMPAIGN_EVENT_WEBHOOK_SECRET`). This is a security fix to an existing handler, not new architecture.

WhatsApp remains **one channel among several** in the connector layer (§17) — the domain model (Contact, Journey, Timeline, Task) has no WhatsApp-specific fields; channel-specific data lives in `MessagesTable`/`WhatsappAccountTable` as it does today, referenced from the Timeline by `event_type` + `metadata`, not embedded into core entities. This satisfies "PulseOS must be usable without AI" and, by the same structural argument, without WhatsApp — a tenant could in principle run PulseOS on phone/manual-only engagement with zero WhatsApp configuration.

---

## 17. Telephony Provider-Adapter Boundary

Confirmed reusable today: `backend/src/modules/pixelEye/webhook/` (`pixelEyeWebhook.routes.js:24-32`, `.service.js:547-870`) is a real, working **inbound** Runo webhook receiver — API-key auth with timing-safe compare, optional IP allowlist, rate limiting, writes disposition/recording-url/direction/duration into `PixelEyeCallLogTable`. No outbound Runo/Superfone/Exotel client exists anywhere in any repo (confirmed).

**PulseOS telephony design**: a `TelephonyConnector` interface, with Runo as the first (receive-only) implementation:

```
TelephonyConnector (interface):
  receiveCallEvent(payload, signature) → { contact, journey, disposition, recording_url,
                                            direction, duration_seconds }
```

The Runo implementation is a direct port of the `pixelEyeWebhook` security pattern (API key + optional IP allowlist, request signature/timing-safe compare) rewired to write into `TimelineEventTable` (`event_type: call_logged`) instead of `PixelEyeCallLogTable`, and to create/advance a `TaskTable` follow-up when the disposition indicates one is needed (e.g., "no answer" → retry-call task). **Outbound calling (click-to-call) is explicitly out of scope for V1** — staff dial out using Runo's own app/device as they do today; PulseOS only needs to *receive* the outcome. This matches the product requirement exactly ("Human calls using Runo → call completes → feedback/disposition → PulseOS timeline → next follow-up") without inventing dialer functionality that was never proven to exist anywhere in the audited code.

Superfone/Exotel, and any future outbound capability, implement the same `TelephonyConnector` interface — the domain model (Journey, Timeline, Task) never references a specific provider, satisfying "external systems such as Runo/Superfone/Exotel/HIS/EMR must use adapter boundaries" and "do not tightly couple the domain model to one provider."

---

## 18. Marketing / Source Attribution

`LeadsTable`/`BirthwaveWebsiteLeadTable`-style `source`/`source_provider`/`source_external_id`/`campaign`/`utm_campaign` fields (the latter two confirmed present today only on the Lead Panel's `BirthwaveWebsiteLeadTable`, as free-text attribution columns, not a campaign entity) are consolidated onto the Journey (`leads`/`Lead`) row in Stack B:

```
Additions to LeadsTable:
  source (STRING — open catalog: meta, google, website, google_business, whatsapp,
          incoming_call, referral, walk_in, other),
  source_provider, source_external_id (dedupe keys for webhook-driven sources),
  campaign_ref (STRING, nullable — free-text campaign identifier; links to WhatsappCampaignTable.campaign_id
                when the source is an outbound WhatsApp campaign, otherwise free text for ad-platform campaign names)
```

No live Meta/Google Ads API pull exists in either audited codebase — attribution today is (and remains for V1) **passed-in at creation time**, via whichever channel creates the Contact/Journey (a website form webhook sets `source=website`; a WhatsApp-originated conversation sets `source=whatsapp`; a manually-entered walk-in sets `source=walk_in` from a dropdown in the UI). Live ad-platform attribution APIs (Meta Conversions API, Google Business Profile messaging) are a **connector-layer addition**, not a domain-model change, when a tenant requires them — the `source`/`source_provider` fields already anticipate this without further design work.

---

## 19. Revenue Attribution

Deliberately the thinnest layer in this spec, per "avoid over-engineering" and the audit's own MOCK-for-prototype guidance (§25). Revenue is read, not computed by a dedicated service, from:

`TreatmentOpportunityTable.actual_value` (§10) joined through `journey_id` → `LeadsTable.source`/`campaign_ref` (§18). A single reporting view (SQL view or a lightweight service query, not a new subsystem) rolls up `SUM(actual_value) GROUP BY source, campaign_ref, journey_type, date_range` — this is the entirety of V1 revenue attribution. No forecasting, no multi-touch attribution modeling, no marketing-spend-vs-revenue ROI engine — those are explicitly deferred (§26) pending evidence of need once real revenue data exists to validate against.

---

## 20. Web Information Architecture

Base: `whatnexus-frontend`'s existing route tree and component conventions (confirmed ~90% LIVE against real data in the frontend audit) — extended, not replaced.

**Design parameters applied**: `DESIGN_VARIANCE=4` (a defined, consistent visual language — not experimental, not sterile), `MOTION_INTENSITY=3` (functional transitions only: drawer slide-in, row-expand, toast — no decorative animation), `VISUAL_DENSITY=7` (information-dense tables and detail panes, healthcare-appropriate — closer to a clinical ops console than a marketing dashboard).

**Primary navigation** (extends `components/layout/sidebarConfig.ts`): Dashboard, **Journeys** (renamed from "Leads"), Contacts, Appointments, Shared Inbox, Follow-ups/Tasks, Doctors, Branches, Campaigns, Knowledge Base, Settings (Pipeline config, Custom Fields, Team, WhatsApp, Billing). Confirmed MOCK/UNUSED pages (`system`, `logic`, orphaned `/playground`) are removed from the codebase, not just hidden from nav.

**Core screen patterns**:
- **Journey list**: dense, filterable, sortable table (MUI DataGrid — ported as a component from the Lead Panel frontend per §2.2, since Stack B's current table components are thinner) — columns: Patient, Journey Type, Stage, Owner, Next Action (from Task, §7), Last Contact, Source. Strong filter bar (stage, owner, journey type, source, date range, branch) and search-as-you-type by patient name/phone — this is the single highest-value screen and gets the most design investment.
- **Contact/Journey detail**: a drawer (not a full-page navigation, not a modal stack) opening from the list row — header shows unified patient context (name, phone, all-journeys summary via `primary_contact_id`/`contact_id` rollup), body is tabbed: Timeline (§6, primary tab), Journey details (stage, custom fields, treatment opportunities), Appointments, Tasks. This directly satisfies "drawers/detail views" and "avoid excessive modal workflows."
- **Appointment views**: kept from existing `appointmentsView.tsx`/`appointmentDrawer.tsx`/`VisitOutcomeDrawer.tsx`/`NoShowDrawer.tsx` (all confirmed LIVE) — extended with `journey_id` display, otherwise unchanged.
- **Inline feedback**: toast/snackbar for save confirmations (existing `sonner` dependency already in `whatnexus-frontend/package.json`, kept) — no full-page loading states for routine actions, optimistic UI where the existing React Query cache supports it.
- **Explicitly avoided**: gradients, glassmorphism, oversized KPI hero cards, decorative motion, brochure-style marketing sections inside the app shell, generic "AI dashboard" chat-bubble aesthetics for anything other than the actual live-chat panel.
- **Accessibility/responsive**: desktop-first (primary usage is front-desk/back-office), tablet-supported (bedside/consult-room use), keyboard navigable tables and drawers, WCAG AA color contrast minimum given the clinical setting.

---

## 21. Mobile Architecture

**Phase 2, not part of the 2-day prototype** (§25). React Native app (`apps/mobile` in the monorepo, §24), targeting iOS + Android, for:
- Doctors/staff: appointment schedule, patient context lookup, quick outcome/disposition capture, task list, push notifications for `HUMAN_REQUIRED` handoffs.
- Not a full CRM surface — mobile is a **companion** to the web app for on-the-go actions, not a parity rebuild of every desktop screen (V1 mobile scope: today's schedule, patient lookup, outcome capture, task list, notifications — nothing beyond that).

Shares `packages/types` (API contract types) and `packages/api-client` with `apps/web` from day one of the monorepo structure (§24), so there is no separate mobile-specific backend integration work when this phase starts — the same REST API and JWT/cookie-derived-bearer-token auth model (mobile cannot use httpOnly cookies the way web does; mobile uses a securely-stored bearer token via platform keychain/keystore, issued by the same login endpoint) serves both.

---

## 22. Security Boundaries

Every item below is a confirmed audit finding, resolved to a specific, bounded fix — **none require a compliance-implementation project for the prototype** (§25 explicitly scopes these out of the 2-day build):

| Finding | Fix (bounded, not a project) |
|---|---|
| WhatsApp webhook POST has no signature verification | Add `X-Hub-Signature-256` check to `receiveMessage` handler using existing `META_APP_SECRET` config (§16) |
| AI/human can respond concurrently | Explicit `ownership_state` machine + pre-send re-check (§12) |
| R2 files public-by-default, weak (`Math.random()`) asset-id entropy | Move to signed, time-limited R2 URLs; replace `Math.random()` with `crypto.randomBytes` for asset IDs — bounded fix in `src/services/storageService.js` |
| JWT/refresh token in `sessionStorage` via redux-persist | httpOnly cookie issuance + `middleware.ts` route protection (§5) |
| Refresh token has no revocation | Denylist on rotation via Redis set with TTL (§5) |
| No SQL FK constraints in Stack B schema | Add FKs on all new tables introduced by this spec; existing tables hardened incrementally, not blocking V1 (§24) |
| Only two-tier roles, no granular permission | `TenantUserPermissionTable` (§5) |
| No consent/DPDP foundation | **V1 minimum, not full compliance**: add `consent_whatsapp_marketing` (BOOLEAN) and `consent_recorded_at` on `ContactsTable`, captured at first WhatsApp opt-in per Meta's own requirement, plus keep the existing `dataDeletion` static page process manual (email-driven) — a full DPDP program (data residency audit, breach-notification process, DPO designation) is explicitly out of scope for this spec and flagged for a dedicated compliance track before any hospital's real patient data is onboarded. |
| Legacy AES-256-CBC path for old OpenAI keys | Migrate remaining CBC-encrypted values to GCM, then delete the CBC code path from `src/utils/encryption.js` |
| No automated tests / CI | See §23 |
| Real patient data | **Gate**: no tenant is onboarded with real patient PII/PHI until the WhatsApp signature fix, R2 signed-URL fix, and httpOnly-cookie auth fix are live in production — these three are the hard blockers; the rest of this table can land incrementally after that gate. |

---

## 23. Testing Strategy

Neither source codebase has CI or a real test suite today (`invictus-chatbot` has one Jest file, `tests/billingAccess.service.test.js`, wired via `test:billing`; `appointmentBookingAiAgent.test.js` at the repo root exists but is not wired into any script; `whatnexus-frontend` has no test script at all). PulseOS does not inherit this gap:

- **Backend**: Jest, extending the existing `test:billing` pattern. Priority order: (1) wire the existing `appointmentBookingAiAgent.test.js` into `package.json` and CI immediately — it already exists and tests the most safety-critical path (appointment booking correctness); (2) unit tests for the new Timeline/Task/CustomField/PipelineStage/TreatmentOpportunity services as they're built; (3) integration tests for the AI ownership-state machine (§12), specifically the concurrent-response guard, since this is a correctness-critical new mechanism with no prior test coverage to build on.
- **Frontend**: adopt Vitest + React Testing Library for new components (Journey list/detail, ownership-state UI); do not attempt to retroactively test the entire existing ~90%-live page set in V1 — prioritize the new/changed surfaces.
- **CI**: GitHub Actions (neither repo has `.github/workflows` today) — a single pipeline per app (`apps/api`, `apps/web`) running lint + test on every PR, gating merge. This is intentionally minimal (no e2e/Playwright suite in V1) — added post-prototype once the core screens stabilize (§26).

---

## 24. Migration Strategy

**Repository consolidation** (per the backend/frontend foundation decisions already locked): a monorepo (`apps/web`, `apps/mobile`, `apps/api`, `packages/*`), using Turborepo. `apps/api` and `apps/web` are imported from `invictus-chatbot` and `whatnexus-frontend` respectively via `git subtree`/`git filter-repo` to preserve history; `apps/mobile` is scaffolded fresh when §21 begins, not before. `backend`/`frontend` (Lead Panel) are **not** imported wholesale — only the specific files/patterns named in §2.2 are manually ported (copied and adapted, not merged via git), since importing the whole repo would re-introduce the ~20 duplicate vertical modules explicitly excluded in §2.3.

**Database migration**: additive-only for V1. Every table introduced by this spec (`TimelineEventTable`, `TaskTable`, `CustomFieldTable`, `PipelineStageTable`, `TreatmentOpportunityTable`, `TenantUserPermissionTable`, `RevokedTokenTable`) is a new table. Every column addition to existing tables (`journey_type`/`journey_label`/`source*`/`campaign_ref` on `LeadsTable`; `primary_contact_id`/`consent_*` on `ContactsTable`; `journey_id` on appointment tables; `treatment_recommended`/`treatment_opportunity_id` on `AppointmentOutcomeTable`) is nullable/defaulted — no existing row is broken, no existing query is required to change to keep working. FK-hardening (§5, §22) is applied to new tables at creation time and retrofitted to existing tables opportunistically, table-by-table, never as one blocking migration.

**No downtime cutover is required** for the backend/frontend consolidation itself, since `invictus-chatbot`/`whatnexus-frontend` already are the production systems being extended — this is additive development on a live base, not a data migration between two systems. The only genuine "migration" in this spec is the Lead Panel's proven *patterns* (not its data) into Stack B, which by construction starts empty (no Lead Panel tenant data is migrated in V1 — Lead Panel and PulseOS serve different customer bases today, per the audit; a data-migration project is only needed if/when an existing Lead Panel client vertical is deliberately moved onto PulseOS, which is out of scope here).

---

## 25. 2-Day Prototype Boundary

Real (persisted, not mocked): Contact and Journey creation/persistence, Timeline (assembled live from existing tables for the prototype — `MessagesTable` + `AppointmentStateLogTable` + `LeadScoreHistoryTable` + `AppointmentOutcomeTable` merged client-side, since the real `TimelineEventTable` from §6 is a post-prototype build item), WhatsApp conversation via the existing Playground simulator or a real test WABA number if available, the existing appointment state machine, the existing `is_ai_silenced` human-takeover toggle (the full `ownership_state` machine from §12 is a post-prototype build item — the prototype demonstrates the *concept* using today's boolean, not the final mechanism), consultation outcome capture via the existing `AppointmentOutcomeTable`/`VisitOutcomeDrawer.tsx`.

Mocked (explicitly, per the product requirement — nothing else is mocked): outbound telephony (no real Runo outbound exists to demo — receive-only inbound is real if a test webhook payload is simulated), live Meta/Google ad-platform data if tenant credentials aren't available for the demo, and revenue attribution beyond a static display value (the real `TreatmentOpportunityTable`/rollup query from §19 is a post-prototype build item).

Two additive, non-breaking schema changes are acceptable within the 2-day window (both already described as safe additions in §4): `journey_type` on `LeadsTable`, and using the existing `custom_fields`-style JSON pattern (or a plain new column if faster) for a demo-only `journey_label`. No other schema change is needed for the prototype — everything else it demonstrates rides on tables that already exist and are already LIVE per the frontend/backend audits.

This boundary is deliberately narrower than the full spec: it proves the product concept (Source → Patient → Journey → Timeline → WhatsApp/Human → Follow-up → Appointment → Outcome → Treatment status → Post-care next action → Revenue/source context) end-to-end using what's already real, without building any of the new tables in §6, §7, §10, §14, §15, or the ownership-state machine in §12 — those are Phase 1 (post-prototype), not prototype scope.

---

## 26. Post-Prototype Phases

**Phase 1 (foundation build-out, weeks 1–4)**: implement §6 (Timeline), §7 (Tasks), §12 (real ownership-state machine), §14 (Custom Fields), §15 (Pipeline/Stages), §10 (Treatment Opportunity) as real, persisted tables and services — this is the bulk of the domain model this spec describes, converting the prototype's client-side shortcuts into the production mechanisms.

**Phase 2 (hardening, weeks 3–6, overlapping Phase 1)**: all of §22's security items, §23's CI/testing buildout, §5's permission-model and auth-hardening items. **Real patient data is not onboarded until this phase's three hard-blocker items (WhatsApp signature verification, R2 signed URLs, httpOnly-cookie auth) are complete**, per the explicit gate in §22.

**Phase 3 (mobile, weeks 6+)**: §21, once web/API have stabilized enough that `packages/types`/`packages/api-client` are worth sharing.

**Phase 4 (revisit-on-evidence, no committed timeline)**: `leads`/`Lead` table/model rename to `journeys`/`Journey` (deferred in §4 pending evidence it's worth the migration cost once the product term has bedded in); live Meta/Google Ads attribution API integration (§18, deferred pending a tenant that actually needs it); outbound telephony/click-to-call (§17, deferred pending Runo or another provider exposing a usable outbound API and a confirmed customer need); pipeline stage rules/automation beyond the fixed outcome→task mapping (§15, deferred pending evidence the fixed mapping is insufficient); full DPDP compliance program (§22, deferred to a dedicated compliance track, not folded into product engineering).
