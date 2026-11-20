# Hospital invitation email delivery and recovery

## Existing and added functionality

PulseOS already provisioned one initial Hospital Super Admin per onboarding, issued a 24-hour single-use fragment link, stored its digest, recorded Platform audit events, and gated activation on invitation redemption. The existing manual issuance route and password redemption form are retained. Platform session and MFA rules are unchanged. The repository had no SMTP transport or invitation email queue.

Migration `0055_hospital_invitation_delivery` adds one durable delivery record per onboarding. With email enabled and the existing encryption key available, hospital creation queues the invitation in the provisioning transaction. The existing job runner sends a responsive text/HTML email through authenticated TLS SMTP after commit. Lack of SMTP configuration or SMTP failure leaves the successfully created hospital intact. Email status includes pending, attempted with retry pending, provider accepted, failed, expired and superseded. Existing invitation state separately shows creation, expiry and redemption.

## Security and recovery

The email uses the approved HTTPS web origin and the same fragment-based onboarding URL as manual issuance. The outbox encrypts the token and the authorized recipient with the existing AES-GCM utility. The worker locks the onboarding and delivery in that order and rechecks the original administrator, provisioning status, email, expiry and token digest before sending. Accepted, terminal, expired or superseded work clears the encrypted token. No invitation password is transmitted. The status API, audit and logs omit tokens and raw SMTP errors. The explicit manual issuance response retains its original fragment-link field and is marked no-store.

Automatic retries are bounded to three attempts per credential and reuse the same token and Message-ID. A process failure after SMTP acceptance and before the database commit can produce a duplicate email with that same single-use link. SMTP acceptance is recorded without an inbox-delivery claim.

The email resend route requires an active Platform Super Admin with invitation permission and an idempotency UUID. It verifies the original administrator and hospital, rejects redeemed invitations and active hospitals, and enforces a per-hospital 60-second cooldown shared with manual issuance. An accepted resend replaces the digest and queue payload, revoking the prior link. The onboarding lock serializes concurrent requests. Successful, replayed and denied requests for a known onboarding are audited. Existing manual issuance remains available through its original authorized endpoint and does not send email.

## Deployment

Apply migration 0055 before deploying the API. Configure `HOSPITAL_INVITATION_WEB_ORIGIN` as the exact HTTPS web origin and inject `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` and the existing `CONNECTOR_ENCRYPTION_KEY` through deployment configuration. Run the existing API jobs on the approved worker. Set `HOSPITAL_INVITATION_EMAIL_ENABLED=true` there and on the API only after provider and sender approval. The checked-in flag is disabled. Hospitals created before activation can be handled through the authorized resend path. Existing pending records are retained during a flag-off rollback and rechecked for expiry when processing resumes. Keep the encryption key available while pending invitations depend on it.

The SMTP dependency uses the maintained Nodemailer release with the recipient parsing fixes documented by its maintainer. [Nodemailer 10.4.1 release](https://github.com/nodemailer/nodemailer/releases/tag/v10.4.1)

## Verification

| Check | Result |
|---|---|
| `pnpm.cmd --filter @pulseos/api db:migrate` | Full chain passed on fresh disposable PostgreSQL 18. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/platform-console.integration.test.ts` | 7 passed. Covers existing Platform and hospital lifecycle, missing SMTP configuration, failed attempts and recovery, concurrent duplicate processing and resend, cooldown, expiry, revocation, single-use redemption, and denied resend. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/hospital-invitation-email.test.ts` | 1 passed with mocked SMTP. Verified TLS options, fragment URL, recipient, stable Message-ID and escaped hospital name. |
| `pnpm.cmd --filter @pulseos/web exec playwright test e2e/hospital-onboarding.spec.ts` | 3 passed with local Chrome and mocked APIs. Covers onboarding discovery, password redemption and invitation email status/resend. |
| API/web type checks and `git diff --check` | Passed. |

Zero live emails were sent. Verify SMTP configuration, approved sender identity and provider acceptance in a sanctioned environment before enabling the flag.

## Files changed

- `apps/api/src/domain/tenant/hospital-invitation-delivery.service.ts`, `hospital-onboarding.service.ts` and `hospital-onboarding.routes.ts`
- `apps/api/src/db/migrations/0055_hospital_invitation_delivery.sql`, migration journal and Drizzle schema
- `apps/api/src/server.ts`, `apps/api/.env.example`, `apps/api/package.json` and `pnpm-lock.yaml`
- `packages/api-client/src/index.ts` and `packages/types/src/index.ts`
- `apps/web/app/platform/(console)/hospitals/[id]/hospital-details.tsx` and `apps/web/app/platform/(console)/platform-ui.tsx`
- `apps/api/src/__tests__/platform-console.integration.test.ts`, `hospital-invitation-email.test.ts` in the same directory, and `apps/web/e2e/hospital-onboarding.spec.ts`
- This report
