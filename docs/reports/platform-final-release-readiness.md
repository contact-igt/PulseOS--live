# PulseOS Platform Super Admin release readiness

**Production activation — NO-GO.** This pass uses local synthetic evidence. Production flags and staging credentials require deployed-environment verification.

## Implementation and integration findings

| Area | Current implementation and verification boundary |
| --- | --- |
| Platform authentication | Separate Platform cookie and origin checks, Argon2 password verification, encrypted TOTP enrollment, replay rejection, idle and absolute expiration, role enforcement and session revocation have registered API coverage. Tenant cookies cannot authorize Platform actions. Operations grants cannot suspend or restore a hospital. |
| MFA recovery | Migration 0056 provides the durable recovery record. The prior implementation allowed one non-target Super Admin to request and approve. Migration 0057 records the requesting actor and approval requires a different enrolled, active Super Admin with a fresh TOTP. The administrator API returns reviewer capability without exposing requester identity in the recovery view. Existing one-time credentials, current-password verification, session revocation, new MFA enrollment and last-admin restrictions are preserved. |
| Hospital onboarding | Registered routes exercise idempotent provisioning, initial administrator setup, invitation redemption and activation. Lifecycle and archival routes resolve the canonical hospital with explicit legacy handling. Template readiness and sensitive audit filtering remain in the existing path. |
| Invitation email | The worker processes durable rows after provisioning commits. A repeated invocation and concurrent workers are covered with mocked mail. The worker binds the encrypted credential to the owner, reuses Message-ID and token between retries, clears secrets on terminal states and records provider acceptance. The local SMTP fixture verifies transport options and link formatting. A process exit after SMTP acceptance and before commit can leave an ambiguous outcome. Stable Message-ID supports investigation but cannot establish inbox deduplication. |
| Lifecycle | Versioned suspend and restore, session revocation, blocked intake and notification recovery run on PostgreSQL fixtures. Restoration leaves external messaging state separately controlled. Every public ingress and every queue process was not exercised. |
| WhatsNexus coordination | Durable command and provider versions, independent observation, pairing rotation, pending permits, retry after lost acknowledgement and explicit resume are source-reviewed and exercised with a mocked partner. Resume rechecks the current Platform actor. These fixtures do not establish the deployed JWT/grants, real worker process restart or external state. |
| Platform Operations | Dashboard and exception API use persisted hospital, onboarding, command and connector records. Connector counts represent recorded LIVE binding problems. The runner checks aged commands every five minutes per runner instance and emits sanitized terminal, repeated network and PAUSING warnings. Production log routing and deduplication across replicas require operational acceptance. |
| Archival assessment | Super Admin-only GET uses a repeatable-read, read-only snapshot, scoped counts and sanitized evidence. Tests cover legacy and canonical identifiers, tenant isolation, unknown evidence and historical observations. Archive execution and restoration from archive remain blocked by policy. |

## Confirmed fixes

- MFA recovery now checks requester separation inside the existing serialized review transaction. The PostgreSQL route fixture denies the requester, the target and approval of a legacy pending record without requester attribution. It accepts a distinct reviewer only after a fresh TOTP step.
- The compiled API initially failed on Node 22.17.1 with `ERR_UNKNOWN_FILE_EXTENSION` for a shared TypeScript workspace package. The API start command now loads the existing `tsx` runtime, which is declared as a runtime dependency and pinned in the lockfile.
- The lifecycle browser fixture returned a hospital detail payload for the archival assessment request. It now serves a typed assessment and checks that historical observations and the policy blocker render without an Archive action.

## PostgreSQL verification

The migration journal is ordered through 0057. On two fresh, loopback-only PostgreSQL 18 databases, the chain recorded 58 migrations and a second application completed successfully. The 0057 upgrade on an existing synthetic 0056 database preserved both completed recovery records and installed the requester foreign key. Source review also checked the hospital lifecycle state constraint, held lead tenant and connector references, unique messaging command identity and due indexes, invitation onboarding foreign key and due index, and recovery account and requester foreign keys. Existing journal entries were preserved.

| Command | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/platform-console.integration.test.ts src/__tests__/hospital-invitation-email.test.ts` | 10 | 0 | 0 |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/hospital-messaging.integration.test.ts` | 12 | 0 | 0 |
| Playwright Platform console, hospital onboarding, hospital lifecycle and Platform Operations | 8 | 0 | 0 |

The final browser run used the four existing spec files, a temporary local Chrome override, and the compiled API and web builds. One test enrolled and signed out a synthetic administrator through the real local API and disposable PostgreSQL. The remaining flows used mocked responses where applicable. Earlier browser runs surfaced the compiled API startup failure, an unavailable bundled Chromium executable, and the stale lifecycle fixture. The table records the final rerun.

`pnpm.cmd --filter @pulseos/api typecheck`, `pnpm.cmd --filter @pulseos/web typecheck`, both package `build` commands, the compiled API health check, and `git diff --check` passed. The browser run covered the configured desktop project.

## Readiness decisions

| Area | Decision |
| --- | --- |
| Platform core local readiness | PASS |
| Invitation email staging | BLOCKED |
| MFA recovery operational readiness | BLOCKED pending staffing and incident procedure sign-off |
| WhatsNexus staging | BLOCKED |
| Platform Operations local readiness | PASS |
| Overall production activation | NO-GO |

## Migration and rollout

| Order | Dependency and evidence required |
| --- | --- |
| Database first | Apply 0052 lifecycle, 0053 held Meta references, 0054 messaging coordination, 0055 invitations, 0056 MFA recovery and 0057 requester attribution. Preserve lifecycle, audit, commands, invitations and recovery records. Inspect constraint and migration health before deploying the API. |
| API, then web | Use HTTPS API and Platform web origins. Verify `PLATFORM_WEB_ORIGIN`, `WEB_ORIGIN`, build-time `NEXT_PUBLIC_API_URL`, and trusted proxy hops if applicable. Keep API and web compatible while rolling forward. Use deployment secret-store references for `DATABASE_URL`, `PLATFORM_MFA_KEY` and `CONNECTOR_ENCRYPTION_KEY`. Verify credential custody and backup restoration. |
| Workers | Assign one runner owner per environment and set `JOBS_DISABLED=true` on replicas that should serve requests only. Route terminal, transport, aged-pending and unresolved-permit warnings to named owners. Confirm restart recovery and log redaction. |
| Invitation staging | Supply an approved HTTPS `HOSPITAL_INVITATION_WEB_ORIGIN`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, secret-store `SMTP_PASSWORD` and approved `SMTP_FROM`. Obtain authorization for a staging recipient and capture TLS, provider acceptance, restart and ambiguous-send evidence. Keep `HOSPITAL_INVITATION_EMAIL_ENABLED=false` in production until approved. |
| WhatsNexus staging | Supply an approved HTTPS `WHATSNEXUS_MANAGEMENT_ORIGIN`, secret-store `WHATSNEXUS_MANAGEMENT_JWT` for an active management Super Admin, a synthetic hospital UUID and LIVE connector binding, the paired remote tenant ID, explicit tenant pause and resume grants, and approved staging worker and operator ownership. Verify management GETs before separately authorized pause and resume. Keep `WHATSNEXUS_MANAGEMENT_ENABLED=false` in production until approved. |
| MFA incident ownership | Approve independent identity verification, last-admin authorization, review staffing, credential handoff and audit custody. Rehearse with a synthetic administrator and record named owners. Missing requester metadata on a pending pre-0057 request requires rejection and a fresh request, or expiry. |
| Rollback | Retain the additive schema and preserve evidence. Do not restore a pre-0057 recovery handler with approval enabled because it does not enforce requester separation. Drain or isolate workers before changing versions and rehearse rollback in staging with pending invitations and coordination commands. |

The checked-in example and the application flag defaults are disabled. The deployed production configuration, secret-store references, approval owners and log destinations were unavailable for verification.

## Files changed

- API start and dependencies · `apps/api/package.json`, `pnpm-lock.yaml`
- Database · `apps/api/src/db/platform-schema.ts`, `apps/api/src/db/migrations/0057_platform_mfa_recovery_requester.sql`, `apps/api/src/db/migrations/meta/_journal.json`
- Recovery API · `apps/api/src/domain/platform/platform-auth.service.ts`, `apps/api/src/domain/platform/platform.routes.ts`
- Client and UI · `packages/api-client/src/index.ts`, `apps/web/app/platform/(console)/administrators/page.tsx`
- Tests · `apps/api/src/__tests__/platform-console.integration.test.ts`, `apps/web/e2e/platform-console.spec.ts`, `apps/web/e2e/hospital-lifecycle.spec.ts`
- Documentation · `docs/reports/platform-mfa-recovery.md`, `docs/reports/platform-final-release-readiness.md`

## Remaining work

- **P0** Obtain deployed flag and migration evidence. Complete approved SMTP staging and real WhatsNexus management acceptance with the owners and resources above. Complete the MFA incident and private credential handoff sign-off, and rehearse rollback with outstanding work before release authorization.
- **P1** Capture actual worker termination and resumed processing for pending invitations and coordination commands, including the SMTP acceptance/commit ambiguity. Verify alert ownership and deduplication under the deployed replica topology.
- **P2** Expand browser evidence across mobile viewport and empty and error states. Expand deterministic fixtures for each background admission path and recovery request expiry.
