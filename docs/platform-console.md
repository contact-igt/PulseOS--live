# PulseOS Platform Console (company side)

The control plane Invictus Global Tech uses to run every PulseOS client tenant. Web: `/platform` (sign-in `/platform/login`). API: `/platform/*`. It is **not** part of any hospital's navigation and never shows Developer Access.

Pages: Overview `/platform` · Tenants `/platform/tenants` (detail tabs: Overview, Users, Branches & Departments, Modules & Capabilities, Integrations, Branding & Login, Usage, Support, Audit) · Users `/platform/users` · Access & Invitations `/platform/access` · Plans & Capabilities `/platform/plans` · Integrations `/platform/integrations` · Support `/platform/support` · Audit & Security `/platform/audit` · Platform Health `/platform/health` · Platform Settings `/platform/settings`. Invitation and reset links open `/account/set-password`.

Tenant roles are unchanged (`SUPER_ADMIN`, `HOSPITAL_ADMIN`, `FRONT_DESK`, `PATIENT_COORDINATOR`, `DOCTOR`) and govern only what someone can do *inside* a hospital; none of them grants anything in this console.

## Identity model

| Concept | Where it lives | Notes |
| --- | --- | --- |
| Tenant | `tenants` | Lifecycle `status`, `environment` (PRODUCTION / DEMO / TEST, set explicitly, never inferred from a name), `primary_admin_user_id`, optimistic `version`, `creation_key` for idempotent creation. |
| Tenant membership (TenantUser) | `users` | One row = one person's membership of one hospital: role, `status` (ACTIVE / INVITED / SUSPENDED / REMOVED) and its own credential. The same email may hold memberships in several hospitals. |
| Person | normalised email | The global Users directory groups every membership (and platform account) by email. |
| Platform access | `platform_users`, `platform_sessions` | A separate identity space and cookie (`pulseos_platform_session`). No tenant role, including `SUPER_ADMIN`, ever implies platform access. |

Renaming `users` was deliberately avoided: every tenant API already reads `request.sessionUser.tenantId/role`, resolved from the membership on each request, so role changes and suspensions apply on the next request.

## Platform roles

| Permission | Owner | Admin | Implementation | Support | Auditor |
| --- | :-: | :-: | :-: | :-: | :-: |
| View console (overview, tenants, users, integrations, health, settings) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create tenant / edit details, branding, configuration | ✓ | ✓ | ✓ | | |
| Lifecycle (activate, suspend, reactivate, archive) | ✓ | ✓ | | | |
| Plans & capabilities | ✓ | ✓ | | | |
| Memberships (invite, role, suspend, remove) | ✓ | ✓ | ✓ | | |
| Account access (reset links, sessions, resend/revoke invitations) | ✓ | ✓ | ✓ | ✓ | |
| Suspend a person everywhere | ✓ | ✓ | | | |
| Support Mode / enable support edits | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / – | |
| Audit & security | ✓ | ✓ | | | ✓ |
| Platform staff (Owner/Admin roles: Owner only) | ✓ | ✓ (lower roles) | | | |
| Platform settings | ✓ | | | | |

Source of truth: `PLATFORM_ROLE_PERMISSIONS` in `@pulseos/types`, enforced per route by `requirePlatform()`. Nobody changes their own platform access, and the last active Platform Owner can never be suspended or demoted (one lock covers all staff changes).

## Tenant lifecycle and communication

| Status | Client sign-in | Existing client sessions | Inbound (calls, WhatsApp, forms, webhooks) | Automated outbound (reminders, confirmations, scheduled WhatsApp, outbound webhooks) |
| --- | --- | --- | --- | --- |
| DRAFT | Blocked | — | Recorded | Paused |
| ONBOARDING | Allowed (setup) | Valid | Recorded | Paused |
| ACTIVE | Allowed | Valid | Recorded | Runs (if the capability and the tenant's own rule allow) |
| SUSPENDED | Blocked (`workspace_unavailable` after a correct password) | Ended immediately (rows deleted, and rejected on every request) | **Recorded: no enquiry is lost** | **Paused** |
| ARCHIVED | Blocked | Ended | Recorded | Paused |

**SUSPENDED is not DELETED.** Every row is kept and nothing about the tenant's configuration changes.

Outbound permission is **derived**, never written into settings:

```
canSendOutbound = tenant.status === ACTIVE && capability on && the tenant's own rule / setting allows it
```

`domain/platform/outbound-policy.ts` decides the lifecycle part for both outbound jobs (`processDueNotifications`, `deliverDueWebhooks`). A message due for a tenant that isn't ACTIVE is **cancelled** with reason `TENANT_NOT_ACTIVE` (a webhook delivery is marked failed, `tenant_not_active`). It is never left as a backlog. On reactivation, anything scheduled from then on runs normally. Anything that fell due before the tenant became active again is never sent late, even if the job only runs after reactivation, because the rule compares the due time with `tenants.status_changed_at`. Existing reminder rules also never send a reminder late (`LATE_GRACE_MS`) or after its visit. Staff-typed Inbox replies are not automation; while suspended, staff can't sign in to send them.

## Decisions

- **Tenant lifecycle.** Only ONBOARDING and ACTIVE tenants can sign in. Suspend and archive end every staff session immediately and keep every row. There is no delete; a purge would need its own retention workflow.
- **Suspension (SUSPENDED ≠ DELETED).** See "Tenant lifecycle and communication" below.
- **Plans.** The editions are the plans: capability defaults defined in code (`EDITION_CAPABILITIES`). Plan default + tenant override = effective, enforced on every request by `requireCapability`. There is no billing.
- **Invitations and resets.** 32-byte tokens; only a SHA-256 is stored. Single use, expiring (Platform Settings), revocable, carried in the URL **fragment** (`/account/set-password#token=…`), so they never reach a server log. Nobody at Invictus sees or sets a client password.
- **Email.** PulseOS has no email provider yet. `EmailProvider` is an adapter: a local in-memory outbox in development (read via loopback-only `GET /dev/outbox`), and in production nothing is sent and the console says "Not delivered". Adding a provider means adding one adapter.
- **Support Mode.** Reasoned, time-limited, and only honoured together with the same staff member's live platform session. A persistent banner names the hospital and the staff member. It is read-only unless edits are enabled (own permission, reason, typed confirmation, short limit). Every write and recording playback is audited as the staff member in `SUPPORT_MODE`. Inside the hospital's records the actor is a per-tenant "PulseOS Support" system account (`users.is_system`), never a client user. That account can't sign in and is excluded from staff lists.
- **Audit.** `platform_audit_events` is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE, and there are no foreign keys. Metadata is scrubbed of secret-shaped keys and redacted.
- **Credentials.** The console shows only Not saved / Saved / Saved but unreadable, plus the names of stored fields. Never values or ciphertext. No payloads or recording links.

## Local accounts (development only)

`pnpm db:seed` creates fictional platform staff with the local `DEMO_PASSWORD`: `owner@`, `admin@`, `implementation@`, `support@`, `auditor@platform.pulseos.local`. The seed refuses any non-local or production database.

## Tests and databases

| Run | Database | How |
| --- | --- | --- |
| Development / manual QA in the browser | `DATABASE_URL` (e.g. `pulseos_platform`) | `pnpm dev` |
| API integration tests (Vitest) | `TEST_DATABASE_URL`, else `<dev db>_test` | `pnpm --filter @pulseos/api test:db:prepare test`, then `pnpm --filter @pulseos/api test` |
| Playwright | `E2E_DATABASE_URL`, else `<dev db>_e2e` | `pnpm --filter @pulseos/api test:db:prepare e2e`, then `E2E_ISOLATED=1 pnpm --filter @pulseos/web e2e` (Playwright starts its own API and web servers on that database; stop the dev servers first) |

Every test target must be a local `pulseos_*` database and is refused if it equals the development database (`src/lib/test-database.ts`). Remote, staging or production databases are always refused.

Seed-guarantee tests (the demo's "today" story) build a fresh copy of the demo with the seed's own builders at their own start (`__tests__/helpers/fresh-demo.ts`), so they don't depend on when the shared demo was seeded or on the machine's time zone.

## Deployment and migrations

- Migrations `0050_platform_console` and `0051_tenant_creation_key` are additive. Existing tenants become ACTIVE / PRODUCTION, existing accounts stay ACTIVE with their passwords, and primary admins are backfilled. Run `pnpm db:migrate` before starting the new API.
- There are no platform staff in production until one is created deliberately. The demo seed is local-only and refuses non-local databases. Create the first Platform Owner with a one-off, audited operation (not part of this branch). Every later staff member is invited from the console.
- New environment variables are all optional: `PLATFORM_LOGIN_MAX_FAILURES`, `PLATFORM_LOGIN_MAX_FAILURES_PER_ADDRESS`, `PLATFORM_*_ACTIONS_PER_MINUTE`, `ACCOUNT_TOKEN_MAX_PER_MINUTE`, and `GIT_COMMIT` (or the platform's own build variable) for version display.
- Cookies follow `COOKIE_SAMESITE` and are `secure` in production. Platform requests pass the same `WEB_ORIGIN` origin check as hospital requests.

## Verification coverage

API integration suites under `apps/api/src/__tests__/platform-*.integration.test.ts` cover auth and isolation, tenants and lifecycle, users, memberships, invitations and sessions, plans and capabilities, integrations, Support Mode, suspension (inbound vs outbound), audit, health and settings, and the full role matrix (5 platform roles × 17 capabilities; hospital roles refused everywhere). `ccs-call-flow.integration.test.ts` drives a CCS IVR call through the real webhook route end to end. `apps/web/e2e/platform-console.spec.ts` covers the console in a browser.

## Known gaps

- No email provider: invitations and resets are created and audited, but not delivered in production until an `EmailProvider` is added.
- The `/platform` web guard is client-side (like the hospital app). Data protection is the API, which refuses every platform request without a platform session and permission.
- Creating the very first Platform Owner in a fresh production database isn't automated (deliberately: no account is ever seeded into production).
- Plans are code-defined; there are no per-plan user, branch or integration limits because PulseOS has none to enforce.
- 25 existing Playwright specs fail on untouched `main` with the same errors (proven against a separate `main` checkout and database). The largest group signs in again on a page that is already signed in, which `/login` now redirects. Others still expect CCS IVR to be "blocked", or match two "Name" fields in Edit Lead. They are not caused by the Platform Console and are left for a separate fix.
- Web build commit and time appear in Platform Health only when the build provides `GIT_COMMIT` / `RAILWAY_GIT_COMMIT_SHA`.
