# PulseOS hospital messaging coordination

## Mapping and authorization

The local hospital ID comes from the existing Platform hospital resolver, including legacy hospitals. A LIVE WhatsNexus connector supplies the separately paired remote tenant ID and origin. The durable command captures that binding and the connector secret revision. The worker rechecks the local binding and asks the remote management integration endpoint to confirm the hospital UUID before processing a command.

PulseOS suspend and restore permissions remain the source of operator authority. The remote credential is a separate server-side management JWT for an active WhatsNexus Super Admin with explicit pause/resume grants for the paired remote tenant. The connector's send API key and callback secret have their own existing uses.

## Lifecycle and retries

An enabled suspension writes the pause intent in the same transaction as the local lifecycle transition and audit. A unique constraint deduplicates the command by hospital, lifecycle version and action. The job runner queries due commands after restart, reads remote status and commits the expected version before its first pause POST. The command UUID and version remain stable on uncertain delivery. The worker obtains independent status after acknowledgement and shows PAUSING with unresolved permits until confirmed.

Restoring PulseOS leaves WhatsNexus under its last observed state. The hospital detail offers a separate authorized resume after a confirmed pause on the current pairing. The resume is tied to the confirmed provider version, and the worker checks that the authorizing PulseOS account remains an active, MFA-enrolled Platform Super Admin. The worker serializes lifecycle and coordination writes per hospital across bounded provider requests. When PulseOS changes state during an outstanding pause, reconciliation can observe previous work without submitting a stale command.

Authentication, pairing and version conflicts are terminal until an authorized operator reviews and retries the same command. Network failures and PAUSING use a bounded retry schedule. The hospital detail shows the status, command UUID, most recent observation, unresolved permit count and command history. Operator actions use the existing lifecycle audit. Monitor failed commands and the age of pending commands in the hospital messaging command table. Internal provider payloads and credentials are excluded from status responses and operational logs.

A changed pairing makes earlier observations historical and prevents replay against the replacement pairing. If the hospital is already suspended, use the authorized WhatsNexus management process to verify and coordinate the new pairing. Preserve the old command record and report the external state independently.

## Deployment

1. Apply PulseOS migration 0054 before starting the candidate. Keep its command history during rollback.
2. Leave WHATSNEXUS_MANAGEMENT_ENABLED=false until WhatsNexus production acceptance and PulseOS staging verification are approved.
3. For approved staging, configure WHATSNEXUS_MANAGEMENT_ORIGIN as the exact paired HTTPS origin and load WHATSNEXUS_MANAGEMENT_JWT from the secret store. Use the same WhatsNexus management identity when rotating its JWT across outstanding commands.
4. Enable the job runner on an approved worker and verify the integration binding, scoped grants, and JWT expiry against a synthetic paired hospital. Require independently confirmed PAUSED and ACTIVE, including an unresolved permit scenario and an explicit resume. Enable external coordination only for the approved environment. Review hospitals suspended before activation separately through the authorized WhatsNexus management process. Activation queues work on future lifecycle changes and does not backfill those hospitals.
5. For rollback, disable coordination and drain in-flight jobs before replacing the application. Keep command UUIDs, observations, grant history, and provider permits. The WhatsNexus staging rollback procedure still governs older senders and Meta egress.

The implementation uses the existing WhatsNexus management integration detail, messaging-status, messaging-pause and messaging-resume endpoints. The status endpoint provides recent command audit and unresolved permit data. PulseOS stores a sanitized observation and acknowledgement. The integration has no operator fencing action.

Staging activation remains gated on WhatsNexus Redis/BullMQ and Meta acceptance, verified sender isolation, approved credential provisioning, and rollback rehearsal. Local synthetic fixtures do not establish those conditions.

## Local verification

- `pnpm.cmd --filter @pulseos/api db:migrate` applied the full migration chain to fresh disposable PostgreSQL 18.
- `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/hospital-messaging.integration.test.ts` passed 7/7 with HOSPITAL_MESSAGING_TEST_DATABASE=1 on pulseos_messaging_test. Tests include duplicate suspension, stale acknowledgement, PAUSING, timeout and retry, pairing and version rejection, explicit resume, account revocation, flag-off behavior, and concurrent restoration.
- `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/platform-console.integration.test.ts` passed 6/6 on a separately seeded pulseos_platform_test database.
- The Playwright hospital-lifecycle spec passed 1/1 with mocked HTTP routes and installed Chrome. The browser verified the warning, permit count, confirmation polling and explicit resume.
- API and web type checks and Git whitespace checks passed.

## Files

- `apps/api/src/domain/tenant/hospital-messaging.service.ts`, `hospital-lifecycle.service.ts`, `hospital-lifecycle.routes.ts`, and `hospital-lifecycle-operations.service.ts` in the same directory.
- `apps/api/src/server.ts` and `apps/api/.env.example`.
- `apps/api/src/db/migrations/0054_hospital_messaging_coordination.sql`, `apps/api/src/db/migrations/meta/_journal.json`, and `apps/api/src/db/schema.ts`.
- `apps/web/app/platform/(console)/hospitals/[id]/hospital-lifecycle.tsx`, `packages/api-client/src/index.ts`, and `packages/types/src/index.ts`.
- `apps/api/src/__tests__/hospital-messaging.integration.test.ts` and `apps/web/e2e/hospital-lifecycle.spec.ts`.
- `docs/reports/pulseos-whatsnexus-hospital-coordination.md`.

## Final contract and safety verification

The sibling WhatsNexus source registers the routes under `/api/management/integrations/pulseos/:tenantId`. The parameter is the paired WhatsNexus tenant ID. PulseOS sends the local hospital UUID as `pulseosTenantId` in the pause/resume body.

| Method and suffix | Verified contract |
|---|---|
| GET tenant root | Returns the integration envelope containing the enabled binding, hospital UUID and credential-presence flags. |
| GET `/messaging-status` | Returns state, version and last command, with permit counts, bounded open permits and recent command audit. PulseOS persists an allowlisted observation, including the count of sending and unknown permits. |
| POST `/messaging-pause` and `/messaging-resume` | Requires a management bearer JWT, current remote Super Admin identity and explicit actor/tenant/action grant. The body uses `commandId`, `expectedVersion`, `lifecycleVersion`, `pulseosTenantId` and reason `HOSPITAL_LIFECYCLE`. The acknowledgement carries state and version. Independent status determines confirmation. |

The provider verifies JWT signature and expiry, rechecks the active account on writes, and rejects a changed pairing or provider version with 409. Its replay fingerprint includes the management actor. Rotate the server-only JWT for the same WhatsNexus identity while commands remain outstanding. For an expired token, install the replacement and authorize reconciliation of the existing command. Treat identity changes as an operator-managed handoff with status reconciliation before any new action. The ordinary connector send key has no management role.

PulseOS now rejects status with an older provider version or an invalid same-version state transition. A normal same-version PAUSING-to-PAUSED transition remains valid. The worker verifies the paired hospital before and after each status read and discards data when the binding changes. The existing provider contract exposes these reads separately, so the live handoff must still exercise pairing rotation. The pause/resume POST itself carries the expected hospital binding and version, which WhatsNexus checks transactionally.

The job runner emits a structured warning for aggregate counts of commands pending at least 15 minutes, at most once per five minutes per worker. An operator can review individual failures and history in the hospital page. Connect production log alert routing during staging. Retain the feature flag off and preserve command and permit history across a rollback.

### Final verification results

| Check | Result |
|---|---|
| Full migration chain including 0054 | Applied successfully on fresh disposable PostgreSQL 18 databases. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/hospital-messaging.integration.test.ts` | 11 passed, 0 failed. Includes stale observations, pending local and remote pairing rotation, queued resume superseded by resuspension, operator demotion, and aged pending detection. Recovery after response loss was exercised across worker invocations using persisted commands. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/platform-console.integration.test.ts` | 6 passed, 0 failed on a separately seeded disposable database. |
| `pnpm.cmd --filter @pulseos/web exec playwright test e2e/hospital-lifecycle.spec.ts` | 1 passed, 0 failed using a temporary Chrome launch configuration and mocked HTTP. Includes PAUSING, unresolved permits, terminal auth failure, retry, independent PAUSED confirmation, explicit resume, and changed pairing. |

Files changed in this verification pass are `apps/api/src/domain/tenant/hospital-messaging.service.ts`, `apps/api/src/server.ts`, `apps/api/src/__tests__/hospital-messaging.integration.test.ts`, `apps/web/e2e/hospital-lifecycle.spec.ts`, and this report. Migration 0054 and WhatsNexus source were verified from the existing checkout.

**PulseOS implementation readiness: PASS**  
**Cross-system staging readiness: BLOCKED**  
**Production activation: NO-GO**

### Provisioning ownership and management-only handoff

No approved deployment target or deployment connector was available in the inspected workspace. The production-off default, migration ordering and warning event are present in source. No deployed flag, migration, credential injection, grant, or alert route was verified. Nothing was provisioned.

| Responsible system | Required evidence or configuration |
|---|---|
| PulseOS staging deployment owner | Supply approved frontend/backend origins and deployment access. Confirm migration 0054 on its staging PostgreSQL database, record the synthetic hospital UUID and LIVE connector, and keep production coordination disabled. |
| WhatsNexus staging owner | Supply the approved HTTPS origin and exact paired remote tenant ID. Confirm an active staging Super Admin identity and its `PULSEOS_MESSAGING_CONTROL_GRANTS` entries for that tenant and the pause/resume actions before any write test. |
| Staging secrets owner | Supply the secret reference that injects `WHATSNEXUS_MANAGEMENT_JWT` into the staging runner and set `WHATSNEXUS_MANAGEMENT_ORIGIN` to the approved paired origin. Record the actor and expiry through approved tooling. Keep JWT values out of the report. |
| Staging worker and operations owners | Identify the coordination job runner, verify its flag and `JOBS_DISABLED` settings, and route the aged-pending warning to an accountable operator. Record authorization for synthetic lifecycle and failure-injection work separately. |

Acceptance order is environment verification, then the two authorized GETs, then separate approval for the synthetic lifecycle test. The GET evidence should record the approved origin, sanitized HTTP status, exact hospital/tenant match, messaging state, provider version and aggregate permit counts. This pass issued zero HTTP requests and performed no commands, worker restart, or browser acceptance. No local test suite was repeated. **Management-only staging remains BLOCKED. Production activation remains NO-GO.**

Activation requires an authorized paired staging endpoint, current scoped WhatsNexus management grants, a worker and alert owner, and production acceptance of WhatsNexus worker/Meta sender isolation and rollback. Validate token rotation, real command and status reconciliation, and rollback with outstanding commands in that staging environment.

## Cross-system staging acceptance record

**PulseOS local implementation: PASS** · **Cross-system staging: BLOCKED** · **Production activation: NO-GO**

The workspace session contained no declared PulseOS or WhatsNexus staging endpoint, management HTTPS origin, injected management JWT, or Redis endpoint. The checked-in production activation default is false. No explicitly approved synthetic pairing, disposable staging databases, controlled Meta test account, or worker and alert owners were available to verify. The effective production flag could not be inspected from this session, and no configuration was changed.

Prior local evidence remains 11/11 coordination tests, 6/6 Platform tests, 1/1 mocked browser test, successful migration 0054 on disposable PostgreSQL, and passing API/web type checks. The route contract was verified against checked-out WhatsNexus source. This acceptance pass made zero staging HTTP requests and exercised zero live commands, UI sessions, worker restarts, or provider sends.

| Gate | Status and evidence to collect |
|---|---|
| Management-only API | **BLOCKED.** Verify the exact synthetic pairing and management actor through the integration detail and status GETs. Capture sanitized HTTP outcomes, command UUIDs, expected and observed versions, and permit counts. Verify duplicate and stale commands without sending any provider messages. |
| Pause and explicit resume | **BLOCKED.** From the staging UI, record local suspension, independent PAUSING and PAUSED observations, local restoration, explicit authorized resume, then independently confirmed ACTIVE. Use approved isolated permit fixtures for the PAUSING case. Record the command history and Platform audit and verify ordinary hospital workflows. |
| Recovery and authorization | **BLOCKED.** Verify timeout or lost acknowledgement, replay with the same UUID, version conflict, pairing rotation, expiry and same-actor JWT rotation, operator demotion, worker restart, restoration during unresolved pause, and resuspension during queued resume. Preserve unresolved commands and permits. |
| Workers and provider | **BLOCKED.** Require separate signed-off BullMQ/Redis restart, stale-generation, cron fallback and duplicate-settlement evidence. Real Meta acceptance and signed paused callbacks require explicit provider-test authorization. Establish independent sender isolation before any operator-attested fence. |
| Activation and rollback | **BLOCKED.** Verify migration 0054 on staging, scoped grants, worker and alert ownership, alert routing and separate review of previously suspended hospitals. Rehearse draining outstanding jobs, retaining command history, preserving keyed ingress compatibility and blocking legacy sender Meta egress. Keep production coordination disabled pending sign-off. |

To unblock the management-only pass, provide the approved staging frontend/backend origins, synthetic PulseOS hospital and WhatsNexus tenant IDs, and the name of the secret-store injection for the scoped staging management JWT. Record the operator and maintenance window if required by the staging owner. Do not include credential values in this report.

### Staging setup readiness audit

Checked the current process environment, the local API and web dotenv files and the sibling WhatsNexus dotenv file for relevant key presence only. Reviewed the migration journal, job registration, environment example and deployment handoff. No authorized staging deployment or secret-store binding was identifiable from those sources. Local dotenv settings do not establish deployed configuration.

| Requirement | Finding |
|---|---|
| Approved PulseOS backend and frontend | **Missing.** Neither approved origin was available. |
| Approved WhatsNexus HTTPS management origin | **Missing.** `WHATSNEXUS_MANAGEMENT_ORIGIN` was absent from inspected runtime configuration. |
| Synthetic LIVE connector | **Unverified.** No approved staging hospital UUID, LIVE connector record, or paired remote tenant ID was provided. |
| Management identity, grants, and injection | **Missing or unverified.** `WHATSNEXUS_MANAGEMENT_JWT` and `PULSEOS_MESSAGING_CONTROL_GRANTS` were absent from the inspected configuration. The staging Super Admin identity, per-tenant pause/resume grant, and deployed secret-store reference could not be verified. |
| Migration 0054 | **Verified locally.** It follows 0053 in the migration journal and passed previously on disposable PostgreSQL. Staging deployment is unverified. |
| Coordination flag and worker | **Verified in source.** Coordination defaults to disabled and requires `WHATSNEXUS_MANAGEMENT_ENABLED=true`. The job runner honors `JOBS_DISABLED`. No staging worker, assigned operator, or effective production flag could be verified. |
| Operational alerting and rollback | **Verified in source and runbook.** The worker emits a structured warning for aged pending commands. Staging log routing, alert acknowledgement, worker drain, and retained history during rollback are unverified. |

Management API HTTP results, including TLS and authentication, are **BLOCKED** with zero requests. Pause/resume, worker recovery, and Super Admin UI acceptance are also **BLOCKED**. No mocked tests were rerun. Only this report changed.

**PulseOS implementation: PASS**  
**Management-only staging: BLOCKED**  
**Full cross-system acceptance: BLOCKED**  
**Production activation: NO-GO**
