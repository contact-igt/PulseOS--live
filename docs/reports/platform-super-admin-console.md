# PulseOS Platform Super Admin console

## Architecture and compatibility

Migration 0050 introduced hashed and revocable operator bearer credentials in `platform_identities`, onboarding state in `hospital_onboardings`, and actor-attributed events in `platform_audit_log`. The prior role, `HOSPITAL_ONBOARDING_ADMIN`, could create, read, invite, retry templates, and activate through the existing `/platform/hospitals` operations. Its actor column references an operator identity. Hospital authentication separately resolves the `pulseos_session` cookie, tenant, edition, and capabilities. Public signup returns HTTP 410.

Migration 0051 adds separate `platform_accounts`, `platform_sessions`, `platform_enrollments`, and `platform_security_audit` tables. The existing onboarding audit table gains a nullable browser actor with its own foreign key, preserving existing operator attribution. The interactive account table uses a normalized unique email and explicit platform roles. The migration leaves hospital records, operator credentials, and existing session tables intact. Apply it through the normal Drizzle migrator before starting the new API.

Browser accounts and bearer operators resolve to separate platform principals at the existing routes. Creation still uses the original `provisionHospital` function. The onboarding service now returns allowlisted hospital identity fields and explicit activation blockers. Department installation, invitation redemption, hospital capability resolution, and the activation gate still use their existing workflows. A valid hospital cookie grants no platform authority. A valid independent platform session can coexist in a browser that also has a hospital cookie.

## Authorization

| Permission | Platform Super Admin | Platform Operations Admin | Existing bearer operator |
| --- | --- | --- | --- |
| Browser dashboard and hospital directory | Yes | Yes | — |
| Read a hospital onboarding record | Yes | Yes | Yes |
| Create a hospital | Yes | Explicit grant | Yes |
| Issue hospital invitations | Yes | Explicit grant | Yes |
| Retry department templates | Yes | Explicit grant | Yes |
| Activate a hospital | Yes | Explicit grant | Yes |
| Invite or modify platform administrators | Yes | — | — |
| Read platform security audit metadata | Yes | — | — |
| Hospital clinical access through a platform principal | — | — | — |

A team advisory lock serializes bootstrap, invitations, and changes to role, account status, or grants. Team changes revoke the affected account's sessions. The service refuses to disable or demote the last active, MFA-enrolled Platform Super Admin. Team management exposes no account deletion operation.

## Browser authentication and bootstrap

- Set `PLATFORM_WEB_ORIGIN` to the exact HTTPS origin of the console in production. It defaults to `http://localhost:3310` outside production. Browser writes require that Origin and the `X-PulseOS-Platform` request header. Platform CORS admits that origin, plus the creation idempotency header. Use a same-site HTTPS web/API pair for the host-only `SameSite=Strict` API cookie and make the hospital invitation page available on the origin used to deliver that link.
- Inject `PLATFORM_MFA_KEY` from the API secret store as 32 random bytes encoded as 64 hexadecimal characters. Share it across API instances and the authorized bootstrap process. It encrypts TOTP seeds with AES-256-GCM. Passwords use the existing Argon2 configuration. Login requires the password and a fresh authenticator code. Enrollment requires a single-use setup token, a password, and a verified authenticator code. The setup token expires after 24 hours and the browser enrollment challenge after 10 minutes.
- An authorized operator with database write access runs `pnpm --filter @pulseos/api platform:bootstrap --authorized <email>` from a private terminal. The initial success prints a single-use setup token. Deliver it privately and enter it under **Use a setup token** on `/platform/login`. Repeating the same bootstrap leaves the account intact. Adding `--renew-pending` can replace a lost or expired token for the sole pending bootstrap account. It refuses renewal after MFA enrollment or once other accounts exist. Capture neither setup tokens nor MFA seeds in deployment logs.
- `pulseos_platform_session` is HttpOnly, Secure in production, and scoped to the API's `/platform` path. PostgreSQL stores the token hash and enforces 30 minutes of inactivity, eight hours absolute, and revocation. Logout revokes the server-side session. Authentication failures use generic responses. Sign-in and enrollment starts reuse the repository's bounded, in-process rate limiter. An enrollment challenge also has a database-backed five-attempt cap. TOTP reuse is rejected under an account row lock.
- Existing `platform:credential` issue and revoke commands still work. Bearer callers use trusted server-side requests without browser Origin, Fetch Metadata, or session cookies. The browser never receives an operator credential.
- Platform responses use `Cache-Control: no-store`. Audit views project IDs, timestamps, actions, and safe reason codes. The web console holds invitation links and account setup tokens in component memory only, until dismissed or the view is left. Hospital invitation delivery remains a manual secure handoff.

## Pages and APIs

| Console page | API |
| --- | --- |
| `/platform/login` | `POST /platform/login`, `POST /platform/enroll`, `POST /platform/enroll/verify` |
| Console session and sign-out | `GET /platform/me`, `POST /platform/logout` |
| `/platform` | `GET /platform/dashboard` |
| `/platform/hospitals` | `GET /platform/hospitals?page=&limit=&search=` |
| `/platform/hospitals/new` | Existing `POST /platform/hospitals` with the original validated onboarding schema and `Idempotency-Key` |
| `/platform/hospitals/[id]` | Existing onboarding detail, invitation, retry-template, and activation endpoints. Legacy tenants use read-only `GET /platform/hospitals/legacy/:id`. |
| `/platform/administrators` | `GET /platform/administrators`, `POST /platform/administrators`, `PATCH /platform/administrators/:id` |
| `/platform/audit` | `GET /platform/audit` |

Directory search matches hospital name or login slug. Results use stable created-time/ID ordering. Directory, team, and audit requests cap page size at 50 and page number at 100. The create form keeps the submitted payload and idempotency key in memory across retries on the same page. A definitive validation rejection allows corrected input. The detail page can also be reached using the attempted request ID.

## Dashboard definitions

| Metric | Source and timestamp |
| --- | --- |
| Total hospitals | Count of rows in `tenants`, including legacy and demo tenants in the selected database |
| Active hospitals | Tenant rows where `login_enabled = true` |
| Login disabled | Total tenants minus active tenants |
| Pending onboarding | Onboarding records without a provisioned tenant or with tenant login still disabled |
| Template failures | Onboarding records whose current `template_status` is `failed` |
| Pending administrator invitations | Provisioned onboarding records with no redemption timestamp and expiry after the API's current time |
| Recent hospital creations | Five newest committed tenants by `tenants.created_at`, then ID |
| Recent platform audit activity | Five newest onboarding/security audit records by their event `created_at`, for Super Admins |

Legacy directory records use tenant creation time and have no onboarding invitation. Failed provisioning attempts contribute to pending onboarding and remain queryable by their onboarding ID. The directory lists committed tenant records.

## Changed files

- `apps/api/.env.example`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/src/db/platform-schema.ts`
- `apps/api/src/db/migrations/0051_platform_browser_auth.sql`
- `apps/api/src/db/migrations/meta/_journal.json`
- `apps/api/src/domain/platform/platform-access.ts`
- `apps/api/src/domain/platform/platform-auth.service.ts`
- `apps/api/src/domain/platform/platform-directory.service.ts`
- `apps/api/src/domain/platform/platform-mfa.ts`
- `apps/api/src/domain/platform/platform.routes.ts`
- `apps/api/src/domain/tenant/hospital-onboarding.routes.ts`
- `apps/api/src/domain/tenant/hospital-onboarding.service.ts`
- `apps/api/src/ops/platform-bootstrap.ts`
- `apps/api/src/__tests__/platform-console.integration.test.ts`
- `packages/types/src/index.ts`
- `packages/api-client/src/index.ts`
- `apps/web/app/platform/login/page.tsx`
- `apps/web/app/platform/(console)/layout.tsx`
- `apps/web/app/platform/(console)/page.tsx`
- `apps/web/app/platform/(console)/platform-ui.tsx`
- `apps/web/app/platform/(console)/hospitals/page.tsx`
- `apps/web/app/platform/(console)/hospitals/new/page.tsx`
- `apps/web/app/platform/(console)/hospitals/[id]/page.tsx`
- `apps/web/app/platform/(console)/hospitals/[id]/hospital-details.tsx`
- `apps/web/app/platform/(console)/administrators/page.tsx`
- `apps/web/app/platform/(console)/audit/page.tsx`
- `apps/web/e2e/platform-console.spec.ts`
- `docs/reports/platform-super-admin-console.md`

## Rollback and production follow-up

1. Disable interactive platform console/API exposure at the gateway and revoke existing browser sessions before a security rollback. Restore the previous API and web build only to a version with public signup closed and the hospital login gate intact. Keep 0051 and its audit history in PostgreSQL so the prior bearer-only onboarding endpoints remain available.
2. If the schema must be removed before first use, stop the new API, confirm the new tables and browser-actor references are unused, and take a verified backup. Drop the browser-actor foreign-key column and the new audit index, then drop security audit, enrollments, sessions, and accounts in dependency order. Coordinate the migration ledger with release tooling.
3. Before exposing production, verify the exact HTTPS origin and same-site cookie layout, gateway and distributed login limits, trusted proxy configuration, browser deployment CSP, and response/request body redaction for authentication and token-delivery routes. Configure database retention for revoked/expired sessions, expired enrollments, and audit records.
4. Establish an authorized MFA recovery and encryption-key rotation procedure and enroll at least two Super Admins. This milestone has no self-service MFA recovery or key-ring rotation. Plan for account recovery and incident access before enabling the console.

## Verification

Migration through 0051 and the synthetic demo seed succeeded on an isolated PostgreSQL 16 cluster bound to loopback. The selected Vitest regression run passed 116 tests across 13 suites. Coverage included MFA, role and CSRF authorization, bearer compatibility, onboarding retries and audit, branded login, tenant isolation and capability resolution, appointments, journeys, notifications, and the WhatsNexus contract. A fresh targeted rerun passed all 10 platform and onboarding checks, including an actual hospital-session boundary check and session invalidation after role changes.

TypeScript checks passed for the API, web, shared types, and API client. The full web lint, targeted API lint, and production web build passed. Four Playwright checks passed in installed Chrome against the local production build, including real MFA enrollment, cookie scoping, and logout against the loopback API. The ambiguous-timeout scenario used a mocked API to verify the identical hospital creation replay. An initial browser run hit a disk-full error in the generated development cache. The production build and final browser run succeeded after that cache was cleared. Production was untouched.
