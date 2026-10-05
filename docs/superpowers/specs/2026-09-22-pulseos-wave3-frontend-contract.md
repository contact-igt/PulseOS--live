# PulseOS — Wave 3 Frontend Implementation Contract

Continuation of [2026-09-22-pulseos-omnichannel-implementation-contract.md](2026-09-22-pulseos-omnichannel-implementation-contract.md)
(Wave 1/2A/2B — CommunicationEndpoint schema + real Runo/WhatsApp endpoint resolution, now complete and
live-verified, see [final audit addendum 2](../../audits/2026-09-22-pulseos-omnichannel-journey-final-audit.md)).
This document is the file-ownership map and shared-contract record for Wave 3 (4 parallel building agents +
Controller-led live verification), so a fresh session can resume without re-deriving it.

## Controller pre-work done before dispatching Wave 3 (single-owner, avoids shared-file collisions)

To let 4 agents run in true parallel without touching the same file, the Controller (not an agent) made
these additive, already-verified (typecheck clean) changes first:

1. **`taskReasonEnum`** gained a `new_lead` value (migration `0013_loving_magus.sql`, applied). Automated
   lead ingestion (`lead-ingestion.service.ts`, the `!journeyReused` branch) now tags its first-response
   task `reason: "new_lead"` instead of the overloaded `"manual_task"` — previously New Leads and any ad hoc
   manual task were indistinguishable (a real gap found by the Wave 1 telecaller trace agent).
2. `packages/types/src/index.ts`: added `TaskReason` union, `reason: TaskReason` on `TaskRow`,
   `UpdateCommunicationEndpointInput`.
3. `apps/api/src/domain/task/task.service.ts` / `task.routes.ts`: `TaskFilters` gained `reason?: TaskReason`;
   `GET /tasks?reason=...` filters; `listTasks`/`getTaskById` both select and return `reason`.
4. `packages/api-client/src/index.ts`: `api.tasks()` accepts `reason`; `api.conversations()` accepts
   `communicationEndpointId` (Agent 3 implements the matching backend filter); added
   `api.communicationEndpoints(connectorId?)`, `api.createCommunicationEndpoint(connectorId, input)`,
   `api.updateCommunicationEndpoint(connectorId, endpointId, input)` — Agent 4 implements the matching
   `PATCH /connectors/:id/endpoints/:endpointId` route to this exact contract.

Verified: `pnpm -r typecheck` clean across all 7 packages, full API suite 256/256 green, before any Wave 3
agent started.

## File ownership (no two agents touch the same file)

| Agent | Owns | Must not touch |
|---|---|---|
| 1 — Telecaller Workspace | `apps/api/src/domain/task/task.service.ts`, `task.routes.ts` (extend only), `apps/web/app/(app)/my-work/page.tsx`, a new/extended task test file | `packages/types`, `packages/api-client`, any other domain, any other page |
| 2 — Patient 360 Communication | `apps/web/app/(app)/patients/[patientId]/page.tsx`; may touch `packages/ui/src/Timeline.tsx` only if strictly necessary (shared with Appointments/Front Desk — verify those still render if touched) | task/*, inbox page, connector/*, `packages/types` |
| 3 — Inbox endpoint filter | `apps/web/app/(app)/inbox/page.tsx`, `apps/api/src/domain/conversation/conversation.service.ts` + `conversation.routes.ts` (extend `ConversationFilters`, a local interface, not a shared type), a new/extended inbox test | patients page, task/*, connector/*, `packages/types` |
| 4 — Endpoint Config UI | `apps/api/src/domain/connector/communication-endpoint.service.ts`, `connector.routes.ts` (extend only), `apps/web/app/(app)/integrations/page.tsx`, `apps/api/src/__tests__/communication-endpoints.integration.test.ts` (extend) | task/*, inbox, patients page, `packages/types` |

All 4 report back to the Controller; the Controller runs one final full reseed + full suite + typecheck +
lint + live browser verification pass (not each agent individually), and does not use `pnpm db:seed` or the
Browser pane tools while agents are still running (shared session-wide state).

## Status — COMPLETE

Dispatched and completed 2026-09-22, same day as Wave 2A/2B. All 4 agents delivered within their owned
files with zero cross-agent file collisions (the pre-dispatch file-ownership map above held exactly).
Full results, the Controller's own permission-gap fix, and consolidated verification evidence are recorded
in [2026-09-22-pulseos-omnichannel-journey-final-audit.md](../../audits/2026-09-22-pulseos-omnichannel-journey-final-audit.md)'s
Addendum 3.

One real, previously-unknown gap surfaced during Wave 3 and fixed by the Controller afterward (not by any
single agent, since it spanned two agents' boundary): Agent 3 (Inbox) correctly flagged that
`GET /communication-endpoints` sat behind `VIEW_INTEGRATIONS`, which front desk/coordinator don't have —
so the endpoint filter dropdown Agent 3 built would never render for the staff it was built for. Fixed by
splitting the read routes into their own `communicationEndpointReadRoutes` plugin (separate Fastify
encapsulation scope, own `VIEW_COMMUNICATION_ENDPOINTS` permission hook) rather than widening
`VIEW_INTEGRATIONS` itself, which would have over-granted front desk visibility into connector secrets
status and sync controls they have no business seeing.
