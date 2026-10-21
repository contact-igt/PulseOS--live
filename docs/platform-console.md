# PulseOS Platform Console (company side)

The control plane Invictus Global Tech uses to run every PulseOS client tenant. Web: `/platform` (sign-in `/platform/login`). API: `/platform/*`. It is **not** part of any hospital's navigation and never shows Developer Access.

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

## Decisions

- **Tenant lifecycle.** Only ONBOARDING and ACTIVE tenants can sign in. Suspend and archive end every staff session immediately and keep every row. There is no delete; a purge would need its own retention workflow.
- **Integrations while suspended.** Inbound webhooks and forms keep being recorded, so no patient enquiry is lost. Outbound automation (reminders, webhooks) follows the tenant's capabilities, as it always has. To stop messages, switch the relevant capability off. Platform Support Mode keeps working (read-only).
- **Plans.** The editions are the plans: capability defaults defined in code (`EDITION_CAPABILITIES`). Plan default + tenant override = effective, enforced on every request by `requireCapability`. There is no billing.
- **Invitations and resets.** 32-byte tokens; only a SHA-256 is stored. Single use, expiring (Platform Settings), revocable, carried in the URL **fragment** (`/account/set-password#token=…`), so they never reach a server log. Nobody at Invictus sees or sets a client password.
- **Email.** PulseOS has no email provider yet. `EmailProvider` is an adapter: a local in-memory outbox in development (read via loopback-only `GET /dev/outbox`), and in production nothing is sent and the console says "Not delivered". Adding a provider means adding one adapter.
- **Support Mode.** Reasoned, time-limited, and only honoured together with the same staff member's live platform session. A persistent banner names the hospital and the staff member. It is read-only unless edits are enabled (own permission, reason, typed confirmation, short limit). Every write and recording playback is audited as the staff member in `SUPPORT_MODE`. Inside the hospital's records the actor is a per-tenant "PulseOS Support" system account (`users.is_system`), never a client user. That account can't sign in and is excluded from staff lists.
- **Audit.** `platform_audit_events` is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE, and there are no foreign keys. Metadata is scrubbed of secret-shaped keys and redacted.
- **Credentials.** The console shows only Not saved / Saved / Saved but unreadable, plus the names of stored fields. Never values or ciphertext. No payloads or recording links.

## Local accounts (development only)

`pnpm db:seed` creates fictional platform staff with the local `DEMO_PASSWORD`: `owner@`, `admin@`, `implementation@`, `support@`, `auditor@platform.pulseos.local`. The seed refuses any non-local or production database.

## Known gaps

- No email provider: invitations and resets are created and audited, but not delivered in production until an `EmailProvider` is added.
- The `/platform` web guard is client-side (like the hospital app). Data protection is the API, which refuses every platform request without a platform session and permission.
- Plans are code-defined; there are no per-plan user, branch or integration limits because PulseOS has none to enforce.
- Web build commit and time appear in Platform Health only when the build provides `GIT_COMMIT` / `RAILWAY_GIT_COMMIT_SHA`.
