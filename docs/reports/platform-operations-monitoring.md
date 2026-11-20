# Platform Super Admin operations and integration monitoring

## Repository audit and delivered scope

| Capability | Before this pass | Delivered |
|---|---|---|
| Platform navigation, hospital directory and MFA | Implemented | Reused the existing Platform layout, session checks and permissions. |
| Hospital, lifecycle and onboarding dashboard | Partial | Added provisioning, failed onboarding, messaging queue, aged pending and recorded connector problem totals. |
| Hospital operations detail | Partial | Added recorded WhatsNexus connector status, mode, sync time, sanitized remote tenant ID and hospital-scoped audit actions. Existing lifecycle, onboarding, permit counts and command history remain in place. Older lifecycle observations are labeled as historical. |
| Centralized operational exceptions | Missing | Added the Platform Operations page and paginated, read-only `GET /platform/operations/messaging`. Filters accept command status and exact hospital tenant UUID. Refresh reads stored records and links to hospital details. |
| Coordination and retry audit | Implemented | Reused the existing retry grant, command identity and lifecycle audit on hospital detail. Operations access confers no mutation grant. |
| Coordination alerts | Partial | Added structured exceptions after a committed state update and added command/hospital examples to the existing aged-pending alert. |

Dashboard metrics count stored records. Failed onboarding counts records with a provisioning error or failed template. Connector problems count distinct hospitals with a LIVE connector recorded as DEGRADED or ERROR. Connector status and sync time are recorded evidence. Only the existing independently verified coordination observation represents a remote messaging state.

## Observability and safety

The 15-minute aged warning runs at most once every five minutes per worker and includes at most ten command/hospital references. A committed terminal failure emits one warning per processing cycle with its classified error. Transport failure additionally warns on attempt three. A new PAUSING condition with unresolved permits emits a warning with the count. Reprocessing a terminal command does not emit another warning. An authorized retry begins a new audited cycle.

Log payloads contain identifier references, an allowlisted application classification, attempt counts and unresolved permit counts. The exception endpoint has a minimal projection and omits partner origins, connector secrets, pairing revisions, raw acknowledgements and provider payloads. Recent hospital audit is returned only with the existing audit grant. Hospital admins cannot access the Platform route. Platform Operations admins can read through the existing lifecycle-read grant. Mutation permissions remain separate.

No migration, production flag, connector credential, external coordination policy or WhatsNexus code changed. Live alert routing and deployed worker ownership require staging approval. The existing cross-system production activation remains NO-GO.

## Verification

| Command | Result |
|---|---|
| `pnpm.cmd --filter @pulseos/api db:migrate` | Passed on fresh disposable PostgreSQL 18. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/hospital-messaging.integration.test.ts` | 12 passed, 0 failed. Includes hospital-session denial, Operations read access, Super Admin hospital-scoped audit, filtered queue results, sanitized responses, and one terminal auth warning across repeated ticks. |
| `pnpm.cmd --filter @pulseos/api exec vitest run src/__tests__/platform-console.integration.test.ts` | 6 passed, 0 failed on a separately seeded disposable schema. Includes legacy hospital suspension and restoration. |
| `pnpm.cmd --filter @pulseos/web exec playwright test e2e/platform-operations.spec.ts e2e/hospital-lifecycle.spec.ts` | 2 passed, 0 failed on local Next.js with installed Chrome and mocked API. Includes dashboard counts, pending/failed and hospital filters, pagination, retry, stale pairing, refresh errors and a mobile viewport. |
| API/web `typecheck` and `git diff --check` | Passed. |

## Files changed

- `apps/api/src/domain/platform/platform-directory.service.ts` and `platform.routes.ts`
- `apps/api/src/domain/tenant/hospital-lifecycle-operations.service.ts`, `hospital-lifecycle.routes.ts`, and `hospital-messaging.service.ts`
- `apps/api/src/server.ts`
- `packages/types/src/index.ts` and `packages/api-client/src/index.ts`
- Under `apps/web/app/platform/(console)` the files `layout.tsx`, `page.tsx`, `hospitals/[id]/hospital-details.tsx`, `hospitals/[id]/hospital-lifecycle.tsx` and `operations/page.tsx`
- `apps/api/src/__tests__/hospital-messaging.integration.test.ts` and `apps/web/e2e/platform-operations.spec.ts`
- This report
