# PulseOS platform-managed hospital onboarding

## Audited behavior

Public signup validated a strict form, created the tenant, main branch, first hospital Super Admin, profile, and branding configuration, then signed the owner in. The shared `provisionHospital` in the onboarding working tree serialized email checks and slug allocation, and the platform endpoint reuses it. An existing staff-creation utility also uses that email lock. The department installer adds tenant-owned records idempotently.

Hospital authentication uses the `pulseos_session` cookie. Branded login resolves credentials within the hospital selected by the slug. Capabilities are resolved from the tenant edition and the tenant's overrides, including on session refresh. PulseOS had no platform identity store, password-recovery endpoint, or invitation mailer in the audited code. WhatsNexus management identities are separate and are outside this change.

## Changed files

| Area | Files and behavior |
| --- | --- |
| Provisioning | `apps/api/src/domain/tenant/hospital-provisioning.service.ts` remains the single implementation. It creates locked hospitals and reserves the owner email with an unusable initial credential. `hospital-onboarding.schema.ts` carries the strict validated fields from the retired `domain/auth/signup.service.ts`, with no password or client-supplied tenant ID. |
| Platform and audit | `apps/api/src/domain/tenant/hospital-onboarding.service.ts` and `hospital-onboarding.routes.ts` handle platform authorization, onboarding state, invitation issuance and redemption, template retry, activation, and audit. `apps/api/src/ops/platform-credential.ts` and `apps/api/package.json` add the operator credential command. `apps/api/src/app.ts` registers the routes and redacts authorization and cookie headers. |
| Hospital authentication | `apps/api/src/domain/auth/auth.routes.ts` returns HTTP 410 for public signup. `auth.service.ts` enforces the activation gate for hospital login, branding, and session resolution, and excludes platform-onboarded tenants from seeded Developer Access lookup. Existing development-visible hospitals retain their development-only access. |
| Templates | `apps/api/src/domain/specialty/department.service.ts`, `specialty.service.ts`, `treatment-catalog.service.ts`, and `apps/api/src/domain/lead/lead-source.service.ts` accept an existing transaction for template installation. Their tenant-owned catalog behavior is unchanged. |
| Database | `apps/api/src/db/schema.ts`, `db/migrations/0050_platform_hospital_onboarding.sql`, and `db/migrations/meta/_journal.json`. |
| Web | `apps/web/app/signup/page.tsx` explains platform onboarding. `app/login/page.tsx` links to it. `app/hospital-invitation/page.tsx` lets owners set a password. `packages/api-client/src/index.ts` removes the public signup call and adds invitation redemption. |
| Tests | `apps/api/src/__tests__/signup.integration.test.ts` covers the new lifecycle and public rejection. `tenant-branding.integration.test.ts` retains existing-hospital branding coverage and removes obsolete public signup scenarios. `apps/web/e2e/hospital-onboarding.spec.ts` checks the informational and invitation pages independently of the demo suite. `demo-patch.spec.ts` still checks the onboarding link on login, and `tenant-branded-login.spec.ts` retains legacy branded sign-in coverage. |

## Migration and deployment

Apply migration 0050 through `pnpm --filter @pulseos/api db:migrate` before starting the updated API. The migration adds `tenants.login_enabled` with a default of `true`, so existing hospitals retain access. It creates `platform_identities`, `hospital_onboardings`, and `platform_audit_log`. The audit log stores the operation, onboarding ID, platform actor when applicable, reason code, and timestamp.

For a rolling deployment, deny `POST /auth/signup` at the gateway before old and new instances overlap. Enable platform onboarding after all API instances enforce the new login gate.

Keep platform credentials in an approved secret store and use the management endpoints over HTTPS from trusted server-side clients. The database operator runs `pnpm --filter @pulseos/api platform:credential issue <operator-label>` to issue a credential for a named identity. The command prints the token once. It expires after seven days. Issuing again for the same label rotates the old token while retaining the audit identity. Use `pnpm --filter @pulseos/api platform:credential revoke <operator-label>` to revoke it. The API checks the credential hash, expiry, revocation, and `HOSPITAL_ONBOARDING_ADMIN` role. A hospital cookie is rejected at the platform entry point.

## Operator flow

| Step | API | Behavior |
| --- | --- | --- |
| Create | `POST /platform/hospitals` | Send the platform bearer token, a fresh UUID in `Idempotency-Key`, and the validated hospital/owner JSON. HTTP 201 means this request created the hospital. HTTP 200 means a replay. The response includes the onboarding ID for follow-up operations. |
| Check | `GET /platform/hospitals/:id` | Returns provisioning, template, invitation, readiness, and activation state, plus the future branded login path. Here `:id` is the onboarding UUID. |
| Retry provisioning | Repeat the original create request | Use the same key and payload after a transient failure. A changed payload under the same key returns 409. Use a new key to submit corrected input. Committed hospitals are reused on retries. |
| Retry template | `POST /platform/hospitals/:id/retry-template` | Installs a pending or failed template inside a savepoint. Partial catalog writes roll back on failure. Successful or unnecessary installs remain stable on repeat. A replay of create also resumes an interrupted pending install. |
| Invite the owner | `POST /platform/hospitals/:id/invitation` | Returns the intended recipient, expiry, and a one-time relative invitation link. Use the trusted PulseOS web origin and deliver the link only to the verified recipient. Reissuing invalidates the prior link. After redemption, the endpoint refuses reissue. |
| Accept | `/hospital-invitation#<token>` | The browser sends the token and chosen password in the body of `POST /auth/hospital-invitations/redeem`. The token is stored as a hash, expires after 24 hours, and can be redeemed once. Acceptance creates no hospital session. |
| Activate | `POST /platform/hospitals/:id/activate` | Requires a login slug, profile, branding configuration, a hospital Super Admin assigned to a branch of the same hospital, an accepted invitation, and a completed or unnecessary template. Activation publishes the branded login and enables ordinary password authentication. Repeating activation is safe. |

Creation input uses the existing form fields `fullName`, `email`, `phone`, `organizationName`, `industry`, `organizationType`, `department`, `addressLine`, `locality`, `city`, `state`, `pinCode`, `country`, `discoverySource`, `discoveryNotes`, and `edition`. Healthcare requires organization type and department. Country defaults to India and edition defaults to V1. The server rejects unknown fields.

## Rollback

1. Block management routes and public signup at the gateway. Revoke platform credentials if rolling back because of a security incident.
2. Keep migration 0050 and its audit data. Roll back to a build that still honors `login_enabled`, or keep the updated authentication code deployed while rolling back the rest. An older unpatched authentication build would let an invited owner who has already set a password sign into a pending hospital.
3. Before first use only, the schema can be reverted after confirming that onboarding and audit tables are empty, all tenants have login enabled, and no platform credential is in use. With the updated API stopped and a backup available, drop `platform_audit_log`, then `hospital_onboardings` and `platform_identities`, then remove `tenants.login_enabled`. Coordinate the migration ledger with the release tooling before reapplying migration 0050.

## Remaining operational risks

- Invitation delivery is an explicit operator handoff. Protect links like credentials and keep issuance responses and redemption bodies out of proxy logs, tracing, and support tickets. PulseOS has no configured invitation mailer in this implementation.
- Platform access currently uses revocable bearer credentials issued by a database operator. There is no browser management console or SSO integration in this release.
- The existing app had no password-recovery endpoint to exercise. This release leaves existing hospital credentials and login behavior intact. Invitation reissue is available only before acceptance.
- Existing tenant-scoped database uniqueness is preserved. The onboarding and staff-creation flows enforce the global case-insensitive owner-email check with the shared transaction lock. Direct SQL writers and legacy seed paths remain outside that application-level lock.

## Acceptance and verification

| Acceptance criterion | Local verification |
| --- | --- |
| Platform authorization and session separation | Integration tests reject absent, expired, revoked, and wrong-role credentials, reject hospital session credentials at the platform endpoint, and reject platform credentials as a hospital session. Creation and invitation acceptance produce no hospital session. |
| Public signup closure and shared provisioning | The API returns 410 and creates no tenant. The authorized route exercises `provisionHospital` and verifies its tenant, branch, Super Admin, profile, and branding records. |
| Email uniqueness, slug allocation, and request idempotency | Concurrent integration requests verify case-insensitive email rejection, distinct slug allocation, and one hospital per idempotency key. A reused key with a changed payload returns 409. |
| Safe retries | A simulated provisioning failure is recorded and retried. A separate simulated template failure rolls back partial catalog writes, retains the hospital, and can be retried concurrently without a duplicate department. |
| Invitation, readiness, and activation | Integration tests verify hashed token storage, rotation, expiry, concurrent single use, audit events, and activation gating. Removing branding after invitation acceptance blocks activation until branding is restored. |
| Existing login and capability behavior | Integration suites cover existing password login, branding, remembered sessions, Developer Access, editions, and capability overrides. |

The six onboarding, authentication, branding, session, edition, and capability suites passed all 93 tests with `COOKIE_SAMESITE=lax` set for the test process. The initial run inherited `SameSite=None` from local configuration and failed the branding suite’s cookie-mode assertion. API, web, and API client TypeScript checks passed.

Four additional suites passed all 36 department, specialty, tenant login, and tenant reference integrity tests. Rerunning the migrator against the local development database completed successfully with migration 0050 already installed. Both public onboarding Playwright tests passed in installed Chrome. The browser invitation test stubs the API request, and the PostgreSQL integration suite verifies actual redemption and session behavior. Targeted API and web lint checks passed.
