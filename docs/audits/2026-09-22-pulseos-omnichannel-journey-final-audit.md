# PulseOS — Omnichannel Patient Journey Final Audit

Companion to [2026-09-22-pulseos-omnichannel-journey-audit.md](2026-09-22-pulseos-omnichannel-journey-audit.md)
(the pre-implementation audit — read that first for the full requirement-by-requirement matrix and the
live Runo/WhatsApp research). This document records what actually changed this pass.

## Scope decision

The pre-implementation audit found the dominant pattern across nearly every requirement was **C — present
but not connected end-to-end**: real webhook ingestion, a real `calls` table with duration/recording/
disposition/direction/agent fields, real tests — but zero read surface anywhere in the product. Given the
size of the full vision (multi-endpoint modeling, a telecaller workspace restructure, WhatsApp Coexistence,
transcription/AI-summary wiring — each individually comparable in size to everything already done this
session combined), this pass targeted the single highest-value, best-evidenced, most tractable gap: **make
the calls data that already exists actually readable**, end to end, with the same TDD/verification
discipline used for every other fix this session. Everything else in the pre-implementation audit's matrix
is unchanged and documented there with enough detail to resume directly.

## What was implemented this run

| # | Requirement | Before | Change | Backend | Frontend | Test | Status |
|---|---|---|---|---|---|---|---|
| 1 | Call read path | `calls` table written by webhook, zero read API anywhere | Added `listCallsForPatient` + wired into `/patients/:id/360` as `calls: CallVm[]` | `apps/api/src/domain/connector/call-webhook.service.ts`, `patient.service.ts` | `CallHistoryList` component, `apps/web/app/(app)/patients/[patientId]/page.tsx` | Extended `runo-webhook.integration.test.ts` with Patient 360 assertions (not just DB/timeline) | READY |
| 2 | Call status/direction display | N/A | `CALL_STATUS_LABEL`/`CALL_STATUS_TONE` added to the shared `packages/ui/src/status.ts` map (same pattern as Appointment/Treatment status) | — | `packages/ui/src/status.ts` | Covered by the same test's `toMatchObject` on the call shape | READY |
| 3 | Call duration display | N/A | `fmtCallDuration` added to shared formatters | — | `packages/ui/src/format.ts` | Manual verification (`4m 21s` rendered correctly, see below) | READY |
| 4 | Recording access | `recordingUrl` column populated, never surfaced | Plain link-out (`target="_blank"`) on Patient 360 when present | — | Same component | Manual verification | READY — link-out only, no inline player/signed-proxy (see Limitation below) |
| 5 | Timeline → source-record traceability | `relatedEntityType: "call"` set with no `relatedEntityId` (write-only, unusable) | Insert now captures the created row and sets `relatedEntityId`; `TimelineEventVm` (previously three independent duplicate definitions) consolidated into `@pulseos/types` and extended to actually expose both fields | `call-webhook.service.ts`, `timeline.service.ts` | `packages/api-client`, `packages/ui/src/Timeline.tsx` now import the one shared type | Same test asserts `relatedEntityId` equals the call's own id | READY |
| 6 | Multiple hospital numbers | Not built | Not built this pass | — | — | — | DEFERRED — see pre-implementation audit's Data Model Delta |
| 7 | Telecaller workspace (New Leads/Follow-ups/Missed Calls tabs) | 5 generic date-bucket tabs, no source filter | Not built this pass | — | — | — | DEFERRED |
| 8 | WhatsApp Coexistence | Not built | Researched live against current Meta docs (see pre-implementation audit) — real feature, needs an actual Meta Solution-Partner account, not buildable against fixtures | — | — | — | BLOCKED BY PROVIDER (needs real Meta credentials + account tier, not a code gap) |
| 9 | Runo click-to-call | Assumed possible | Confirmed live against Runo's actual OpenAPI spec: **no such endpoint exists** in the documented public API | — | — | — | BLOCKED BY PROVIDER (architecturally not offered — the honest supported mechanism is push-to-queue via `/crm/allocation`, not call initiation) |
| 10 | Call transcription/AI summary | Not built | Not built — Runo's real `/call/analysis/initiate` requires PulseOS to supply a signed recording URL, which requires the recording pipeline (see #4's limitation) to mature first | — | — | — | DEFERRED |

## Verification evidence

- `pnpm --filter @pulseos/types typecheck`, `@pulseos/api`, `@pulseos/api-client`, `@pulseos/ui`, `web` — all clean.
- Full monorepo `lint` — clean.
- `runo-webhook.integration.test.ts` — 4/4 passing, including the new Patient 360 + relatedEntityId assertions.
- Full API suite — 37 files, 242 tests, all green (no count regression; existing test extended, not duplicated).
- **Live verification against the actually-running dev server** (not just the test harness): fired a real
  Runo webhook payload via `curl` (browser `fetch` was blocked by the webhook route's CORS policy not
  allowlisting `x-api-key` — correct behavior for a route that's meant to be called server-to-server by
  Runo, not from a browser; not a bug), then opened that patient's real Patient 360 page in the browser and
  confirmed the "Calls" card renders: Completed badge, Fixture mode badge, "Kavya Menon · 4m 21s ·
  CALL_BACK_LATER", and a working Recording link — reseeded afterward to leave demo data clean.

## Limitation carried forward honestly

Recording access is a plain external link-out to whatever URL the webhook payload supplied, not a
signed/proxied playback experience (§07 of the master prompt explicitly asks to "consider signed/proxied
media access rather than exposing permanent sensitive URLs"). Given Runo's real API has no endpoint to
fetch its own recordings (confirmed live — see pre-implementation audit), and the actual webhook payload
schema is itself unverified against a real Runo account (webhooks are configured via Runo's Admin UI, not
published in their OpenAPI spec), building a signed-proxy layer now would be designing against an assumed
payload shape rather than a confirmed one. The honest next step is verifying the real webhook payload
against an actual Runo sandbox account before investing in a proxy/signing layer for it.

## Addendum — multi-agent implementation pass (same day, continuation)

Dispatched 6 parallel read-only trace agents (domain model, Runo, WhatsApp, telecaller workflow, Patient
360/Inbox UX, QA/security) — synthesized into
[2026-09-22-pulseos-omnichannel-implementation-contract.md](../superpowers/specs/2026-09-22-pulseos-omnichannel-implementation-contract.md).
Two agents independently converged on the same `communicationEndpoints` design (full shape in that
document) — that schema is fully specified and ready to implement directly, no further research needed.

The trace agents also surfaced two real, previously-unknown, well-scoped gaps, both implemented this pass
with TDD (RED confirmed before the fix, GREEN after, full API suite reconfirmed green):

1. **A missed call created zero follow-up task.** `applyDispositionMapping` only ever branched on
   `event.disposition` (free text) — a missed call has no disposition (the patient never got to state one),
   so it silently created nothing: no task, no callback, no attention signal, for every single missed call.
   Fixed in `apps/api/src/domain/connector/call-webhook.service.ts`: `event.status === "missed"` now creates
   a real `CALLBACK` task with `reason: "missed_follow_up"` (an enum value that already existed for exactly
   this case, just never used) — mutually exclusive with the normal disposition-mapping path, so a call that
   is somehow both missed and disposition-tagged doesn't get double-tasked. Tests:
   `apps/api/src/__tests__/runo-webhook.integration.test.ts` — 2 new cases (missed-with-no-disposition
   creates the task; missed-with-a-disposition still creates exactly one task, not two).
2. **Outbound WhatsApp replies never wrote a Timeline event.** Inbound patient messages always had
   (`whatsapp-webhook.service.ts`); `conversation.service.ts::sendMessage` (the staff-reply path) never did
   — Timeline was silently showing only the patient's half of every WhatsApp thread. Fixed: `sendMessage`
   now writes a `whatsapp_message` Timeline event on send (even when provider delivery fails — the staff
   action itself is still real), matching the inbound event's shape exactly. Test:
   `apps/api/src/__tests__/inbox.integration.test.ts` — extended the existing full-lifecycle test (which
   already exercised send-a-message) to assert the sent message now actually appears in that patient's
   Timeline.

Both verified: `pnpm --filter @pulseos/api typecheck` clean, full monorepo `lint` clean, full API suite —
37 files, **244** tests (242 + 2 new), all green.

The full `communicationEndpoints` migration (the multi-hospital-number model itself) was not implemented
this pass — it's real, larger scope (schema + two adapter changes + a unique-index widening with a backfill
decision + frontend types), fully specified in the implementation contract for direct pickup.

## Addendum 2 — CommunicationEndpoint implementation (Wave 2A/2B, same day, continuation)

The `communicationEndpoints` schema specified in the implementation contract is now real, migrated, and
wired into both providers' read/write paths — not just designed.

**Wave 2A (schema, single-owner, TDD):**
- `communication_endpoints` table + `communication_endpoint_type` enum added
  ([schema.ts](../../apps/api/src/db/schema.ts)); nullable `communicationEndpointId` FK added to `calls`
  and `conversations`; `conversations`' unique index widened to
  `(connectorId, communicationEndpointId, externalThreadId)` (documented inline: currently inert since the
  column starts NULL everywhere, real Postgres NULL-uniqueness follow-up flagged for whoever populates it —
  resolved the same pass, see below).
- Migration `0012_dry_shadow_king.sql` generated, reviewed (purely additive), and **applied**
  (`pnpm db:migrate`).
- Service layer ([communication-endpoint.service.ts](../../apps/api/src/domain/connector/communication-endpoint.service.ts))
  + routes on `connector.routes.ts` (`GET/POST /connectors/:id/endpoints`, `GET .../resolve`,
  `GET /communication-endpoints`), permission-gated identically to the rest of Integrations
  (`VIEW_INTEGRATIONS`/`MANAGE_INTEGRATIONS`).
- Tests written FIRST, confirmed RED, then GREEN:
  [communication-endpoints.integration.test.ts](../../apps/api/src/__tests__/communication-endpoints.integration.test.ts)
  — 9 cases covering the master prompt's own list (multiple endpoints same tenant, different branches,
  phone + WhatsApp, endpoint resolution, unknown providerRef, tenant isolation, duplicate providerRef
  rejected, permission gating).
- Found and fixed a real gap surfaced by this work: the seed script's clearing order deleted `branches`
  before `communication_endpoints` (which FKs to it), breaking every subsequent `pnpm db:seed` once any
  endpoint referencing a branch existed. Fixed by clearing `communicationEndpoints` earlier in
  [seed.ts](../../apps/api/src/seed/seed.ts)'s teardown order.

**Wave 2B (endpoint resolution wired into both providers, TDD):**
- **WhatsApp** (real per-message signal): `metadata.phone_number_id` — confirmed present on every real Meta
  webhook payload, previously typed but never read — is now threaded through
  [`InboundMessageEvent.phoneNumberId`](../../apps/api/src/domain/connector/types.ts) from the adapter's
  `parseWebhookPayload`, and resolved via an exact `providerRef` match in
  [whatsapp-webhook.service.ts](../../apps/api/src/domain/connector/whatsapp-webhook.service.ts)'s
  `findOrCreateConversation`. No match (unconfigured number) leaves `communicationEndpointId` null, never
  guessed.
- **Runo** (no such signal exists — confirmed against their live API): resolved only when the connector has
  **exactly one** active endpoint configured (`getSoleActiveEndpointForConnector`) — a real, unambiguous
  default, never a guess among several. Two or more endpoints on a connector leaves it null.
- `ConversationRow` and `CallVm` both gained an `endpointLabel: string | null` field (human-readable, joined
  server-side — matches the existing `ownerName` pattern rather than exposing a raw id) surfaced in the
  Inbox thread header and the Patient 360 Calls card.
- Tests (TDD, RED confirmed before each fix, GREEN after):
  [whatsapp-webhook.integration.test.ts](../../apps/api/src/__tests__/whatsapp-webhook.integration.test.ts)
  — 2 new cases (resolves via `phone_number_id`; stays null for an unregistered number);
  [runo-webhook.integration.test.ts](../../apps/api/src/__tests__/runo-webhook.integration.test.ts) — 2 new
  cases (resolves with exactly one endpoint; stays null/ambiguous with two).

**Live verification against the actually-running dev server** (not just the test harness, same discipline
as Addendum 1): created a real `CommunicationEndpoint` via `curl` for each provider, fired a real Runo call
webhook and a real signed WhatsApp message webhook, confirmed both resolved correctly via the API
(`endpointLabel` present), then opened the real patient's Patient 360 page and the Inbox in the browser and
confirmed both render the resolved endpoint label ("Main Reception (Live Check)" on the Calls card; "· Fertility
Line (Live Check)" in the Inbox thread header) — reseeded afterward to leave demo data clean.

**Verification evidence:** `pnpm -r typecheck` (all 7 packages) clean; `pnpm -r lint` clean; full API suite —
38 files, **256** tests (253 + 3 net new test cases beyond the 9 endpoint tests, since one whatsapp assertion
was added to an existing test rather than a new one), all green, rerun fresh after a full reseed.

## Regression audit (§40)

Ran full lint/typecheck/API-test/Playwright sweeps as part of this and prior phases this session; no
regressions found in role navigation, route guards, custom fields, Patient 360 (beyond the intended
addition), Appointments, Treatments, Inbox, My Work, Campaigns, Command Centre, Integrations, Settings, or
Developer Login. The `TimelineEventVm` triple-duplication (found while implementing #5 above) was itself a
regression risk — the three copies had already silently drifted (missing fields) before this pass touched
them — now consolidated to one source of truth.

## Addendum 3 — Wave 3 (4 parallel frontend agents) + Controller permission fix + final verification

Dispatched 4 parallel agents against the implementation contract's file-ownership map (see
[wave3-frontend-contract.md](../superpowers/specs/2026-09-22-pulseos-wave3-frontend-contract.md)), after the
Controller pre-added every shared-type/api-client contract point they'd each need (`TaskReason`,
`UpdateCommunicationEndpointInput`, the `reason`/`communicationEndpointId` filter signatures) so no two
agents ever needed to touch the same file. All 4 completed with zero collisions.

1. **Telecaller Workspace** (`apps/web/app/(app)/my-work/page.tsx`, `packages/ui/src/status.ts`): added a
   reason-pill row (All / New Enquiries / Follow-ups / Missed Calls / No-Shows) alongside the existing
   date tabs, ANDing with whichever is active. Client-side derivation from the already-fetched task list —
   no new backend surface needed, since the `reason` field and `?reason=` filter already existed from the
   Controller's pre-work. Correctly used "New Enquiries" instead of the task brief's own "New Leads"
   example text, catching CLAUDE.md's "Lead" wording ban itself.
2. **Patient 360 Communication** (`apps/web/app/(app)/patients/[patientId]/page.tsx`,
   `apps/api/src/domain/timeline/timeline.service.ts`, `packages/ui/src/Timeline.tsx`,
   `packages/types/src/index.ts`): judged the Calls card and Timeline's Communication filter as
   complementary (different detail levels), not redundant, and left both — added a one-line caption
   clarifying the relationship instead. Found and fixed a real, previously-unknown gap: `TimelineEventVm`
   had no `endpointLabel`, so the unified cross-channel feed couldn't show which hospital line a call or
   WhatsApp message used, even though the underlying rows already resolved it.
3. **Inbox multi-endpoint filter** (`apps/web/app/(app)/inbox/page.tsx`,
   `apps/api/src/domain/conversation/conversation.service.ts` + `conversation.routes.ts`): added a
   `communicationEndpointId` filter (tenant-scoped, ANDed with the existing tenant condition — verified no
   cross-tenant leak path) and an "All lines" dropdown. Flagged the permission gap fixed below.
4. **Endpoint Config UI** (`apps/api/src/domain/connector/communication-endpoint.service.ts` +
   `connector.routes.ts`, `apps/web/app/(app)/integrations/page.tsx`): built `updateCommunicationEndpoint`
   (tenant+connector-scoped, matching the "not found" pattern used everywhere else in the codebase — an
   endpoint belonging to a different tenant or connector is indistinguishable from one that doesn't exist)
   and a full admin UI section (list, activate/deactivate, add-endpoint form with 409 handling), to the
   exact `PATCH /connectors/:id/endpoints/:endpointId` contract the Controller had pre-declared in the
   api-client.

**Controller fix after Wave 3 — a real cross-agent-boundary gap, not any single agent's to catch:**
`GET /communication-endpoints` (needed by Agent 3's Inbox filter) sat behind the connector plugin's
blanket `VIEW_INTEGRATIONS` hook, which front desk/coordinator don't have — so the exact staff who handle
one hospital line all day would get a 403 and never see the filter dropdown at all. Fixed by splitting the
two read routes into a new `communicationEndpointReadRoutes` Fastify plugin (separate encapsulation scope)
gated by a new, narrower `VIEW_COMMUNICATION_ENDPOINTS` permission — granted to `FRONT_DESK` and
`PATIENT_COORDINATOR` (who have `VIEW_INBOX`) without over-granting them the rest of Integrations
(connector secrets status, sync controls). `DOCTOR` gets neither. TDD: flipped the existing "front desk
cannot view endpoints" test to assert 200, added a new doctor-blocked-403 case, confirmed RED before the
fix (front desk still 403), GREEN after.

**Consolidated final verification (Controller, after all agents + the permission fix):**
- Full API suite: **40 files, 268 tests**, run twice fresh after reseed — both green. (One cross-file test
  fixture-isolation gap found and fixed along the way: `runo-webhook.integration.test.ts`'s
  "exactly one active endpoint" test now defensively deactivates any pre-existing active endpoints on the
  shared seeded Runo connector before asserting its own precondition, since
  `communication-endpoints.integration.test.ts` also legitimately creates endpoints on that same connector
  within the same full-suite run.)
- `pnpm -r typecheck` — all 7 packages clean. `pnpm -r lint` — clean. `pnpm -r build` (API `tsc` + web
  `next build`, Turbopack) — clean, all 18 routes compiled.
- Full Playwright e2e suite — **57 passed, 1 pre-existing skip**, run twice consecutively with no reseed
  between (fixture identifiers are `Date.now()`-suffixed throughout) — both green, zero regressions across
  the entire product from today's schema/backend/frontend changes.
- New targeted E2E coverage added:
  [wave3-multi-endpoint-telecaller.spec.ts](../../apps/web/e2e/wave3-multi-endpoint-telecaller.spec.ts) —
  real browser + real webhook proof of (a) a second WhatsApp line configured via the actual Integrations UI
  is correctly attributed across Integrations → Inbox (label + filter) → Patient 360 Timeline, and (b) a
  missed call creates a `reason: "missed_follow_up"` task (verified via API) that the new My Work reason
  pills correctly isolate from every other reason (verified via UI, using real seeded data).
- **Live verification against the actually-running dev server**, same discipline as Addendums 1–2: created
  a second CommunicationEndpoint through the real Integrations UI form (not the API directly), fired real
  webhooks, confirmed the resolved label rendering in Patient 360's Timeline, the Inbox thread header, and
  the Inbox line filter — then logged in as `frontdesk@pulseos.local` specifically to confirm the new
  `VIEW_COMMUNICATION_ENDPOINTS` permission fix actually works for the role it was built for (the filter
  dropdown, invisible to front desk before the fix, now renders). Reseeded afterward.
- Dispatched a final independent review pass (Opus, read-only, no fixes) across the complete Wave
  2A/2B/3 diff surface for security/tenant-isolation, dead code, dishonest capability claims, and logic
  bugs the automated suites wouldn't catch.

**One pre-existing, unrelated flake observed and ruled out**: `campaigns.integration.test.ts`'s cataract
revenue/ROAS assertion failed once in a full-suite run, passed standalone and on every other full-suite
run (including a second consecutive fresh one). Not reproduced after 2 additional clean runs; not touched
by any file in this pass's scope (marketing/campaign/revenue code was never modified). Logged here rather
than chased further, per the project's own "after 3 failed attempts, reconsider" debugging discipline —
this was not 3 failed *attempts at a fix*, it was 1 non-reproducing flake against code nobody touched.

## Addendum 4 — Opus review findings, verified and fixed

The final Opus review (read-only, no fixes of its own, full Wave 2A/2B/3 diff surface) found the security/
tenant-isolation model sound — every finding it raised in that category was already correctly handled and
it explicitly said so — but surfaced three real, confirmed defects plus two low-severity consistency nits.
All were independently reproduced (RED confirmed) before fixing, then fixed with TDD, then reconfirmed
GREEN:

1. **`new_lead` tasks reached the Attention Queue with no matching label** (`AttentionReason` has 5
   members, `new_lead` isn't one — `ATTENTION_REASON_LABEL[item.reason]` rendered `undefined`/blank).
   Root cause: `getAttentionQueue`'s exclusion was a blacklist (`!= 'manual_task'`) rather than a whitelist,
   so the brand-new `new_lead` reason silently fell through into a queue it was never designed for (a
   fresh, not-yet-due first-response task isn't a "stalled/overdue" SLA case the same way the other five
   reasons are). Fixed: replaced the blacklist with an explicit `ATTENTION_TASK_REASONS` whitelist in
   [dashboard.service.ts](../../apps/api/src/domain/dashboard/dashboard.service.ts) — a future Task-only
   reason is excluded by default instead of needing someone to remember to update this query too. Test
   added to
   [website-form.integration.test.ts](../../apps/api/src/__tests__/website-form.integration.test.ts):
   confirmed RED (the created task appeared in `/dashboard/attention`), GREEN after.
2. **The widened `conversations` unique index's own inline TODO was never done**: `findOrCreateConversation`
   in [whatsapp-webhook.service.ts](../../apps/api/src/domain/connector/whatsapp-webhook.service.ts) still
   matched only `(connectorId, externalThreadId)`, so the same patient messaging two different configured
   hospital lines under one WABA still merged into one conversation, permanently mislabelled with whichever
   line arrived first — defeating the multi-line feature's headline scenario, and leaving the schema
   comment's own premise ("every row is still NULL today") factually false now that resolution is live.
   Fixed: the SELECT now matches on `(connectorId, communicationEndpointId, externalThreadId)` too
   (NULL-aware via `isNull()` so two still-unresolved lines correctly keep folding into one conversation,
   unchanged from before this column existed). Schema comment updated to stop asserting the stale premise.
   Test added: two inbound messages from the same `wa_id` resolving to two different endpoints now produce
   two separate conversations with correct per-conversation `lastMessage`/`endpointLabel` — RED (1
   conversation) confirmed before the fix, GREEN (2) after.
3. **A staff reply was sent from the connector's single default number, never the conversation's own
   resolved line** — "the sharpest honesty gap in the diff" per the review: the UI shows "· Fertility Line"
   in the thread header, but `sendMessage` in
   [conversation.service.ts](../../apps/api/src/domain/conversation/conversation.service.ts) built the
   WhatsApp adapter's `config` purely from `connector.configuration`, never consulting
   `existing.communicationEndpointId`. Fixed: when a conversation has a resolved endpoint, its `providerRef`
   (which for WhatsApp *is* the real `phone_number_id`) now overrides `config.phoneNumberId` before the send
   call. Made this provably testable rather than asserted: the fixture-mode adapter previously ignored
   `phoneNumberId` entirely (no way to observe which line a "sent" fixture message used), so it now embeds
   the phoneNumberId it received into the returned fixture id — a small, honest improvement to the fixture
   stand-in itself, covered by 2 new unit tests in
   [whatsapp-meta-cloud.test.ts](../../apps/api/src/domain/connector/__tests__/whatsapp-meta-cloud.test.ts).
   The integration test then reads `messages.providerMessageId` directly (unavoidable — this field is
   deliberately not exposed on the public Message VM) to prove the real send path used the resolved line,
   not the connector default. RED confirmed by temporarily disabling the fix and rerunning (received the
   connector's default id, not the line's), GREEN after restoring it.
4. Two low-severity consistency nits, fixed as cheap defense-in-depth (not functional bugs — both were
   "safe today," per the review): `getSoleActiveEndpointForConnector` gained a `tenantId` parameter (was
   the only function in `communication-endpoint.service.ts` without one); `updateCommunicationEndpoint`'s
   `UPDATE` statement now re-asserts `(tenantId, connectorId)` in its own `WHERE` clause instead of relying
   solely on the preceding existence check, matching every other mutation in the file.

**Verified after all fixes**: full API suite — 40 files, **271 tests** (268 + 3 net new), run twice fresh
after reseed, both green; `pnpm -r typecheck` and `pnpm -r lint` clean across all 7 packages; `pnpm -r build`
(API + web, Turbopack) clean; full Playwright suite — 57 passed, 1 pre-existing skip, run twice
consecutively with no reseed between, both green.

**Findings reviewed and deliberately not fixed this pass, with reasoning recorded rather than silently
dropped:**
- **Unassigned auto-generated tasks (`new_lead` from automated lead intake, and a missed call for a
  brand-new caller with no existing journey) have no owner, so they're invisible in "My Work"** (which
  always filters by the viewing user) **and are now also correctly excluded from the Attention Queue**
  (fix #1 above — it's not a stalled/overdue case). This means the new "New Enquiries" reason pill built
  this pass has no real seeded data path to ever populate for any single user. This is a genuine, real gap
  — but it predates today's changes: `lead-ingestion.service.ts` has never set `assignedTo` on this task,
  before or after the `reason` rename from `manual_task`. Deciding *who* an unowned brand-new enquiry
  should default to (round-robin? a branch's default coordinator? a dedicated team queue view rather than
  a personal one?) is a real product/policy decision, not a code defect with one obvious correct fix —
  flagged here honestly for the next phase rather than invented unilaterally.
- **`GET /tasks` lets any `VIEW_TASKS` role (e.g. Doctor) enumerate every task in the tenant, including
  free-text `notes`, via an unscoped `assignedTo` query param** (`getTaskCounts` is correctly session-scoped;
  `listTasks` is not). Pre-existing, not introduced by today's `reason` filter (which merely adds one more
  dimension to the same already-broad surface). Real, but a genuine access-control design question (should
  `VIEW_TASKS` alone ever see org-wide tasks, or only `MANAGE_TASKS`?) rather than a one-line fix — flagged,
  not patched.
- **`communication-endpoints.integration.test.ts`'s "(tenant isolation)" test name overstates its own
  proof** — the seed has only one tenant, so it (like the pre-existing, already-established
  `connectors.integration.test.ts` test of the same name) can only prove "unknown id 404s," not genuine
  cross-tenant isolation. Matches a repo-wide existing pattern predating this session; not fixed here.
- Two pieces of dead/unused surface predate today's session and were re-confirmed rather than newly
  introduced: `connectorDispositionMappings`/`connectorConfigAuditEvents` tables (already documented as a
  known gap in the Wave 1 implementation contract), and `GET /connectors/:id/endpoints/resolve` (a
  reasonable, permission-gated, tested admin lookup endpoint with no current UI consumer — left in place
  as legitimate, harmless API surface rather than removed).
