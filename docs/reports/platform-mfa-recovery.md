# Platform administrator MFA recovery

## Existing behavior and gap

PulseOS already used Argon2 password verification, encrypted TOTP seeds, per-account TOTP replay protection, scoped browser cookies, server-side idle and absolute session expiration, role and disablement checks, and Platform security audit events. Setup tokens could enroll an administrator who had never completed setup. The normal administration endpoint could replace that initial token or disable accounts, while protecting the last enrolled Super Admin. It had no approved recovery path for an administrator who already had a password. Hospital onboarding and the existing hospital invitation email queue use separate credentials and remain separate.

## Recovery authorization

For normal recovery, another active, MFA-enrolled Platform Super Admin requests recovery for the exact account. The request expires after 30 minutes. Approval requires a different active, MFA-enrolled Super Admin who is also distinct from the target, and a fresh, unused TOTP step. The existing Platform team transaction lock serializes review and account changes. Disabled accounts and accounts without a current password are ineligible. If only one eligible non-target administrator is available, approval stays blocked. The last-admin incident procedure remains limited to its existing eligibility conditions.

Approval uses a 256-bit opaque credential with a 30-minute expiry and stores its digest through the existing setup credential mechanism. The server returns the credential only in the authorized approval response with Cache-Control no-store. The requesting or approving administrator must deliver the credential privately to the verified recipient. There is no automated recovery email and hospital invitation tokens have no role in this process.

Approval clears the previous TOTP enrollment, deletes existing enrollment challenges and revokes every active session for the target. Entering the recovery credential at Platform sign-in under Use a setup token requires the existing password. Starting enrollment consumes the credential and creates the existing short-lived challenge. A correct new TOTP is required to complete enrollment and authorize a new Platform session. The password hash, role and permissions are preserved. Disablement and role or permission changes invalidate an outstanding request and challenge. If enrollment is interrupted or expires, another authorized recovery is required.

Migration 0056 adds one durable current recovery record per account. Migration 0057 adds the requester reference. Pending requests from earlier versions without a recorded requester must be rejected and re-requested, or allowed to expire. Completed and already-approved records retain their existing state. Administrator management shows the state, expiry and whether the signed-in reviewer can approve. Platform audit history retains requests, approval, denial, rejection, invalidation, enrollment and completion. The administrator list and recovery history omit tokens, password hashes and TOTP seeds.

## Last active Super Admin

Use the incident procedure only when no other active enrolled Super Admin can authorize browser recovery. A privileged server-side operator must verify identity through an independent approved channel, record the exact Platform account UUID and incident reference, and obtain the organization's required approval. The private, non-recorded interactive command is:

```powershell
pnpm.cmd --filter @pulseos/api platform:recover-last-admin --authorized-identity-verified <account-uuid> <INC-reference>
```

The command uses the configured database and PLATFORM_MFA_KEY. Verify the environment before invocation. It refuses non-interactive output, invalid incident references, disabled or non-Super-Admin targets, and a request while another active enrolled Super Admin exists. It also refuses to replace an unexpired approved recovery. The operator incident reference is stored with the current recovery record and the action is written to the existing security audit. Retain the independent approval and incident record according to organizational policy. Hand the credential to the verified recipient through an approved private channel. The recipient still needs their current password and a new authenticator. This tool does not reset passwords or grant roles.

Before deployment, apply migrations 0056 and 0057 and approve the incident identity-proofing, approval, private credential handoff and audit procedures. Confirm staffing for two eligible non-target administrators for normal recovery. An administrator who also forgot their current password needs a separately approved password recovery procedure. Automated recovery notification would require a separate approved design. No live accounts or emails were used in this work.

## Verification

| Command | Result |
|---|---|
| `pnpm.cmd --filter @pulseos/api db:migrate` | Full migration chain passed on disposable PostgreSQL 18. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/platform-console.integration.test.ts` | 9 passed, 0 failed with synthetic users. Covers concurrent requests, separate approver, TOTP replay rejection, wrong password, expiry, revoked sessions, role and disablement changes, completion, token replay, and last-admin authorization. Existing onboarding, invitation, permissions and lifecycle regressions passed. The last-admin service was exercised against the fixture through the database, without invoking the interactive command against an actual administrator. |
| `pnpm.cmd --filter @pulseos/web exec playwright test e2e/platform-console.spec.ts e2e/hospital-onboarding.spec.ts` | 5 passed, 0 failed, 1 skipped using local Chrome and mocked API routes. The existing real-browser enrollment case requires a separately supplied synthetic setup token. Enrollment was exercised by the PostgreSQL integration suite. |
| API/web type checks and `git diff --check` | Passed. |

## Files

- `apps/api/src/domain/platform/platform-auth.service.ts` and `apps/api/src/domain/platform/platform.routes.ts`
- `apps/api/src/db/platform-schema.ts`, `apps/api/src/db/migrations/0056_platform_mfa_recovery.sql` and `apps/api/src/db/migrations/meta/_journal.json`
- `apps/api/src/ops/platform-recover-last-admin.ts` and `apps/api/package.json`
- `packages/api-client/src/index.ts`, `apps/web/app/platform/(console)/administrators/page.tsx` and `apps/web/app/platform/login/page.tsx`
- `apps/api/src/__tests__/platform-console.integration.test.ts` and `apps/web/e2e/platform-console.spec.ts`
- This report
