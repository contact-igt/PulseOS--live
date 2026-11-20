# Hospital archival and retention plan

**Implementation readiness — BLOCKED BY POLICY.** Platform Super Admins can review a read-only assessment. Archive execution, restoration from archive, and retention automation remain pending policy approval.

The [archival policy approval package](hospital-archival-policy-approval.md) provides the current code baseline, decisions for sign-off, proposed workflow and release gates.

## Read-only assessment handoff

The Platform hospital detail page uses `GET /platform/hospitals/:id/archival-assessment` and the existing legacy identifier convention. It requires a Platform Super Admin browser session and lifecycle read permission. Operations Admin, operator credential and hospital session access to the new assessment are denied. The API resolves the canonical hospital and reads a single repeatable, read-only PostgreSQL snapshot. It returns lifecycle and version, onboarding state, aggregate work counts, a local revenue evidence flag, and sanitized WhatsNexus observation metadata.

- Appointment counts include nonterminal states. The upcoming count is a subset of the unresolved count. Pending tasks, notifications, webhook deliveries, invitation mail, ad syncs and pending or processing call work describe local durable records. They cannot establish that every external or in-memory worker is idle.
- Connector event counts include received and failed records. Held Meta lead counts include retained records regardless of replay eligibility. Child records with separate parent ownership are counted only when both sides belong to the resolved hospital.
- WhatsNexus observations are scoped to the hospital. A verified observation is marked matching only when the pairing and hospital lifecycle version still match and coordination is enabled. Its permit count is point-in-time evidence. The assessment makes no provider request and never asserts the current remote state. Missing, invalid or historical evidence cannot clear an integration.
- The local revenue flag signals that a record exists. It exposes no amounts or identities and cannot establish outstanding balances, provider settlement or refunds. No authoritative legal hold registry was identified.
- Local record findings and proposed policy conditions are labeled separately. Empty work counts never produce an approval outcome.

## Policy decision register

| Decision | Required approval roles | Evidence or decision to record |
| --- | --- | --- |
| Archive eligibility | Platform operations and hospital governance | Eligible source states, required evidence, exceptions and independent approval |
| Clinical obligations | Hospital clinical leadership and records custodian | Open episode, appointment and follow-up handover criteria |
| Historical access | Privacy, security and records custodian | Approved roles, read scope, exports and access auditing |
| Integration shutdown | Integration owners, security and hospital operations | Intake shutdown, receipt-only callback policy and external sender isolation evidence |
| Open work and finance | Hospital operations, finance and integration owners | Ownership and reconciliation of obligations, provider work, permits and pending jobs |
| Restoration authorization | Platform governance and security | Approver separation, readiness, return state and independent sender authorization |
| Retention periods | Records management, legal and privacy | Approved periods and triggers by data class and jurisdiction |
| Legal holds | Legal, privacy and records custodian | Authoritative source, verification, precedence and release authority |
| Audit and rollback | Security, compliance and release operations | Audit access and retention, rollback compatibility and evidence preservation |

All decisions are pending. Role labels identify responsible functions for sign-off rather than granting new permissions.

## Existing lifecycle and archival capability

- Migration `0052_hospital_lifecycle.sql` admits PROVISIONING, ACTIVE, SUSPENDED and ARCHIVED. The shared types include ARCHIVED and a `hospital:archive` permission name. The current Platform account policy does not grant that permission, and no archive command, restoration-from-archive command, archive queue, or historical clinical access surface was found. The hospital page already suppresses onboarding activation for ARCHIVED. Existing templates and catalog items with local archive toggles have separate semantics.
- `hospital-lifecycle.service.ts` implements ACTIVE → SUSPENDED and SUSPENDED → ACTIVE. It locks the tenant row, checks the lifecycle version, records the outcome, revokes hospital staff sessions on suspend, and suppresses overdue pending notifications on restore. It uses the onboarding ID where an onboarding exists and the tenant UUID for a legacy hospital. Restoration checks branch-bound administrator readiness and, for onboarded hospitals, profile, branding, invitation and template readiness.
- `hospital-lifecycle.policy.ts` requires both ACTIVE and login enabled for staff authentication and for the job and submission paths using its guards. This provides a useful starting point for an inactive archive. It does not establish that all ingress, callback, Platform mutations, or indirect writes are read-only. In particular, the WhatsNexus webhook deliberately permits status and outbound mirror events through paths that bypass the active-tenant condition.
- Lifecycle migration 0052 follows onboarding and Platform authentication in 0050–0051. Migration 0053 adds held Meta references and their expiry. Migration 0054 adds durable messaging commands. Migration 0055 adds invitation delivery, and migration 0056 adds Platform administrator MFA recovery. Preserve all of them during archive and rollback.

## Hospital data dependency inventory

This inventory groups the current Drizzle tables by owner and includes secondary references. Where a child has no tenant column, resolve it through its parent. A foreign key alone does not demonstrate tenant authorization. Validate the deployed schema, volumes and external stores against this inventory before rollout.

| Data group | Repository tables and ownership path | Archive invariant |
|---|---|---|
| Identity and branding | `tenants`; `tenant_profiles`, `tenant_login_configs`, `tenant_capabilities`, `tenant_settings`, `branches` | Keep the tenant UUID, login slug and branded/branch associations. Prevent reassignment of identity to another hospital. |
| Staff and sessions | `users` by tenant and branch; `sessions` through user; role and permissions enforcement | Revoke active sessions, retain staff identity references and preserve individual access history. Historical access must use a separate authorized surface. |
| Onboarding | `hospital_onboardings` by tenant and initial administrator; `hospital_invitation_deliveries` by onboarding | Preserve onboarding identity, template status and invitation outcome. Prevent new issuance, redemption or worker sends during archive processing unless an explicitly approved exception exists. |
| Patient and CRM | `patients`, `journeys`, `timeline_events`, `tasks`, `departments`, `lead_sources`, `crm_outcomes`, `allocation_rules`, `followup_types` | Preserve patient and journey identities, assignments and provenance. Existing queued tasks need a disposition. |
| Appointments and clinical workflow | `schedule_resources`, `appointments`, `consultation_outcomes`, `treatment_opportunities`, `treatment_definitions`, `specialty_templates`, `custom_field_definitions`, `custom_field_values` | Preserve appointment, resource and clinical relationships. Templates with global scope are catalog data, not tenant archive targets. Verify transfer and historical access requirements with the clinical owner. |
| Revenue and financial references | `revenue_events` with journey and clinical references. Repository models also include estimated values and advertising spend. | Preserve originating identities and reconciliation evidence. The audited PulseOS schema does not establish a complete invoice, payment settlement or accounts receivable ledger. Confirm obligations with finance and external owners. |
| Acquisition and attribution | `marketing_campaigns`, `campaign_touchpoints`, `conversion_feedback_events`, `ads_daily_facts`, `ads_sync_runs`, `gbp_performance_metrics`, `suspended_meta_leads` | Preserve attribution, held provider references, external IDs and processing markers. Stop new sync or replay by policy. |
| Communications | `conversations`, `conversation_automation_preferences`, `messages`, `message_attachments`, `conversation_summaries` | Preserve thread and message identity and media references. Inventory provider-held media, attachment storage and signing access separately. |
| Telephony | `calls`, `call_intelligence` and recording URLs | Keep calls, processing evidence, and links to authorized retention-managed recordings. Prevent old transcription or enrichment jobs from restarting automatically. |
| Integrations | `connectors`, `communication_endpoints`, `connector_secrets` through connector, `connector_events`, `connector_disposition_mappings`, `connector_config_audit_events` | Keep tenant/connector and provider identity, receipts, deduplication and audit. Apply a separate credential disposition and watch for callbacks after sender shutdown. |
| Jobs and outbound intent | `notifications`, `notification_rules`, `message_templates`, `outbound_webhooks`, `outbound_webhook_deliveries`, conversation/call processing records, invitation delivery and `hospital_messaging_commands` | Preserve scheduled work and correlation keys. Hold, complete, or mark ineligible only under an approved disposition. Never infer successful fulfillment from archiving. |
| Audit and Platform identity | `activity_log`, `hospital_lifecycle_audit`, `platform_audit_log` through onboarding; `platform_identities`, `platform_accounts`, `platform_sessions`, `platform_enrollments`, `platform_mfa_recoveries`, `platform_security_audit` are Platform-scoped | Preserve audit attribution. Platform accounts, authorization, MFA recovery and sessions are independent of hospital lifecycle. |
| Remote or non-table dependencies | WhatsNexus tenant binding, permits, dispatch IDs, callback/inbound outboxes and associated financial references; provider webhook queues, assets and recordings; backup copies, logs and exports | Record the owning system and scope. Verify real remote evidence and approved retention separately. No local archive transition may settle or erase external state. |

Existing retention behavior is work-specific. `purgeExpiredMetaLeads` deletes expired rows from the held reference queue. Invitation delivery already clears encrypted tokens on terminal outcomes or stale/expired work, and recovery and session credentials have their own expiry semantics. These controls do not establish archival retention. Approval must explicitly address any legal hold that intersects a currently scheduled cleanup.

## Eligibility decision proposal

Read-only eligibility assessment and historical storage are separate from executing archival. Handle unknown remote state as a blocker, rather than treating disabled coordination or absent observations as evidence of safety.

| Condition | Proposed disposition |
|---|---|
| ACTIVE | Block archive. Require the existing authorized suspension and independent provider verification first. |
| SUSPENDED | Candidate only. Require a versioned assessment, cleared blockers and explicit approval. Current suspension status alone is insufficient. |
| PROVISIONING | Block normal archive. Require approved abandonment procedure for incomplete provisioning while preserving onboarding and audit identity. |
| Unredeemed or pending invitation | Block until an authorized disposition covers the token, queued delivery and any accepted email. No later invitation should reactivate the hospital. Preserve the audit. |
| Future or unresolved appointments | Block until the clinical owner confirms care continuity and an appointment disposition. Historical completed records are eligible for retained read-only access. |
| Pending or running jobs/outboxes | Block for in-flight or unknown work. Held pending work may be compatible with archive only after documented disposition and proven restart/replay guard. |
| Unresolved WhatsNexus send permits or unknown dispatch | Block. Require authoritative reconciliation or an independently approved exception policy and verified isolation. Archive never supplies a fence or settlement. |
| Pending/failed coordination, stale pairing or unverified remote pause | Block when the connector is applicable. Confirm current binding and independent PAUSED, resolve outstanding command ambiguity and inventory older senders. Explicitly distinguish a verified absence of integration from missing evidence. |
| Unsettled financial records | Block until finance reconciles or approves retained read-only servicing, independently of lifecycle. No automatic settlement, refund or adjustment. |
| Inbound events outstanding | Block if unclassified or undrained. An approved terminal intake policy can permit archive while an isolated receipt-only pipeline finishes known work. Preserve deduplication and payload evidence according to policy. |
| Historical records or a legal hold | Permit retained read-only archive if authorized access, custody and hold enforcement are available. A hold blocks disposal and any policy step that would change required evidence. |

## Lifecycle, authorization and API proposal

Keep the existing tenant states. Represent pending archival in a separate durable approval request while the hospital stays SUSPENDED. This avoids adding ARCHIVE_PENDING to every authentication, intake, scheduler and UI state machine. On approved execution, lock the tenant, recheck its version and current pairing, revalidate the blocker evidence and atomically set ARCHIVED with login disabled, incremented lifecycle version, audit, and revoked sessions. Never automatically advance a pending request. A rejected, expired or superseded request leaves the hospital suspended.

Historical access must use separately authorized, tenant-scoped read-only views. Default the existing Platform view to operational metadata. Clinical content, media and exports require a distinct approved scope, explicit purpose and audited access. Direct tenant sessions and ordinary API or connector credentials cannot grant archive access. Apply an explicit per-route admission model for normal writes, approved receipt reconciliation and historical reads. Prevent queued send/work claims with the existing transaction ordering where applicable, and verify remaining write paths before enabling archival.

Restoration requires a new authorized request with independent review and current checks of identity, staff, credential rotation, clinical readiness and connectors. Proposed transition is ARCHIVED → SUSPENDED first, followed by the existing separately authorized restore to ACTIVE. Preserve UUID and original relationships. Carry a lifecycle boundary on work eligibility and reconcile obsolete queued objects before opening operational admission. Do not replay held leads, old notifications, invitations or historical outboxes automatically. WhatsNexus resume remains separately authorized using current binding and provider version.

Proposed API surfaces, subject to approval, are a read-only eligibility endpoint and revocable/versioned archive and restoration requests with separate review. Reuse canonical legacy/onboarding resolution, Platform session and CSRF checks, and lifecycle audit. Require narrowly granted authority, separate requesting and approving actors, and fresh MFA for approval. No normal hospital user or Operations administrator inherits this authority. Audit blocking reasons, actor roles, version and sanitized evidence references, rejection, approval, execution and historical access. Evidence must be rechecked at execution to prevent a stale eligibility report authorizing a write.

On hospital detail, add an eligibility panel, blockers and evidence age, plus request/confirmation and status history after implementation approval. Historical access needs an explicit read-only context, with no enabled mutation controls. Restoration shows the approved destination and separate messaging state. During planning there is no operational Archive button.

The existing lifecycle constraint already admits ARCHIVED. A later additive migration would persist approval requests, target version, expiry, actors, disposition and evidence references with a uniqueness rule against competing open requests. Reuse lifecycle audit for the outcome and add scoped access audit only if needed. Do not add a state enum, cascade, retention trigger or historical data backfill in the planning pass. Rollback must keep new audit and request data. Once archived rows exist, require evidence that any rollback artifact still refuses operational sessions, writes, intake and stale job execution.

## Integration shutdown and preservation

| Integration | Observed behavior and proposed boundary |
|---|---|
| WhatsNexus | Existing coordination stores command UUIDs and observed versions against the paired connector. Inbound thread intake normally returns 503 when inactive. Status and outbound mirror callbacks have distinct write paths, and notification unknown-outcome reconciliation can continue independently. Do not disable all callbacks or treat 200 as proof that new intake is safe. Approve receipt-only write scope, keyed deduplication, remote sender controls, outbox disposition and permit checks before acceptance. |
| Direct Meta WhatsApp and inbound forwarding | Direct captured message intake uses the active gate. Status receipt processing deliberately bypasses it. For WhatsNexus forwarding preserve the remote retry/outbox records and receipt identities. Establish provider-specific stop/backpressure and dedupe policy. Avoid permanent 503 loops or acknowledging unprocessed clinical intake as successful. |
| Meta Lead Ads | Verify signed references, held reference expiry, connector binding and existing authorized replay path. Approve how archived-hospital intake is refused or redirected upstream and how held references under a hold are protected. Do not infer permission to purge from an archive action. |
| Runo and CCS | Call webhook admission uses active tenant locking for new call records. Verify upstream subscription and routing, retention of already captured calls and recordings, and behavior of retries after shutdown. |
| Google lead forms and site intake | Existing route checks deny inactive intake. Confirm provider-specific acknowledgment/retry and disable or redirect the upstream source after approval. Preserve existing lead identity and receipts. |
| Invitation email | The worker uses the provisioning lifecycle, recipient and token checks. Verify no current token or queued invite survives as an executable action. Preserve metadata and audit. Do not mix hospital invitations with Platform administrator recovery. |
| Notifications, outbound webhooks and background jobs | Review scheduler claims, sending/processing leases and recovery/reconciliation branches in the actual job runner. Keep old work references, apply an approved hold/disposition, and prove resume or rollback cannot silently restart it. Verify signed receipts for already submitted work independently. |
| Secrets and credentials | Keep the mapping and encrypted evidence where approved. Separate credentials needed for signed receipt verification from credentials that permit new submissions. Revoke or rotate each scope only after owner approval and continuity checks. |

## Retention approvals

No archive or retention interval is proposed here. Owners must specify the lawful retention basis and jurisdictions, retention trigger, access roles, hold overrides, processor obligations, backup/export coverage and authorized disposal evidence before implementation. Counsel and privacy must identify the applicable requirements, including contractual and clinical record obligations. Resolve conflicting demands through an approved legal hold process.

| Record type | Decision required | Accountable approval |
|---|---|---|
| Hospital profile and identity | Stable identifiers, branding, contact data and historical lookup | Product, hospital data owner and privacy |
| Staff accounts and sessions | Identity attribution, access removal, account or credential disposition | Security, HR or hospital owner, privacy |
| Patient and clinical data | Custody, transfer, authorized retrieval, holds and disposal | Clinical records owner, privacy and counsel |
| Appointments | Care continuity, unresolved bookings and permitted historical access | Clinical operations and records owner |
| Audit | Evidentiary integrity, access, export and hold protection | Security, compliance and counsel |
| Integration config and secrets | Separate configuration history, current authentication need, key access and retirement | Security and integration owners |
| Messages, callbacks and media | Message content, attachments, receipts, retries, provider copies and logs | Privacy, clinical/data owner, provider owner |
| Financial records | Open obligations, linked revenue/provider evidence, reconciliation access and preservation | Finance and counsel |
| Invitations and recovery | Keep hospital invitation metadata separate from Platform recovery audit and credentials. Approve custody and cleanup per scope. | Identity/security and privacy |

## Acceptance test plan

Use synthetic tenants, disposable databases and mocked providers for local checks. Only approved staging may verify remote worker and provider behavior.

1. **Authorization and audit.** Tenant users and out-of-scope Platform users receive denial. Reject same-actor approval, missing fresh MFA and stale privileges. Verify allowed decisions and denied known-target attempts are audited without patient or secret content.
2. **Eligibility and identity.** Active and provisioning cases cannot archive through normal flow. Suspended eligible case preserves UUID, onboarding/legacy resolution and slug. Exercise wrong resolver, conflicting IDs, pending invitations, future appointments and unsettled financial classifications.
3. **Race and restart.** Compete archive, restore, tenant writes and jobs across transactions. Require lost-version conflict, lock ordering, no duplicate decision, and unchanged identities. Restart workers with sending, due, failed and ambiguous work. Verify approved dispositions and no stale sends.
4. **Integration fixtures.** Hold an unresolved permit, a pending coordination command, an unverified PAUSED observation, pairing rotation and outstanding inbound events. Verify the blockers. For authorized receipt-only behavior, prove sender/tenant binding and dedupe, preserve the original receipt and billing references, and reject new intake.
5. **Isolation and historical reads.** Verify revoked sessions, new-session refusal, route-level write refusal across public/API/background paths, cross-tenant denial including indirect parents and media, and authorized historical read audit. Test exports under the approved policy.
6. **Restoration.** Exercise fresh authorization and readiness, restore to suspended first, preserve old audit and rows, and validate a separately authorized operational restore. Verify no automatic WhatsNexus resume, replay of old jobs, or reissued invitation.
7. **Retention and rollback.** Exercise hold overrides, audit availability, restored backups, migration ordering and rollback with both pending requests and archived hospitals. Confirm old binaries cannot reopen login, intake or sender egress. Compare identities and evidence rows before and after.
8. **Regression and UI.** Run existing Platform, invitation, MFA, lifecycle and messaging-coordination suites. Verify blocker display, permission and stale-evidence rendering, confirmation and audit history. Check clinical and notification workflows with ordinary active hospitals.

## Approval gates

Implementation requires signed lifecycle and restoration policy, clinical continuity and historical-access policy, approved retention schedules and hold handling, and integration/finance sign-off for receipt-only processing and unsettled work. WhatsNexus staging and rollback evidence remains a separate prerequisite where applicable. The audit did not run tests or migrations against any environment.
