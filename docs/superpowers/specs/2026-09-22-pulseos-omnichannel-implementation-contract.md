# PulseOS — Omnichannel Implementation Contract

Synthesized from 6 parallel Wave 1 read-only trace agents (domain model, Runo, WhatsApp, telecaller
workflow, Patient 360/Inbox UX, QA/security). Every claim below is sourced to a specific agent's file:line
evidence, not re-derived from memory. This is the single canonical decision document for this
implementation pass — agents/implementers should not re-litigate these decisions without new evidence.

## Decisions

### CommunicationEndpoint shape

Two independent agents (domain-model trace, WhatsApp trace) converged on the same design:

```
communicationEndpoints:
  id            uuid PK
  tenantId      uuid NOT NULL FK -> tenants.id
  connectorId   uuid NOT NULL FK -> connectors.id   -- N endpoints per 1 connector
  branchId      uuid NULL FK -> branches.id         -- optional, not every number maps 1:1 to a branch
  type          enum(PHONE, WHATSAPP) NOT NULL
  provider      text NOT NULL                        -- denormalized from connector.provider
  publicNumber  text NOT NULL                         -- E.164 hospital number
  providerRef   text NOT NULL                         -- WhatsApp phone_number_id, or a manual/config
                                                        -- label for a Runo SIM line
  displayLabel  text NOT NULL                          -- "Main Reception", "Fertility Line"
  isActive      boolean NOT NULL default true
  createdAt/updatedAt timestamps
  unique(connectorId, providerRef)
  index(tenantId)
```

### Connector uniqueness: unchanged

`connectors_tenant_provider_unique (tenantId, provider)` stays exactly as-is. Both providers' real
architecture is 1-credential-set-per-integration regardless of number count (Meta: one webhook URL per
WABA; Runo: one API key per tenant). Endpoints are the N-per-connector layer; connectors remain the
1-per-provider credential/webhook layer. Changing connector uniqueness would misrepresent both providers.

### Call ↔ endpoint / Message ↔ endpoint relationship

- `calls.communicationEndpointId`: nullable FK. Runo's API never exposes which hospital line was used
  (confirmed live against their real OpenAPI spec) — resolution can only be a manual/config default per
  connector, explicitly "best effort," never silently treated as reliable.
- `conversations.communicationEndpointId` + `messages.communicationEndpointId`: nullable FK. WhatsApp's
  webhook payload DOES carry `metadata.phone_number_id` per message (confirmed in Meta's real docs) — the
  adapter already types this field (`MetaWebhookValue.metadata.phone_number_id`) but never reads it
  (WhatsApp trace agent, `whatsapp-meta-cloud.ts`). This is a real, resolvable-today gap, unlike Runo's.
- **Known correctness risk found this pass, not previously known**: `conversations_connector_external_thread_unique`
  is keyed on `(connectorId, externalThreadId)` only. If the same patient messages two different hospital
  numbers under one WABA, both collide into the same conversation today. Widening this to include
  `communicationEndpointId` is required, with an explicit backfill decision for existing rows (assign a
  single default endpoint).

### ConversationEvent normalization: do NOT build a new model

The Patient 360/Inbox UX trace agent found that a lightweight unification **already exists**:
`whatsapp-webhook.service.ts` and `call-webhook.service.ts` both write a `timelineEvents` row at ingestion
with `relatedEntityType`/`relatedEntityId` pointing back to the source row — Timeline already interleaves
calls and WhatsApp inbound messages chronologically. Building a parallel `ConversationEvent` read model
would duplicate this. Decision: extend what exists (see Implemented This Pass) rather than build new.

### Patient/Journey association strategy — unchanged

`identity.service.ts`'s phone→patient→most-recent-active-journey resolution needs no change for this
work (domain-model trace agent, confirmed) — endpoint resolution is a webhook-layer concern, upstream of
identity resolution, not a change to identity resolution itself.

### Ambiguous Journey handling — deferred, not touched this pass

No evidence gathered this pass changes the existing `findMostRecentActiveJourney` heuristic. A genuine
`JOURNEY_LINK_REQUIRED` state (per the original master prompt's §23) is real scope, not attempted —
flagged for next phase.

### Follow-up Task behavior — two real, previously-unknown gaps found

1. **Missed calls create zero task today.** `applyDispositionMapping` only branches on `event.disposition`
   (free text); `calls.status = "missed"` is never checked. A missed call silently has no follow-up
   mechanism at all (telecaller trace agent, `call-webhook.service.ts:26-59`).
2. **`connectorDispositionMappings` table is dead code.** It exists, has a comment claiming
   "tenant-scoped, admin-editable," but `persistInboundCall` is always called with no mapping argument, so
   it always uses the hardcoded `DEFAULT_DISPOSITION_MAPPING` — nothing ever reads the DB table (Runo trace
   agent, `webhook.routes.ts:139` vs `call-webhook.service.ts:20-24`).
3. **"New Leads" and ad hoc manual tasks are indistinguishable.** Both default `reason` to `"manual_task"`
   — no current column can tell them apart (telecaller trace agent).

### Missed-call behavior: Option (a) — a real task, not a second data source

Per the telecaller trace agent's own framing: either make missed calls create a real `CALLBACK` task
(queryable identically to every other task-driven view), or have a Missed-Calls tab read `calls` directly
as a second data source inside one UI. Decision: **(a)** — extend `applyDispositionMapping`'s caller to
also check `event.status === "missed"` and create a task, keeping Tasks as the single follow-up source of
truth (matches the master prompt's explicit "do not create a second follow-up system").

### Source vs channel vs endpoint — three distinct, never-collapsed concepts

Confirmed still true, unchanged this pass: `journeys.source` (original marketing attribution, e.g. Meta
campaign) is never overwritten by which channel/endpoint a later interaction used. `calls`/`conversations`
carry their own `direction`/`channel`; endpoint (once built) is a fourth, orthogonal dimension (which
hospital line/number). No code found this pass conflates these — preserve that.

### Provider capability honesty — reconfirmed, one new buildable item found

Click-to-call, recording-fetch, and real-time polling remain confirmed PROVIDER-BLOCKED (Runo trace agent
re-confirmed against the actual adapter code, consistent with the live API research from the prior phase).
**New finding**: `POST /crm/interaction`/`/crm/allocation` (push a lead into a telecaller's Runo queue) is
genuinely buildable now, fixture-mode-first, mirroring `whatsapp-meta-cloud.ts`'s existing fixture/live
branch pattern — not attempted this pass (real scope, needs a trigger-point decision), documented for next
phase.

### Privacy/access rules — audited, foundation confirmed solid

QA/security trace agent confirmed with file:line evidence: webhook signature verification happens before
any DB write (both providers), idempotency is enforced by real DB unique constraints (not just app logic,
survives a concurrent-duplicate race via catch-and-requery), secrets are never returned by any
session-authenticated route, `/patients/:id/360` is correctly tenant-scoped. `recordingUrl` remains a
known, already-documented limitation (raw link, no signed proxy) — not newly discovered, not fixed this
pass. Nine concrete test scenarios for the future multi-endpoint work are specified in that agent's report
(tenant isolation across endpoints, duplicate-ID-reused-across-endpoints, migration constraint shape, etc.)
— reuse them verbatim when that work starts rather than re-deriving.

## Implemented this pass (see final report for verification evidence)

Given the size of the full CommunicationEndpoint migration (schema + two adapter changes + unique-index
widening + backfill decision + frontend types) relative to remaining session budget, this pass implements
the two smaller, fully-specified, high-value gaps found by the trace agents rather than the full
multi-number migration:

1. Missed call → real CALLBACK task (closes a zero-follow-up gap for every missed call).
2. Outbound WhatsApp message → Timeline event (Timeline was silently missing half of every WhatsApp thread
   — inbound-only, confirmed by the UX trace agent).

The CommunicationEndpoint schema (this document's canonical shape above) is fully specified and ready for
direct implementation in the next phase — no further research/design needed, only the ~1-2 hours of
migration + wiring work both convergent trace agents scoped it at.
