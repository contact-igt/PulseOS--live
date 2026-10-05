# CRM configuration · conversation intelligence · appointment WhatsApp — design contract

Status: binding for this module. Extends (does not restart) the stabilization / view-system work.
Principle: PulseOS stays ONE configurable platform. Tenant differences are data (specialty/service
config, CRM fields, outcomes, allocation rules, templates, reminder rules, integrations). Canonical
lifecycle stages, state machines and analytics stay stable and are never tenant-editable.

## 0. Audit result (what already exists, reused)

| Concern | Existing | Gap closed here |
|---|---|---|
| CRM fields | `custom_field_definitions` (per service key; type/options/required/order/archived), `custom_field_values` (per Journey), Settings → service detail, Add Lead, Journey Detail + Patient 360 display | groups, placement, defaults, role visibility, all-services scope, 3 field types, reorder, type-aware server validation, a CRM Configuration section |
| Archive | joins for Journey Detail / Patient 360 do not filter `archived`; Add Lead does | explicit tests + UI wording |
| Outcomes | provider disposition mapping (`connector_disposition_mappings`), doctor consultation outcome | tenant-configurable follow-up outcomes + a capture action (Journey Detail, My Work) |
| Allocation | `journeys.owner_user_id`, manual assign | simple first-match rules applied at Journey creation |
| Messaging | `conversations`, `messages`, adapters (`sendMessage` free text), connector modes FIXTURE/SANDBOX/LIVE | service-window tracking, `sendTemplate`, templates, notifications outbox |
| Scheduler | none (no timers, no queue lib) | durable DB-backed due-job runner, injectable clock |
| LLM | none | `ConversationSummarizer` port; deterministic FIXTURE summarizer; Anthropic adapter behind env |
| Timeline | per-message `whatsapp_message` events | one concise `whatsapp_conversation` event per session; raw messages stay in the conversation |

## 1. CRM fields

Extend `custom_field_definitions` (no second field system):

- `group_key text not null default 'enquiry_details'` — fixed set: patient_information, enquiry_details,
  service_details, qualification, follow_up_details, appointment_details, treatment_context.
- `placements jsonb not null default '["add_lead","journey_detail","patient_360"]'` — subset of
  add_lead | journey_detail | patient_360 | followup_outcome | appointment | treatment. One definition, many places.
- `default_value jsonb null`.
- `visible_to text not null default 'everyone'` — everyone | front_office (admin, front desk, coordinator) |
  clinical (admin, doctor). Enforced server-side in every read that returns field definitions or values.
- `specialty_key = '*'` means "all services"; otherwise one service key.
- Field types: existing TEXT NUMBER DATE BOOLEAN SELECT MULTI_SELECT PHONE + LONG_TEXT EMAIL DATETIME
  (each has a real use: free-text qualification notes, contact email, preferred callback time).
- Values stay Journey-scoped in `custom_field_values`; `placements` decides where a field is captured/shown.
  Immutable system fields (tenantId, ids, provider ids, audit metadata) are not in this table and cannot be configured.
- Key and type are immutable once a value exists. No hard-delete endpoint: `archived` hides a field from new
  entry forms; historical values stay visible on Journey Detail / Patient 360 (tested).
- Server validation by type: number numeric, email shape, phone E.164-ish, date/datetime parseable, select /
  multi-select values must be among options, boolean boolean; required enforced for fields active in the
  placement being saved.
- API: `GET/POST /crm/fields`, `PATCH /crm/fields/:id`, `POST /crm/fields/reorder`, permission MANAGE_SPECIALTIES.
  Read for entry forms: `GET /crm/fields/for?placement=&specialtyKey=` (any role; filtered by scope, placement,
  archived, visibility). Existing `/specialties/:key/fields` keeps working (now scope/visibility aware).

## 2. Outcomes (sub-status / disposition / follow-up reason)

Canonical stages are not editable. Table `crm_outcomes` (tenant, key, label, `stage` ∈ contacted | lost,
`requires_follow_up`, `allows_appointment`, `asks_reason`, `sort_order`, `archived`). Seeded defaults:
Interested, Needs callback (requires follow-up), Price enquiry, Needs reports, Discussing with family
(requires follow-up), Appointment booked (allows appointment), No answer (requires follow-up), Not interested
(asks reason; stage lost). Rules are a fixed trio of booleans — no expression language.

`POST /journeys/:id/interactions` `{ outcomeKey, note?, reason?, followUpAt?, taskId?, fieldValues? }` (MANAGE_TASKS):
validates the outcome and its rule, completes the optional task, creates the follow-up Task when required (the
existing Task system — no FollowUp table), moves the Journey forward only (enquiry → contacted, → lost),
stores `journeys.last_outcome_key`, writes one Timeline event. UI: "Log outcome" on Journey Detail and on
My Work task rows; Settings → Workflow Outcomes.

## 3. Allocation rules

Table `allocation_rules` (tenant, name, `sort_order`, match: source?, specialty_key?, journey_type?, branch_id?;
target pool of user ids; `rr_cursor`; enabled). First enabled match by order assigns `journeys.owner_user_id`
(round-robin inside the pool). Applied in the two creation paths (Add Lead, lead ingestion) only when no owner
was supplied. Manual assignment/reassignment unchanged. Settings → Allocation Rules.

## 4. Conversation sessions and summaries

- `tenant_settings` (1:1 tenant): `conversation_idle_minutes` default 7, allowed 5–10 (API clamps with 400).
- `conversations`: `summary_due_at`, `summary_state` (idle | processing), `summary_attempts`,
  `summary_claimed_at`, `last_patient_inbound_at`. Every patient or staff message sets
  `summary_due_at = message time + idle window` (debounce). The DB value is the only source of truth.
- Runner `processDueConversationSummaries(db, now)` claims with a conditional UPDATE (idempotent claim,
  stale claims reclaimed after 10 min), summarizes only messages after the last summarized message,
  inserts one `conversation_summaries` segment (unique on conversation + last message), clears the due time
  unless newer messages arrived. Failure: state back to idle, attempts + 1, backoff; raw thread untouched.
- `conversation_summaries`: tenant, conversation, patient, journey, segment_no, first/last message id and
  time, message_count, summary, patient_intent, service_interest, questions[], outcome, promised_action,
  next_action, generated_at, provider, mode (AI | PROVIDER | FIXTURE | MANUAL). Derived data; raw messages
  authoritative; never stored in the hospital knowledge base. Every read scopes by tenant + conversation
  (+ patient).
- Summarizer port `ConversationSummarizer`; FIXTURE implementation is deterministic and labelled FIXTURE;
  Anthropic adapter used only when `PULSEOS_LLM_PROVIDER=anthropic` and a key is present (mode AI). Prompt and
  output schema forbid diagnosis / clinical advice / eligibility; output is zod-validated.
- Timeline: one `whatsapp_conversation` event per session (title "WhatsApp conversation", count and time
  range, summary text once generated, link to the conversation). Per-message events are no longer written.
- UI: Inbox conversation summary panel (intent, outcome, next action, updated at, mode badge; "Refresh summary"
  only when new messages exist); Journey Detail / Patient 360 timeline card.

## 5. Appointment WhatsApp

- `message_templates` (tenant, type: appointment_confirmation | reminder | rescheduled | cancelled, provider
  template name, language, preview body with variables, `approved` flag set by the admin after approval in the
  WhatsApp Manager, enabled). Variables: patient first name, doctor, service, date, time, branch, contact.
  No clinical PHI.
- `reminder_rules` (tenant, name, trigger: on_confirmed | before_appointment, offset_minutes, template type,
  enabled). Demo defaults: confirmation on booking, reminders at 24 h and 2 h.
- `appointment_notifications` (outbox): tenant, appointment, patient, journey, type, rule, `scheduled_for`,
  status (scheduled | processing | sent | delivered | read | failed | blocked | cancelled | skipped),
  `blocked_reason` (template_required | provider_unavailable | no_phone | no_consent), unique
  `idempotency_key` (`appt:{id}:{type}:{ruleId|-}:{scheduledAt epoch}`), provider mode snapshot,
  provider message id, message id, timestamps. Written in the SAME transaction as the appointment
  mutation; sending happens after commit (immediate dispatch + runner for retries/schedules) — nothing is sent
  for a rolled-back write. A retried mutation hits the unique key and does not double-send.
- Policy: proactive/scheduled messages always use an approved template. Free-form is never used for
  reminders. No approved template → `blocked / template_required`, shown as "Template required", never fake
  success. `conversations.last_patient_inbound_at` + 24 h = `serviceWindowExpiresAt` (returned with the
  conversation and appointment notification view; free-form replies by staff remain governed by it).
- Reschedule → pending notifications for the old time are cancelled (superseded), new ones scheduled, a
  "rescheduled" message queued if a template is configured. Cancel → scheduled reminders cancelled.
  Past-due reminders at booking time are `skipped`. Instants are absolute; date/time text is rendered in the
  hospital timezone.
- Provider honesty: `FIXTURE | SANDBOX | LIVE_CAPABLE | LIVE_CONFIGURED | BLOCKED` derived from the connector
  (mode, status, secrets, SEND_TEMPLATE). The UI states the mode; "sent" is only recorded from the adapter
  response; fixture sends are labelled fixture.
- Replies: template quick-reply payloads `appt:{id}:confirm|reschedule|call`. Confirm → existing `confirm`
  action (+ timeline "Patient confirmed"); Reschedule → attention Task + timeline, never auto-reschedules;
  Call → Task. Mapped to conversation, patient, journey, appointment.
- Timeline gets only: Appointment booked, WhatsApp confirmation sent, Patient confirmed, Reminder sent,
  Patient requested reschedule. Provider delivery webhooks update the notification and message only.
- API: `GET /appointments/:id/notifications`, `POST /appointments/:id/notifications/send`
  `{ type }` (send / resend confirmation or reminder), `POST /appointment-notifications/:id/cancel`;
  permissions VIEW_APPOINTMENTS / MANAGE_APPOINTMENTS. Settings → Messaging Templates, Reminder Rules.

## 6. Cross-cutting

- Every table carries `tenant_id`; every read/write derives it from the session; foreign ids from the request
  are verified against the tenant.
- Controllable clock: runners take `now`; no domain code reads the wall clock without it.
- Non-goals: no workflow engine, no expression language, no BPMN, no second CRM, no separate follow-up engine,
  no per-tenant stage editing.
