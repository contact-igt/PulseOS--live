# PulseOS — Complete Product and Engineering Knowledge Transfer

Prepared: 17 November 2026. Source checkout: `C:\Invictus_Projects\PulseOS--live`; inspected HEAD: `ab26917`.

## 1. How to use this document with ChatGPT

Upload this file as project knowledge or paste it into a new conversation. It describes the checked-out implementation, its operating rules, feature coverage, integration boundaries, and source locations. Use the companion `WHATSNEXUS_AND_SUPER_ADMIN_KNOWLEDGE_TRANSFER.md` for the messaging platform and its platform administration.

**Evidence level:** static inspection of source, package manifests, schema, test inventory and existing implementation reports. No application tests, database queries, migrations, seeds, production login, deployment or live provider checks were run for this documentation task. A feature listed as implemented means code exists; it does not certify that a particular deployed hospital has it enabled or working. Earlier audit results remain historical evidence, not fresh test results. No private `.env` values, patient records or credentials are included.

When answering future questions: prefer current source over old plans, keep Patient and Journey separate, enforce tenant isolation and server permissions, and distinguish enabled, configured, healthy, fixture and live states. Never infer production connectivity from a capability switch or passing mocked test.

## 2. Product purpose and boundaries

PulseOS is the **Patient Engagement and Revenue Intelligence Operating System for Indian hospitals**. Its operational promise is to connect every enquiry, conversation, appointment, consultation, treatment and follow-up into one continuous patient journey, with source attribution and revenue context where enabled.

The daily loop is: enquiry → patient identity → service journey → contact and follow-up → appointment → check-in/waiting → consultation → treatment decision → scheduled treatment → completion → post-care and next action. Marketing context follows this loop: original source, campaign touchpoints, spend, conversion and attributed revenue.

It is a hospital engagement and operations product, rather than a complete clinical EMR/HIS. External messaging, telephony, advertising, LLM, storage and HIS systems belong behind adapters. PulseOS owns its Patient, Journey, Timeline, Task, Appointment, Consultation Outcome, Treatment Opportunity, Revenue Event, Campaign, Consent, CRM configuration and audit records.

### Essential domain distinctions

| Concept | Meaning and behavior |
|---|---|
| Patient | One person. Phone normalization and tenant-scoped identity resolution prevent formatting differences from creating duplicate identities. |
| Journey | One service enquiry/operational path for that person. A patient may have multiple concurrent journeys. Never implement Journey as a renamed Lead. |
| Lead workspace | Operational acquisition/enquiry view over patients and journeys, with intake, filters, editing and next actions. |
| Journey stage | Persisted progression through the hospital workflow; exact schema values appear below. |
| Operational status | Derived from visit, treatment and task evidence, such as waiting, with doctor, no-show or procedure scheduled. It is distinct from stage. |
| Task / Next Action | Durable work item: callback, follow-up, appointment risk, treatment decision or post-care. Completing a task and sending a message are separate actions. |
| Appointment | A visit with lifecycle transitions, branch, resource/doctor and timestamps. |
| Treatment | A procedure/treatment opportunity, decision and scheduling lifecycle linked to a journey. |
| Revenue event | Operational attribution record, not proof of bank settlement. Completion can create revenue from estimated treatment value. |
| Source vs interaction | Original acquisition source is not the same as a later call or WhatsApp interaction. Later contact must not casually overwrite original source. |

Source: `CLAUDE.md`, `apps/api/src/db/schema.ts`, `apps/api/src/domain/{patient,journey,lead,appointment,treatment,task}`.

## 3. Architecture and stack

One modular monolith API plus a Next.js web application in a pnpm/Turborepo monorepo. Node 24 and pnpm 9.15.0 are repository requirements. PostgreSQL 16 is the documented database target.

| Area | Implementation |
|---|---|
| Web | Next.js 16, React 19, strict TypeScript, App Router, Tailwind 4, Radix, Lucide, TanStack Query/Table, React Hook Form, Zod, Recharts |
| API | Fastify 5, strict TypeScript, Zod, Drizzle ORM, PostgreSQL; domain services and route modules |
| Auth | Argon2id password hashes; opaque database sessions and httpOnly cookie; no browser-storage auth token |
| Shared packages | `types`, `validation`, `api-client`, `ui`, `design-tokens` |
| Testing | Vitest unit/integration suites and Playwright E2E |
| Build coordination | Root scripts invoke Turbo across workspaces |

Data flow: browser → shared API client → Fastify session authentication → role/capability gates → tenant-scoped domain service → Drizzle/PostgreSQL. Background work handles domain events, notification planning, reconciliation, connector events, ads synchronization and webhook delivery.

The project was built as a new PulseOS codebase. Legacy WhatsNexus/Lead Panel repositories were reference material; they are not imported wholesale or required at runtime. `CLAUDE.md` records locked architecture and security decisions.

## 4. Feature coverage by product area

| Area | Available implementation | Important conditions |
|---|---|---|
| Sign-in and signup | Generic login, tenant-branded login, remember me, logout, hospital signup, development-only demo login | Development login is restricted and must stay off on shared/production servers. |
| Hospital workspaces | Tenants, branches, profile, login branding, edition and capability overrides | Session-derived tenant identity is authoritative. |
| Command Centre | Admin/owner overview, Performance, operational reporting, date/branch/service filters, hospital-day metrics | Revenue/marketing widgets depend on capabilities. |
| Lead operations | Add/edit enquiry, source, service, owner, stage, priority, filters, follow-up context, multiple operational views | Safe source correction is role-restricted; source and identity handling are domain rules. |
| Patient directory and 360 | Patient record, multiple journeys, timeline, upcoming activity, communication and financial context | Visibility follows role and tenant boundary. |
| Journey detail | Service path, original source, ownership, stage, next action, progress, timeline and workflow actions | Ambiguous multi-journey communication must not be guessed. |
| My Work | Today/overdue/upcoming/completed follow-ups, callbacks, appointment-risk tasks and unassigned queue | Staff without task-management permission are scoped to their own tasks; managers can assign unowned work. |
| Calls | Manual logging, telephony webhook ingestion, missed-call callback creation, recording/transcript and call intelligence | Runo/provider configuration needed for real ingestion; sensitive recording/transcript permissions differ from ordinary call logging. |
| Appointments | Booking, confirmation, rescheduling, cancellation, check-in, waiting, with doctor, completion and no-show workflows | State transitions and appointment resources are enforced server-side. |
| Front Desk | Daily patient flow and visit queue operations | Hospital timezone defines the day. |
| Doctor Home | Doctor queue, completing own consultation, recording operational outcomes | Doctor ownership rules apply; this is not a full clinical chart. |
| Consultation outcomes | No-treatment/review/procedure advice/decision pending/declined paths produce or reuse appropriate treatment/task records | Avoid duplicate open work; scheduling is its own workflow. |
| Treatments | Advice and decisions, procedure scheduling, status updates, completion and post-care | Completion revenue is an attribution estimate unless reconciled externally. |
| WhatsApp Inbox | Conversations/messages, endpoint filtering, patient/journey context, sending and ownership/session context | `WHATSAPP_INBOX` capability and configured provider required. |
| Conversation intelligence | Session grouping and summarization, fixture and Anthropic summarizer implementations | Capability depends on Inbox; external LLM configuration needed for real model output. |
| Notifications | Durable rules/templates, confirmations/reminders, reconciliation, delivery tracking and suppression | Separate capability from Inbox; approved provider templates and credentials required. |
| Campaigns and marketing | Campaigns, acquisition touchpoints, costs, source performance, spend at risk, attributed outcomes | Marketing and spend/revenue capability gates apply. |
| Ads and acquisition | Google/Meta reporting adapters, lead-form ingestion, GBP performance, conversion feedback modules | Source code supports integration, but live accounts/scopes and verification are separate. |
| Website Leads | Form configuration, intake token, origin validation, ingestion, identity/journey handling, rejection/audit support | A hospital website must actually post to the configured endpoint. |
| Integration Hub | Provider catalogue, config/secrets, capabilities, modes, health and event/retry visibility | Enabled, configured and healthy are separate facts. |
| CRM configuration | Custom fields/values/order, lead sources, workflow outcomes, follow-up types and allocation rules | Some stored field placements have no capture screen; do not assume every placement is operational. |
| Hospital setup | Services/treatment catalogue, departments, doctors/resources, clinic hours | Ophthalmology and gynecology templates exist. |
| Appearance | Hospital surface style and personal interface/text size | Shared tokens and CSS must remain synchronized. |
| Reports | Operations/performance reporting and Excel exports | `EXPORT_REPORTS` controls row-level data leaving the system. |
| Activity/audit | Recorded settings changes, integration events, exports and safe metadata | Secrets must be redacted; UI activity feed is not automatically a complete forensic audit. |

Implementation navigation: `apps/web/app/(app)`, `apps/api/src/domain`, shared `packages/*`. The appendices give concrete pages and routes.

## 5. Roles and the meaning of Super Admin

Stored roles: `SUPER_ADMIN`, `HOSPITAL_ADMIN`, `FRONT_DESK`, `PATIENT_COORDINATOR`, `DOCTOR`. V1 wording groups front desk/coordinator as Staff and hospital admin as Admin. Owner is product wording in pilot documents; it is not an additional stored role.

**PulseOS SUPER_ADMIN is tenant-bound in the inspected implementation.** It is a highly privileged hospital user, with a `tenantId` in its session. Do not claim there is a WhatsNexus-style independent cross-tenant management console, SaaS subscription control plane or platform billing suite in PulseOS merely because this role exists. Signup creates the first hospital Super Admin alongside its tenant, branch, profile and login configuration.

| Role | Principal responsibility |
|---|---|
| Super Admin | Hospital operations plus secrets, capability control and advanced configuration. |
| Hospital Admin | Hospital oversight, reports, settings, integration configuration, recording/transcript access; not all secret/capability powers. |
| Front Desk | Patient intake, leads, appointments, inbox, tasks and call logging. |
| Patient Coordinator | Journey progression, follow-ups, treatment coordination and operational revenue visibility where enabled. |
| Doctor | Own queue/consultation actions, patient/journey viewing, treatment viewing and own work. |

The exact permission matrix is reproduced from `packages/types/src/index.ts` in the appendix. UI hiding is a convenience; `requirePermission` and `requireCapability` enforce the API. Permission approval does not bypass tenant filtering or ownership restrictions. A disabled capability returns `feature_not_available`; lack of role permission returns `forbidden`.

## 6. Editions and capabilities

Two edition identifiers exist: `BETA_V1_CORE` and `BETA_V2_GROWTH`. Edition selects a default capability bundle. Runtime resolution applies `tenant_capabilities` overrides and supplies the result in the session.

Capabilities: `ANALYTICS_CORE`, `MARKETING_ANALYTICS`, `GOOGLE_ADS`, `META_ADS`, `RUNO_CALLING`, `CCS_IVR`, `WHATSAPP_NOTIFICATIONS`, `WHATSAPP_INBOX`, `CONVERSATION_INTELLIGENCE`, `SMS_NOTIFICATIONS`, `CAMPAIGNS`, `SPEND_ATTRIBUTION`, `REVENUE_TRACKING`.

Core analytics is locked on. Conversation Intelligence requires Inbox. Google/Meta Ads, Campaigns and Spend Attribution require Marketing Analytics. Super Admin can manage the broad capability set; hospital admins have the documented notification switches. Capability changes are serialized and recorded. Turning on CCS/SMS does not create a working provider.

V1 defaults include core analytics, Runo, CCS, WhatsApp notifications and revenue tracking. V2 defaults add growth/marketing/inbox/intelligence capabilities. **Namokar specifically overrides revenue tracking off**, so it must not show revenue, payments or ROAS figures. Edition labels alone do not establish actual capability settings.

Source: `packages/types/src/index.ts`, `domain/capability`, `docs/m7-capabilities-integrations.md`.

## 7. Patient workflow details and invariants

1. Intake normalizes the phone and resolves a patient within the hospital; a new service enquiry can create another journey.
2. Record original source at journey creation. A later call or website submission adds history rather than blindly changing acquisition provenance.
3. Contact attempts and follow-ups create actionable work. Next Action exposes what staff should do next.
4. Booking creates a visit. Confirmation means the patient agreed; it is distinct from merely having a booked record.
5. In the Namokar workflow, Confirm plans one confirmation message and a reminder one hour before the visit. Repeating confirmation must not duplicate delivery.
6. Rescheduling cancels pending reminder work and returns the visit to booked until reconfirmed. Cancel/no-show/completion cancel pending reminders. Expired reminder times are suppressed.
7. Front desk moves the person through check-in, waiting and with-doctor states. Doctor completes their own consultation and records an outcome.
8. A review outcome produces/reuses a follow-up; procedure advice produces/reuses treatment; deciding also creates a decision follow-up. Decline does not automatically close the whole journey.
9. No-show creates one appointment-risk follow-up rather than repeated duplicates. Rebooking changes the operational state.
10. Treatment scheduling records the planned procedure with branch/doctor/date. Completion may create one idempotent revenue event and post-care work.

Operational status is derived, with precedence documented in `docs/namokar/NAMOKAR_PILOT_WORKFLOW.md`: closed status, in-clinic state, procedure state, booked/confirmed visit, treatment follow-up, then latest closed visit. Exact code is authoritative if pilot prose differs.

WhatsApp journey linking: preserve an existing association; with no active journey keep patient-level context; with exactly one use it; with several leave `journeyId` unresolved unless deterministic evidence exists. Never pick an arbitrary active journey.

Task visibility: non-managers are constrained to their own tasks server-side; manager roles have team/unassigned visibility and can claim work. Test files cover cross-staff and cross-tenant access.

## 8. Marketing and revenue definitions

- Cost per outcome = eligible campaign spend / outcome count; a zero denominator produces `null`, displayed as a dash.
- ROAS = attributed revenue / marketing spend; no valid spend denominator means no ROAS number.
- Allocated acquisition cost = campaign spend / campaign enquiry count, applied as an approximation to enquiries.
- Spend At Risk refers to allocated spend on recoverable active/stalled journeys. It must not be called Marketing Waste.
- Confirmed marketing leakage is the concept for definitively lost journeys.
- Provider-reported ad conversions are distinct from PulseOS consultations/treatments. Do not mix them as identical outcomes.
- Treatment-completion revenue can use `estimatedValue` with `sourceSystem: treatment_completion`; this is not evidence that cash was collected.

Source: `domain/marketing/formulas.ts`, campaign/acquisition/ads services and treatment revenue tests. Attribution requires identifiable campaign/journey links and valid denominators. Failed syncs should preserve previous snapshots rather than imply zero activity.

## 9. Integrations and real-world readiness

| Integration | Code/readiness assessment |
|---|---|
| WhatsNexus | Provider adapter, pairing, authenticated health/templates/send/status lookup, signed callback handling and integration tests exist. WhatsNexus owns Meta delivery, template approval and wallet charging; PulseOS owns hospital workflow. |
| Meta WhatsApp Cloud | Messaging/template/webhook adapter exists; real WABA/token/templates/webhook setup needed. |
| Runo | Call adapter/webhooks and missed-call handling exist; real provider credentials/webhook traffic needed. Completed-call data does not imply live agent presence. |
| CCS IVR | Explicit blocker in capability/integration documentation: provider API and auth/webhook specification still required. Presence of a scaffold file is not usable live support. |
| SMS | Capability exists; documented provider selection/implementation remains blocked. |
| Google/Meta advertising | Read-only ads reporting, sync facts and lead-form adapters; real account authorization and provider verification needed. |
| Google Business Profile | Performance adapter/service exists; real property connection required. |
| Website Leads | Native form intake plus configuration and audit tools; needs actual website wiring, token and valid service/source mapping. |
| LLM | Fixture summarizer and Anthropic summarizer; real model use depends on configuration. |
| Outbound webhooks | Configuration, deliveries, retry/state and URL validation modules exist; destination approval/configuration still required. |

Hub modes include fixture, sandbox, live-capable, configured live, not configured, disabled and blocked. A health badge should follow actual evidence; changing credentials/mode resets health. Static review did not determine current production connections.

### WhatsNexus contract

Machine API base: `/api/integrations/pulseos`. Requests use `X-Tenant-Id` and `X-Api-Key`, optional PulseOS tenant binding and idempotency identifiers. Human management JWTs are a different credential system. Pairing exchanges a short-lived code for binding-specific credentials. Send, lookup and signed callbacks distinguish accepted, retryable failure, permanent failure and unknown outcome. Unknown outcome requires reconciliation; blind resends can duplicate a real patient message. URL and public-address validation prevent secret-bearing calls to untrusted/private destinations; redirects are not followed automatically.

## 10. Namokar pilot and demos

Namokar Eye & Oculoplasty Centre has separate V1 Demo and V2 Pilot workspaces. Current routing documentation identifies `/login/namokar-v1` and `/login/namokar-v2`; legacy `/login/namokar` redirects to V1. Do not confuse the word V2 in a pilot workspace name with the growth edition bundle without reading tenant capabilities.

Namokar configuration: revenue off, owner Performance focus, notifications independent of Inbox, Inbox off for the pilot. Integration status documentation says the V1 Demo uses fixtures while V2 Pilot starts not configured; this describes repository seed/document intent, not a live database check.

Other documented demos include Ophthalmology V1, Ophthalmology V2 and Gynecology, with role-specific accounts and a local `DEMO_PASSWORD`. Never paste actual passwords into a knowledge document. Read `docs/demo-environments.md` and all `docs/namokar` SOP, role, workflow, notification reliability, security and go-live documents for operational onboarding.

## 11. Login, configuration and security

Each hospital uses `/login/<slug>` through a shared server-rendered branding route. The public branding endpoint returns safe display data; not tenant IDs, users, credentials or capabilities. Logos must be approved local `/brand/` assets; unknown workspaces return 404. Login derives tenant identity from the validated server-side slug, not a posted `tenantId`. Signup generates a unique slug and creates the first hospital Super Admin transactionally. Ophthalmology/gynecology templates can be installed; other signup categories need not have a complete operational template.

Remember me uses a seven-day server session and persistent httpOnly cookie; ordinary sessions are twelve hours with a session cookie. Logout and expiry return users to their own branded login. Developer access belongs only on the internal login and must be disabled outside local development.

Security rules: session-derived tenant scope; backend role/capability checks; ownership checks for doctor/task actions; Argon2id; encrypted connector secrets; safe logs; validated webhook origins/addresses; no secrets or real patient data in demos or commits. `SESSION_SECRET` appears in setup examples, but an older audit found it unused because sessions are opaque DB records; do not represent it as a verified active signing control without rechecking source.

## 12. Local setup and maintenance

```powershell
pnpm install
# Create apps/api/.env using apps/api/.env.example and supply local values.
# Create apps/web/.env.local with NEXT_PUBLIC_API_URL=http://localhost:4310
pnpm db:migrate
pnpm db:seed
pnpm dev
```

These are documented setup commands, **not executed in this review**. Seed is for approved local/demo databases and must not be run casually against production. API default port is 4310; web documented port is 3310. Confirm actual running ports before giving a live URL. Health path: `/health`.

Required configuration concepts: `DATABASE_URL`, `CONNECTOR_ENCRYPTION_KEY`, local `DEMO_PASSWORD`, `PORT`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`; optional public API URL and reverse-proxy trust settings affect website intake and callbacks. All `NEXT_PUBLIC_*` values are browser-visible. Provider secrets belong server-side in connector storage, not public frontend variables. Keep the encryption key stable across restarts or existing encrypted provider credentials may become unreadable.

**Documentation discrepancy found:** README instructs copying `apps/web/.env.example`, but that file is absent in the inspected checkout. Create the local web env file explicitly instead of relying on that copy command. API `.env.example` is present. Private active `.env` content was not copied or disclosed.

Checks available: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`. Playwright lives under `apps/web/e2e` and requires running services, seeded local data, demo password and suitable `E2E_DATABASE_URL`. Fixture tests do not contact real providers. A previous audit passing does not substitute for a new check on a changed checkout.

Other operations: `pnpm --filter @pulseos/api staff:add`, `audit:website-intake`, Drizzle migration/generation scripts. Read their implementation before using against a database. No deployment was performed for this task; repository rules require explicit authorization for remote deployment.

## 13. UI principles and configuration surfaces

Blue/white healthcare branding, dense operational screens, selective glass on shell/control surfaces and solid data panels. Shared TypeScript tokens and CSS theme values must match. Brand is the journey-line P mark with BETA. Functional short motion respects reduced motion; no decorative dashboard animation is needed.

Settings sections: Services, Departments, CRM Fields, Lead Sources, Workflow Outcomes, Follow-up Types, Doctors, Clinic Hours, Allocation Rules, Features, Appearance, Activity. Integrations/connector settings have separate routes/panels. Hospital surface style supports airy/balanced/solid; personal interface and text sizing are independent preferences.

Tenant login does not include arbitrary HTML/CSS, page builders, custom colors, SSO, domain mapping or white-label email. A branding editor screen is explicitly not built; data/seed config supplies the words.

## 14. Known limits and future-work boundaries

- No inspected independent platform-wide SaaS Super Admin console for PulseOS.
- No evidence from this task of production provider delivery, real deployment health or real hospital data correctness.
- CCS/SMS and live telephony presence remain blocked/deferred as documented.
- Stored custom-field placement metadata is not proof that appointment/treatment capture forms exist for it.
- Lead column preference is per-person/browser, not an organization-wide server policy.
- Hospital day-level reporting does not imply sub-day custom date-time reporting.
- Clinical records, settlement accounting, insurance and a full HIS are outside the verified scope.
- Historical plans may describe superseded architecture, styling or status. Prefer checked-out services, types, schema and newest relevant operational documents.

## 15. Primary reading map

Start with `README.md`, `CLAUDE.md`, `packages/types/src/index.ts`, `apps/api/src/db/schema.ts`, `apps/api/src/server.ts`, `apps/api/src/app.ts` if present, `packages/api-client/src/index.ts`, and the page/domain indexes below. Feature documents: `docs/m7-capabilities-integrations.md`, `docs/tenant-branded-login.md`, `docs/website-leads-webhook-integration-report.md`, `docs/namokar/*`. Historical evidence: `docs/audits/*`. Proposed designs/execution history: `docs/superpowers/specs/*` and `docs/superpowers/plans/*`.

## 16. Exact source appendices

These appendices are generated from this checkout. Route strings can be relative to module registration prefixes; read registration and middleware before calling an endpoint. This path index does not assign per-route gates: shared hooks and upstream middleware can apply.

### Database tables

- `tenants` — exported as `tenants`
- `tenant_profiles` — exported as `tenantProfiles`
- `tenant_login_configs` — exported as `tenantLoginConfigs`
- `tenant_capabilities` — exported as `tenantCapabilities`
- `branches` — exported as `branches`
- `users` — exported as `users`
- `sessions` — exported as `sessions`
- `patients` — exported as `patients`
- `departments` — exported as `departments`
- `lead_sources` — exported as `leadSources`
- `crm_outcomes` — exported as `crmOutcomes`
- `allocation_rules` — exported as `allocationRules`
- `journeys` — exported as `journeys`
- `followup_types` — exported as `followUpTypes`
- `tasks` — exported as `tasks`
- `schedule_resources` — exported as `scheduleResources`
- `appointments` — exported as `appointments`
- `marketing_campaigns` — exported as `marketingCampaigns`
- `campaign_touchpoints` — exported as `campaignTouchpoints`
- `conversion_feedback_events` — exported as `conversionFeedbackEvents`
- `consultation_outcomes` — exported as `consultationOutcomes`
- `treatment_opportunities` — exported as `treatmentOpportunities`
- `revenue_events` — exported as `revenueEvents`
- `timeline_events` — exported as `timelineEvents`
- `conversations` — exported as `conversations`
- `conversation_automation_preferences` — exported as `conversationAutomationPreferences`
- `tenant_settings` — exported as `tenantSettings`
- `messages` — exported as `messages`
- `message_attachments` — exported as `messageAttachments`
- `conversation_summaries` — exported as `conversationSummaries`
- `connectors` — exported as `connectors`
- `communication_endpoints` — exported as `communicationEndpoints`
- `gbp_performance_metrics` — exported as `gbpPerformanceMetrics`
- `connector_secrets` — exported as `connectorSecrets`
- `connector_events` — exported as `connectorEvents`
- `connector_disposition_mappings` — exported as `connectorDispositionMappings`
- `connector_config_audit_events` — exported as `connectorConfigAuditEvents`
- `calls` — exported as `calls`
- `call_intelligence` — exported as `callIntelligence`
- `specialty_templates` — exported as `specialtyTemplates`
- `custom_field_definitions` — exported as `customFieldDefinitions`
- `treatment_definitions` — exported as `treatmentDefinitions`
- `custom_field_values` — exported as `customFieldValues`
- `outbound_webhooks` — exported as `outboundWebhooks`
- `outbound_webhook_deliveries` — exported as `outboundWebhookDeliveries`
- `message_templates` — exported as `messageTemplates`
- `notification_rules` — exported as `notificationRules`
- `notifications` — exported as `notifications`
- `ads_daily_facts` — exported as `adsDailyFacts`
- `ads_sync_runs` — exported as `adsSyncRuns`
- `activity_log` — exported as `activityLog`

### Persisted enums / lifecycle states

- `role`: `SUPER_ADMIN`, `HOSPITAL_ADMIN`, `FRONT_DESK`, `PATIENT_COORDINATOR`, `DOCTOR`
- `tenant_edition`: `BETA_V1_CORE`, `BETA_V2_GROWTH`
- `source_channel`: `meta`, `google`, `website`, `whatsapp`, `phone`, `walk_in`, `referral`, `organic`, `other`
- `interaction_channel`: `IVR_CALL`, `MANUAL_CALL`, `WHATSAPP`, `INSTAGRAM_DM`, `FACEBOOK_DM`, `WALK_IN`
- `journey_stage`: `enquiry`, `contacted`, `booked`, `attended`, `consulted`, `treatment_advised`, `scheduled`, `completed`, `lost`
- `task_priority`: `normal`, `high`
- `task_status`: `pending`, `in_progress`, `completed`, `cancelled`
- `task_reason`: `overdue_callback`, `missed_follow_up`, `no_show`, `high_intent_uncontacted`, `treatment_decision_pending`, `manual_task`, `new_lead`
- `task_type`: `CALLBACK`, `FOLLOW_UP`, `APPOINTMENT_CONFIRMATION`, `NO_SHOW_RECOVERY`, `TREATMENT_DECISION`, `POST_CARE`, `RECALL`, `OTHER`
- `followup_default_owner`: `JOURNEY_OWNER`, `ACTOR`, `UNASSIGNED`
- `appointment_status`: `requested`, `scheduled`, `confirmed`, `checked_in`, `waiting`, `with_doctor`, `completed`, `no_show`, `cancelled`
- `campaign_status`: `active`, `paused`, `ended`
- `touch_type`: `first_touch`, `last_touch`
- `conversion_feedback_event_type`: `QUALIFIED_ENQUIRY`, `APPOINTMENT_BOOKED`, `APPOINTMENT_ATTENDED`, `CONSULTATION_COMPLETED`, `TREATMENT_ADVISED`, `TREATMENT_COMPLETED`, `REVENUE_RECORDED`
- `consultation_outcome_type`: `CONSULTED`, `TREATMENT_ADVISED`, `NO_TREATMENT_REQUIRED`, `DECISION_PENDING`, `FOLLOW_UP_REQUIRED`, `REFERRED`, `OTHER`, `TREATMENT_DECLINED`
- `treatment_status`: `ADVISED`, `DECISION_PENDING`, `ACCEPTED`, `SCHEDULED`, `COMPLETED`, `DECLINED`, `CANCELLED`, `LOST`
- `revenue_event_type`: `consultation_fee`, `treatment_payment`, `other`
- `actor_type`: `system`, `ai`, `user`
- `conversation_channel`: `WHATSAPP`, `CALL`, `SMS`, `EMAIL`, `INTERNAL`
- `ownership_state`: `AI_ACTIVE`, `HUMAN_REQUIRED`, `HUMAN_ASSIGNED`, `HUMAN_ACTIVE`, `AI_RESUME_PENDING`, `CLOSED`
- `conversation_automation_mode`: `manual`, `ai_when_available`, `ai_scheduled`
- `message_sender`: `patient`, `staff`, `ai`, `system`
- `message_delivery_status`: `queued`, `sent`, `delivered`, `read`, `failed`
- `message_attachment_kind`: `image`, `document`, `audio`, `video`
- `connector_type`: `MESSAGING`, `TELEPHONY`, `ADS`, `EMAIL`, `STORAGE`, `HIS`, `ACQUISITION`
- `connector_status`: `NOT_CONFIGURED`, `CONNECTING`, `CONNECTED`, `DEGRADED`, `ERROR`, `DISABLED`
- `connector_mode`: `FIXTURE`, `SANDBOX`, `LIVE`
- `connector_capability`: `SEND_MESSAGE`, `RECEIVE_MESSAGE`, `RECEIVE_STATUS`, `INITIATE_CALL`, `RECEIVE_CALL_EVENT`, `FETCH_RECORDING`, `RECEIVE_RECORDING`, `RECEIVE_TRANSCRIPT`, `RECEIVE_LEAD`, `SYNC_CAMPAIGNS`, `SYNC_AD_GROUPS`, `SYNC_ADS`, `SYNC_SPEND`, `SYNC_PERFORMANCE`, `RECEIVE_FORM`, `EXPORT_CONVERSION`
- `communication_endpoint_type`: `PHONE`, `WHATSAPP`
- `connector_event_direction`: `inbound`, `outbound`
- `connector_event_status`: `received`, `processed`, `failed`, `duplicate`
- `disposition_action`: `CREATE_CALLBACK_TASK`, `ADVANCE_JOURNEY_STAGE`
- `connector_audit_action`: `CREATE`, `UPDATE`, `DELETE`
- `call_direction`: `inbound`, `outbound`
- `call_status`: `completed`, `missed`, `no_answer`, `busy`, `failed`
- `call_origin`: `IVR`, `MANUAL`
- `call_intel_status`: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `NOT_CONFIGURED`
- `custom_field_type`: `TEXT`, `NUMBER`, `DATE`, `BOOLEAN`, `SELECT`, `MULTI_SELECT`, `PHONE`, `LONG_TEXT`, `EMAIL`, `DATETIME`
- `field_origin`: `SYSTEM`, `TEMPLATE`, `CUSTOM`

### Exact role-permission matrix

```typescript
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    "VIEW_ADMIN_COMMAND_CENTRE", "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "MANAGE_JOURNEYS",
    "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "RECORD_CONSULTATION_OUTCOME", "VIEW_TREATMENT", "MANAGE_TREATMENT",
    "VIEW_REVENUE", "VIEW_MARKETING", "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS",
    "VIEW_INTEGRATIONS", "MANAGE_INTEGRATION_CONFIG", "MANAGE_INTEGRATION_SECRETS", "VIEW_CALL_RECORDING", "DOWNLOAD_CALL_RECORDING", "VIEW_CALL_TRANSCRIPT", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS", "MANAGE_SPECIALTIES", "EXPORT_REPORTS",
  ],
  HOSPITAL_ADMIN: [
    "VIEW_ADMIN_COMMAND_CENTRE", "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "MANAGE_JOURNEYS",
    "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "VIEW_TREATMENT", "MANAGE_TREATMENT",
    "VIEW_REVENUE", "VIEW_MARKETING", "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS",
    "VIEW_INTEGRATIONS", "MANAGE_INTEGRATION_CONFIG", "VIEW_CALL_RECORDING", "DOWNLOAD_CALL_RECORDING", "VIEW_CALL_TRANSCRIPT", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS", "MANAGE_SPECIALTIES", "EXPORT_REPORTS",
  ],
  FRONT_DESK: [
    "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS",
    "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS",
  ],
  PATIENT_COORDINATOR: [
    "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "MANAGE_JOURNEYS", "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS",
    "VIEW_TREATMENT", "MANAGE_TREATMENT", "VIEW_REVENUE", "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS",
  ],
  DOCTOR: [
    "VIEW_DOCTOR_COMMAND_CENTRE", "VIEW_PATIENTS", "VIEW_JOURNEYS", "VIEW_APPOINTMENTS",
    "RECORD_CONSULTATION_OUTCOME", "COMPLETE_CONSULTATION", "VIEW_TREATMENT", "VIEW_TASKS",
  ],
};
```

### Web route inventory

| URL (route groups omitted) | Source relative to apps/web |
|---|---|
| `/analytics` | `app/(app)/analytics/page.tsx` |
| `/appointments` | `app/(app)/appointments/page.tsx` |
| `/campaigns/[id]` | `app/(app)/campaigns/[id]/page.tsx` |
| `/campaigns` | `app/(app)/campaigns/page.tsx` |
| `/command-centre` | `app/(app)/command-centre/page.tsx` |
| `/connectors` | `app/(app)/connectors/page.tsx` |
| `/doctor-home` | `app/(app)/doctor-home/page.tsx` |
| `/front-desk` | `app/(app)/front-desk/page.tsx` |
| `/inbox` | `app/(app)/inbox/page.tsx` |
| `/integrations` | `app/(app)/integrations/page.tsx` |
| `/journeys/[journeyId]` | `app/(app)/journeys/[journeyId]/page.tsx` |
| `/journeys` | `app/(app)/journeys/page.tsx` |
| `/leads` | `app/(app)/leads/page.tsx` |
| `/my-work` | `app/(app)/my-work/page.tsx` |
| `/patients/[patientId]` | `app/(app)/patients/[patientId]/page.tsx` |
| `/patients` | `app/(app)/patients/page.tsx` |
| `/settings` | `app/(app)/settings/page.tsx` |
| `/treatment` | `app/(app)/treatment/page.tsx` |
| `/treatments` | `app/(app)/treatments/page.tsx` |
| `/` | `app/(marketing)/page.tsx` |
| `/login/[tenant]` | `app/login/[tenant]/page.tsx` |
| `/login` | `app/login/page.tsx` |
| `/signup` | `app/signup/page.tsx` |

### API route inventory

### `domain/acquisition/website-form.routes.ts`

- `POST /forms/website/:connectorId`

### `domain/activity/activity.routes.ts`

- `GET /activity-log`

### `domain/analytics/analytics.routes.ts`

- `GET /analytics/${path}`

### `domain/appointment/appointment.routes.ts`

- `GET /appointments`
- `GET /appointments/calendar-context`
- `GET /appointments/slot-check`
- `GET /front-desk`
- `PATCH /appointments/:id/complete`
- `POST /appointments`
- `PATCH /appointments/:id/action`
- `PATCH /appointments/:id/reschedule`

### `domain/auth/auth.routes.ts`

- `POST /auth/login`
- `GET /auth/tenants/:slug`
- `POST /auth/login/tenant/:slug`
- `POST /auth/signup`
- `GET /auth/dev-login/roles`
- `GET /auth/dev-login/environments`
- `POST /auth/dev-login`
- `POST /auth/logout`
- `GET /auth/session`

### `domain/auth/preferences.routes.ts`

- `PUT /me/preferences`

### `domain/call/call.routes.ts`

- `POST /journeys/:id/calls`
- `POST /calls/:id/feedback`
- `GET /calls/:id/recording`
- `GET /calls/:id/transcript`
- `POST /calls/:id/intelligence/retry`

### `domain/campaign/campaign.routes.ts`

- `GET /campaigns/performance`
- `GET /campaigns/marketing-efficiency`
- `GET /campaigns/spend-at-risk`

### `domain/capability/capability.routes.ts`

- `GET /capabilities`
- `PUT /capabilities/:key`

### `domain/connector/connector.routes.ts`

- `GET /connectors`
- `GET /connectors/:id`
- `PATCH /connectors/:id`
- `POST /connectors/:id/sync-campaigns`
- `POST /connectors/:id/sync-performance`
- `GET /connectors/:id/endpoints/resolve`
- `POST /connectors/:id/endpoints`
- `PATCH /connectors/:id/endpoints/:endpointId`
- `GET /communication-endpoints`
- `GET /connectors/:id/endpoints`

### `domain/connector/webhook.routes.ts`

- `GET /webhooks/whatsapp/:connectorId`
- `POST /webhooks/whatsapp/:connectorId`
- `POST /webhooks/runo/:connectorId`
- `POST /webhooks/ccs/:connectorId`
- `GET /webhooks/ccs/:connectorId`
- `GET /webhooks/meta-lead-ads/:connectorId`
- `POST /webhooks/meta-lead-ads/:connectorId`
- `POST /webhooks/google-ads-lead-forms/:connectorId`
- `POST /webhooks/whatsnexus`
- `POST /webhooks/whatsnexus/:tenantId`

### `domain/consultation/outcome.routes.ts`

- `POST /appointments/:id/outcome`

### `domain/conversation/conversation.routes.ts`

- `GET /conversations`
- `GET /conversations/:id`
- `GET /conversations/:id/messages/:messageId/attachments/:attachmentId`
- `POST /conversations/:id/messages`
- `POST /conversations/:id/messages/:messageId/retry`
- `POST /conversations/:id/media`
- `PATCH /conversations/:id/claim`
- `PATCH /conversations/:id/assign`
- `PATCH /conversations/:id/return-to-ai`
- `PATCH /conversations/:id/close`
- `GET /conversations/:id/automation`
- `PATCH /conversations/:id/automation`

### `domain/conversation/summary/conversation-summary.routes.ts`

- `GET /settings/conversation`
- `PATCH /settings/conversation`
- `GET /conversations/:id/summaries`
- `POST /conversations/:id/summary/refresh`
- `GET /patients/:id/conversation-summaries`

### `domain/crm/crm-allocation.routes.ts`

- `GET /crm/allocation-rules`
- `POST /crm/allocation-rules`
- `PATCH /crm/allocation-rules/:id`
- `DELETE /crm/allocation-rules/:id`
- `POST /crm/allocation-rules/reorder`

### `domain/crm/crm-field.routes.ts`

- `GET /crm/fields/for`
- `GET /crm/fields`
- `POST /crm/fields`
- `PATCH /crm/fields/:id`
- `POST /crm/fields/reorder`
- `GET /journeys/:id/field-prefill`

### `domain/crm/crm-outcome.routes.ts`

- `GET /crm/outcomes`
- `POST /crm/outcomes`
- `PATCH /crm/outcomes/:id`
- `POST /crm/outcomes/reorder`
- `POST /journeys/:id/interactions`

### `domain/dashboard/dashboard.routes.ts`

- `GET /branches`
- `GET /journey-types`
- `GET /dashboard/setup-status`
- `GET /dashboard/today`
- `GET /dashboard/performance`
- `GET /dashboard/executive`
- `GET /dashboard/conversion`
- `GET /dashboard/journey-health`
- `GET /dashboard/patient-flow`
- `GET /dashboard/attention`
- `GET /dashboard/spend-at-risk`
- `GET /dashboard/spend-at-risk-by-reason`
- `GET /dashboard/source-performance`
- `GET /dashboard/marketing`
- `GET /dashboard/team`
- `GET /dashboard/branch-doctor`
- `GET /dashboard/service-mix`

### `domain/dashboard/doctor.routes.ts`

- `GET /dashboard/doctor`

### `domain/integration/hub.routes.ts`

- `GET /integrations/hub`
- `GET /integrations/hub/:key`
- `PUT /integrations/hub/:key/configuration`
- `PUT /integrations/hub/website_leads/form`
- `POST /integrations/hub/website_leads/token`
- `POST /integrations/hub/:key/pair`
- `POST /integrations/hub/:key/sync`
- `POST /integrations/hub/:key/status`
- `POST /integrations/hub/:key/test-event`
- `GET /integrations/logs`
- `GET /integrations/webhooks`
- `POST /integrations/webhooks`
- `PATCH /integrations/webhooks/:id`
- `POST /integrations/webhooks/test`
- `DELETE /integrations/webhooks/:id`

### `domain/journey/journey.routes.ts`

- `GET /journeys`
- `GET /journeys/summary`
- `GET /journeys/:id`
- `PATCH /journeys/:id/owner`
- `POST /journeys/owner`

### `domain/lead/lead-source.routes.ts`

- `GET /lead-sources`
- `POST /lead-sources`
- `POST /lead-sources/reorder`
- `PATCH /lead-sources/:id`

### `domain/lead/lead.routes.ts`

- `GET /leads`
- `GET /leads/workspace`
- `GET /leads/summary`
- `POST /leads/lookup`
- `POST /leads`
- `GET /leads/:journeyId/edit`
- `PATCH /leads/:journeyId`

### `domain/lookup/appearance.routes.ts`

- `PUT /appearance`

### `domain/lookup/clinic-hours.routes.ts`

- `PUT /clinic-hours`

### `domain/lookup/lookup.routes.ts`

- `GET /lookups`

### `domain/notification/notification.routes.ts`

- `GET /notifications/templates`
- `GET /notifications/rules`
- `GET /notifications/provider-templates`
- `PATCH /notifications/templates/:id`
- `PATCH /notifications/rules/:id`
- `GET /journeys/:id/whatsapp/preview`
- `POST /journeys/:id/whatsapp`
- `GET /journeys/:id/notifications`

### `domain/patient/patient.routes.ts`

- `GET /patients`
- `GET /patients/search`
- `GET /patients/:id/360`
- `GET /patients/:id/timeline`
- `GET /patients/:id/upcoming`
- `POST /patients`

### `domain/report/report.routes.ts`

- `GET /reports/filter-options`
- `GET /reports/operations`
- `GET /reports/export`

### `domain/resource/resource.routes.ts`

- `GET /resources`
- `POST /resources`
- `PATCH /resources/:id`

### `domain/specialty/department.routes.ts`

- `GET /departments`
- `GET /department-templates`
- `POST /departments/install`
- `PATCH /departments/:id`

### `domain/specialty/specialty.routes.ts`

- `GET /specialties`
- `GET /specialties/:key/fields`
- `GET /treatment-catalog`
- `POST /specialties`
- `GET /specialties/:key`
- `PATCH /specialties/:key`
- `POST /specialties/:key/fields`
- `PATCH /specialties/fields/:fieldId`

### `domain/task/followup-type.routes.ts`

- `GET /followup-types`
- `POST /followup-types`
- `PATCH /followup-types/:id`
- `POST /followup-types/reorder`

### `domain/task/task.routes.ts`

- `GET /tasks`
- `GET /tasks/counts`
- `POST /tasks`
- `POST /journeys/:id/follow-ups`
- `PATCH /tasks/:id/note`
- `PATCH /tasks/:id/reschedule`
- `PATCH /tasks/:id/reassign`
- `PATCH /tasks/:id/complete`

### `domain/treatment/treatment.routes.ts`

- `GET /treatments`
- `PATCH /treatments/:id/status`
- `POST /journeys/:id/surgery`
- `PATCH /treatments/:id/schedule`

### API domain inventory

`acquisition`, `activity`, `ads`, `analytics`, `appointment`, `auth`, `call`, `campaign`, `capability`, `connector`, `consultation`, `conversation`, `crm`, `dashboard`, `integration`, `journey`, `lead`, `lookup`, `marketing`, `notification`, `patient`, `report`, `resource`, `security`, `specialty`, `task`, `timeline`, `treatment`

### Test inventory

Found 159 API TypeScript test files and 79 Playwright spec files (counts describe files, not passing tests).

API test names: `add-service.integration.test.ts`, `add-staff.integration.test.ts`, `ads.integration.test.ts`, `ads.test.ts`, `analytics-timezone.integration.test.ts`, `analytics.integration.test.ts`, `anthropic-summarizer.test.ts`, `appearance.integration.test.ts`, `appointment-booking-integrity.integration.test.ts`, `appointment-hours.integration.test.ts`, `appointment-transitions.integration.test.ts`, `appointment-views-timezone.test.ts`, `appointments.integration.test.ts`, `auth-and-dashboard.integration.test.ts`, `auth-session-lifecycle.integration.test.ts`, `call-appointment.integration.test.ts`, `call-demo-seed.integration.test.ts`, `calls.integration.test.ts`, `campaign-sync.integration.test.ts`, `campaign-views-run-window.test.ts`, `campaigns-period.integration.test.ts`, `campaigns.integration.test.ts`, `capabilities.integration.test.ts`, `capabilities.test.ts`, `ccs-telephony.test.ts`, `check-in-queue.integration.test.ts`, `clinic-hours-config.integration.test.ts`, `communication-endpoints.integration.test.ts`, `connector-event-retry.integration.test.ts`, `connectors.integration.test.ts`, `conversation-summarizer.test.ts`, `conversation-summary.integration.test.ts`, `conversion-feedback-treatment-trigger.integration.test.ts`, `conversion-feedback.integration.test.ts`, `cors.integration.test.ts`, `crm-allocation.integration.test.ts`, `crm-field-behaviour.integration.test.ts`, `crm-fields.integration.test.ts`, `crm-outcomes.integration.test.ts`, `dashboard-extended.integration.test.ts`, `dashboard-funnel-integrity.integration.test.ts`, `dashboard-period.integration.test.ts`, `dashboard-service-mix.integration.test.ts`, `date-presets.test.ts`, `day-navigation.integration.test.ts`, `demographics.integration.test.ts`, `demographics.test.ts`, `departments.integration.test.ts`, `dev-login.integration.test.ts`, `display-preferences.integration.test.ts`, `doctor-dashboard.integration.test.ts`, `doctor-outcome-feedback-loop.integration.test.ts`, `edition-access.integration.test.ts`, `error-handling.integration.test.ts`, `followup-demo-seed.integration.test.ts`, `followups.integration.test.ts`, `gbp-performance-sync.integration.test.ts`, `google-ads-lead-forms-webhook.integration.test.ts`, `hospital-wall-clock.test.ts`, `inbox-endpoint-filter.integration.test.ts`, `inbox-whatsnexus.integration.test.ts`, `inbox.integration.test.ts`, `integration-hub-state.test.ts`, `integration-hub.integration.test.ts`, `job-runner.test.ts`, `journey-detail.integration.test.ts`, `lead-edit.integration.test.ts`, `lead-edit.logic.test.ts`, `lead-intake.integration.test.ts`, `lead-sources-channels.integration.test.ts`, `lead-views.test.ts`, `leads-workspace.integration.test.ts`, `leads.integration.test.ts`, `log-ranges.integration.test.ts`, `login-throttle.integration.test.ts`, `m6-appointment-surgery.integration.test.ts`, `m7-review-fixes.integration.test.ts`, `marketing-dashboard.integration.test.ts`, `media-rules.test.ts`, `meta-lead-ads-webhook.integration.test.ts`, `multi-specialty-demo.integration.test.ts`, `namokar-isolation.integration.test.ts`, `namokar-pilot-seed.integration.test.ts`, `namokar-seed.integration.test.ts`, `namokar-v2-split.integration.test.ts`, `notification-plan.test.ts`, `notification-reconcile.integration.test.ts`, `notifications.integration.test.ts`, `operational-status.test.ts`, `operations-report.integration.test.ts`, `outcome-appointment.integration.test.ts`, `patient-identity.integration.test.ts`, `patient-intake.integration.test.ts`, `patient-views-upcoming.test.ts`, `patients-and-journeys.integration.test.ts`, `performance.integration.test.ts`, `performance.test.ts`, `permissions.integration.test.ts`, `pilot-consultation-flow.integration.test.ts`, `pilot-lead-flow.integration.test.ts`, `post-care.integration.test.ts`, `provider-template.test.ts`, `provider-templates.integration.test.ts`, `remember-me-lifecycle.integration.test.ts`, `remember-me.integration.test.ts`, `revenue-capability.test.ts`, `revenue-off.integration.test.ts`, `runo-webhook.integration.test.ts`, `security-baseline.integration.test.ts`, `seed-task-journey-links.integration.test.ts`, `seed-treatment-fields.integration.test.ts`, `signup.integration.test.ts`, `specialty-config.integration.test.ts`, `task-hospital-day.integration.test.ts`, `tasks-completed-period.integration.test.ts`, `tasks.integration.test.ts`, `tenant-branding.integration.test.ts`, `tenant-config-propagation.integration.test.ts`, `tenant-login.integration.test.ts`, `tenant-reference-integrity.integration.test.ts`, `timeline-endpoint-label.integration.test.ts`, `timeline-owner-change-category.integration.test.ts`, `today-hospital-day.integration.test.ts`, `treatment-catalog.integration.test.ts`, `treatment-completion.integration.test.ts`, `treatment-revenue-event.integration.test.ts`, `treatment-views-board-moves.test.ts`, `treatments-date.integration.test.ts`, `treatments.integration.test.ts`, `unified-identity.integration.test.ts`, `web-origins.test.ts`, `webhook-rules.test.ts`, `website-form.integration.test.ts`, `website-intake-audit.integration.test.ts`, `website-intake-hardening.integration.test.ts`, `website-leads-hardening.integration.test.ts`, `website-leads-hub.integration.test.ts`, `website-leads-rules.test.ts`, `whatsapp-webhook.integration.test.ts`, `whatsnexus-adapter.test.ts`, `whatsnexus-contract.test.ts`, `whatsnexus-e2e.integration.test.ts`, `whatsnexus-pairing.integration.test.ts`, `whatsnexus-provider-matrix.integration.test.ts`, `whatsnexus-provider.integration.test.ts`, `attribution.service.test.ts`, `touchpoint.test.ts`, `google-ads-lead-forms.test.ts`, `google-business-profile.test.ts`, `meta-lead-ads.test.ts`, `login-throttle.test.ts`, `password.test.ts`, `whatsapp-meta-cloud.test.ts`, `formulas.test.ts`, `phone.test.ts`, `encryption.test.ts`, `safety.test.ts`, `consistency.test.ts`, `demo-clock.test.ts`
