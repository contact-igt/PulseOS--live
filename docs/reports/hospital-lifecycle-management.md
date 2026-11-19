# PulseOS hospital lifecycle management

## Source audit and execution policy

The existing platform console uses independent browser MFA sessions and limited operator bearer identities. Migration 0050 supplied `tenants.login_enabled` and onboarding readiness. Migration 0051 supplied platform sessions and security audit. The hospital request hook resolves `pulseos_session` for each protected request. The audit found no prior hospital lifecycle state. `provisionHospital` remains the single provisioner. The worker inventory comes from `apps/api/src/server.ts`, integration and notification consumers, connector routes, and operator/seed entry points.

| Entry point | Suspended hospital policy |
| --- | --- |
| Hospital browser login, branded login, and protected routes | Require lifecycle ACTIVE and login enabled. Suspension deletes remembered and ordinary sessions in the lifecycle transaction. Restoration requires a new login. |
| Platform console and trusted operator | Separate authentication. Operations Admin has lifecycle read access. Super Admin may suspend and restore. Operator credentials retain existing onboarding authority. The onboarding activation route can only promote PROVISIONING. |
| Public website form | Validate existing connector authorization and origin, then refuse new intake with HTTP 503 and `intake_unavailable`. |
| Authenticated Meta WhatsApp inbound, Runo, CCS, Meta Lead Ads, and Google Ads leads | Acknowledge authenticated intake without creating new hospital work. Providers may treat that acknowledgement as final. WhatsNexus inbound conversations follow the same policy. |
| Meta and WhatsNexus delivery status, WhatsNexus outbound echo | Existing signature, matching and tenant checks continue. Delivery status can advance and an authentic outbound echo can append to an existing thread. Existing connector and capability settings still apply. |
| Notification planning, appointment reconciliation, and manual follow-up | Skip new plans during suspension. Existing cancellation and rescheduling logic still applies to already admitted work. Appointment reconciliation uses the lifecycle change time to avoid recreating old confirmations. |
| Scheduled notifications and conversational text/media | Skip suspended tenants before claiming. Recheck hospital eligibility before provider submission. A notification that loses eligibility after claim is suppressed. Preserve references and outcome handling for already admitted sends. |
| Restoration of scheduled notifications | Keep all records and keys. Block overdue pending notifications in the restoration transaction. Future work still uses existing appointment/surgery state, current time, rule, template, contact and capability checks. The schema exposes marketing consent for marketing, while this transactional notification path has no separate consent field. No new consent model was introduced. |
| WhatsNexus ambiguous-outcome reconciliation | Continue read-only lookups using the original dispatch reference. Keep unknown outcomes out of the send queue. |
| Outbound webhook deliveries | Skip new enqueue and due delivery for suspended tenants. Hold queued deliveries and retain IDs and existing retry/receiver idempotency semantics. Work admitted before suspension can still complete. |
| Conversation summaries, call transcription/summarization, ads sync | Skip suspended tenants in due queries or claims. Recheck hospital state near provider work. Existing eligible backlog remains queued. |
| Integration setup, support/maintenance, and DB scripts | Browser setup routes remain behind hospital authentication. Internal DB access is still privileged. Review external schedulers, provider consoles, and maintenance scripts as part of deployment. Health checks remain independent of tenant state. |

Admission is based on the live database state. Operations already admitted before suspension can finish and their outcomes can be reconciled. PulseOS does not issue a provider-wide freeze or retract messages already accepted by providers.

## Data and API

Additive migration 0052 adds `tenants.lifecycle_status`, a version, the last transition timestamp, and a tenant-indexed lifecycle audit table. Existing login-enabled hospitals backfill to ACTIVE. Existing disabled rows backfill to PROVISIONING. New provisioning explicitly starts in PROVISIONING. The ARCHIVED value is reserved. Archival and permanent deletion are outside this release pending approved retention and provider-handling rules.

`GET /platform/hospitals/:id/lifecycle` and `GET /platform/hospitals/:id/lifecycle-history` require `hospital:lifecycle:read`. Use the onboarding UUID by default and `?legacy=1` with a legacy tenant UUID. History uses 25-row pages, capped at page 100.

`POST /platform/hospitals/:id/suspend` and `POST /platform/hospitals/:id/restore` require `hospital:suspend` and `hospital:restore`, respectively. The request contains the version and a reason code. `OTHER` requires an explanation. Text is bounded and credential-shaped text is scrubbed. Transitions lock the tenant row and make identical immediate replays safe. Conflicting or stale operations return 409, invalid input returns 400, missing targets return 404, and unauthorized authenticated operations return 403. Recognized write attempts record actor, target, previous and requested states, reason, outcome and timestamp. The platform audit list exposes lifecycle event metadata, and per-hospital history exposes the recorded reason.

Suspension atomically disables login, changes state, and deletes sessions. Login locks the tenant while issuing a session to prevent session creation from escaping suspension. Restoration verifies a branch-assigned hospital Super Admin. Platform-provisioned hospitals additionally require their original administrator association, branded login, profile, accepted invitation, and completed or unnecessary template. Restoration enables login and does not alter staff accounts, invites, capabilities or provider configuration.

Dashboard lifecycle-active and login-disabled counts are independent. Suspended is a current state count. Audit history records historical transitions. Lifecycle UI keeps legacy and onboarding ID routes distinct.

## Files changed

- `apps/api/src/app.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrations/0052_hospital_lifecycle.sql`
- `apps/api/src/db/migrations/meta/_journal.json`
- `apps/api/src/domain/tenant/hospital-lifecycle.policy.ts`
- `apps/api/src/domain/tenant/hospital-lifecycle.routes.ts`
- `apps/api/src/domain/tenant/hospital-lifecycle.service.ts`
- `apps/api/src/domain/tenant/hospital-provisioning.service.ts`
- `apps/api/src/domain/tenant/hospital-onboarding.service.ts`
- `apps/api/src/domain/platform/platform-auth.service.ts`
- `apps/api/src/domain/platform/platform-directory.service.ts`
- `apps/api/src/domain/auth/auth.service.ts`
- `apps/api/src/domain/acquisition/website-form.routes.ts`
- `apps/api/src/domain/connector/webhook.routes.ts`
- `apps/api/src/domain/notification/notification.service.ts`
- `apps/api/src/domain/notification/reconcile.ts`
- `apps/api/src/domain/integration/outbound-webhook.service.ts`
- `apps/api/src/domain/conversation/conversation.service.ts`
- `apps/api/src/domain/conversation/summary/conversation-session.service.ts`
- `apps/api/src/domain/call/call-intelligence.service.ts`
- `apps/api/src/domain/ads/ads-sync.service.ts`
- `apps/api/src/__tests__/platform-console.integration.test.ts`
- `apps/api/src/__tests__/whatsnexus-provider.integration.test.ts`
- `packages/types/src/index.ts`
- `packages/api-client/src/index.ts`
- `apps/web/app/platform/(console)/page.tsx`
- `apps/web/app/platform/(console)/platform-ui.tsx`
- `apps/web/app/platform/(console)/hospitals/[id]/hospital-details.tsx`
- `apps/web/app/platform/(console)/hospitals/[id]/hospital-lifecycle.tsx`
- `apps/web/e2e/hospital-lifecycle.spec.ts`
- `docs/reports/hospital-lifecycle-management.md`

## Rollback

Before rollout, back up the database and inventory API and job runners. Keep migration 0052 and audit data during a rollback. Disable lifecycle writes, pause affected workers and public intake, and preserve disabled login flags. A pre-0052 build can bypass suspension in workers and intake and can use its onboarding activation route to reopen login, so block those paths until all suspended tenants have an approved fallback. Reconcile ambiguous provider outcomes before restoring dispatch. Only remove the additive schema before first use or after exporting the audit and obtaining a separate change approval. Drop the lifecycle audit table and lifecycle columns/check, then reconcile the migration ledger. Never infer that a suspended hospital should become active during rollback.

## Verification

The normal migration runner applied 0052 to an isolated PostgreSQL 16 database. A second migration check verified preexisting enabled rows became ACTIVE and disabled rows became PROVISIONING. The main regression run passed 148 tests across 14 suites. The treatment, acquisition, ads, summary, and WhatsNexus run passed 118 tests across eight suites. The call and integration-hub regression run passed 58 tests across three suites. Focused reruns passed 39 notification and reconciliation tests, then 41 notification and WhatsNexus tests, including simulated interrupted dispatch during suspension and read-only recovery without a resend. Counts include repeated suites.

The Playwright run passed three tests in installed Chrome against the production build. Browser tests stubbed the platform API. The lifecycle API suite used real PostgreSQL, a valid hospital cookie, and an authenticated Meta delivery receipt.

API, web, shared types and API client TypeScript checks passed. The API typecheck required a larger bounded Node heap after the first run exhausted its heap. Web lint, targeted API lint, and the production web build passed. All database and provider fixtures used synthetic data.

## Blockers before production deployment

1. Approve and stage the provider-side pause procedure for autonomous WhatsNexus sends. PulseOS-side gating does not control jobs run inside WhatsNexus.
2. Confirm the business policy for acknowledged-and-dropped acquisition events and for transactional consent. Verify suspended Runo/CCS, lead ads, WhatsNexus inbound and signed status, outbound webhooks, ads sync, call intelligence, and conversation summary paths with their staging providers. The local tests exercised suspension directly for website intake, notification dispatch, Meta delivery receipts, and read-only WhatsNexus reconciliation. Other listed paths have source gates and selected active-state regression coverage.
3. Prove worker and API cutover is coordinated, including independent schedulers and maintenance entry points. Finish or reconcile work admitted before suspension and keep old application instances from bypassing the new gates.
4. Approve retention, provider obligations, and recovery rules before enabling archival. Archival remains deferred.
