# PulseOS — Omnichannel Patient Journey Audit (pre-implementation)

Prompt identity: "PULSEOS — OMNICHANNEL PATIENT JOURNEY + RUNO + WHATSAPP + TELECALLING FULL AUDIT +
IMPLEMENTATION MASTER LOOP" (2026-09-22). This document is the required §02 first deliverable: a grounded
BUILT/PARTIAL/NOT-BUILT audit, produced BEFORE any new design or implementation, using direct code reading
(a dedicated read-only agent read every relevant file in full — not grep-only) and current official
provider documentation (fetched live, not recalled from training data).

Classification key: **A** built+verified · **B** built but incomplete · **C** present but not connected
end-to-end · **D** not built · **E** deferred intentionally.

## Executive summary

There is substantially more real infrastructure than a fresh read of this prompt would suggest — a genuine
`calls` table with duration/recording/disposition/direction/agent fields, a real Runo webhook adapter with
signature verification, a real WhatsApp Cloud API adapter (genuine Meta Graph API calls in live mode,
honest fixture mode for demo), connector event idempotency, and a disposition→task mapping. But the
dominant pattern across almost every item is **C — present but not connected end-to-end**: data is written
correctly by webhook handlers and covered by real integration tests, but essentially nothing reads it back.
Calls are 100% write-only today: no API route, no `api.calls()` client method, no frontend surface anywhere
displays a single call. There is no multi-endpoint (multiple hospital phone number) model at all — one
connector per provider per tenant, full stop. There is no "Call" button anywhere in the product.

## Requirement-by-requirement audit

| # | Requirement | Class | Evidence | Gap / Next action |
|---|---|---|---|---|
| 1 | Patient identity | A | `identity.service.ts::resolveOrCreatePatient` — single shared path, already audited in prior sessions | none |
| 2 | Journey identity | A | Pre-existing, verified in prior sessions | none |
| 3 | Phone normalization | A | `patient/phone.ts::normalizePhone`/`resolveDefaultPhoneRegion`, E.164, already audited | none |
| 4 | Multiple hospital numbers | **D** | `connectors` table has a unique `(tenantId, provider)` constraint (`schema.ts` ~L479) — one WhatsApp connector, one Runo connector per tenant. No `branches.phone` field, no `CommunicationEndpoint` table | Needs new table + relaxed connector uniqueness — see Data Model Delta below |
| 5 | Call ingestion (inbound) | A | `apps/api/src/domain/connector/call-webhook.service.ts` — real webhook handler, persists to `calls`, creates `timelineEvents`, applies disposition→task mapping. Tested: `runo-webhook.integration.test.ts` | none for ingestion itself |
| 6 | Call direction | A | `calls.direction` enum (inbound/outbound), populated from Runo's `type` field | none |
| 7 | Call agent | B | `calls.agentName` (string) — Runo's own API only exposes agent NAME, never an ID/phone (confirmed against the real Runo OpenAPI spec, see below), so this can never be resolved to a PulseOS `users` row automatically | Accept as a display-only string; do not attempt automatic agent-user linking (Runo doesn't support it) |
| 8 | Call duration | A | `calls.durationSeconds`, populated | none |
| 9 | Call disposition | A | `calls.disposition`, mapped via `connectorDispositionMappings` to task-creation rules | none |
| 10 | Call recording | **C** | `calls.recordingUrl` column exists and is populated IF the webhook payload supplies one — but Runo's real public API (confirmed live, see below) has **no endpoint to fetch a call's recording URL**; recordings only leave Runo via whatever the (undocumented) webhook payload happens to include | Cannot promise recording playback as a V1 guarantee — payload-dependent, must verify against an actual Runo webhook delivery, not assumed |
| 11 | Recording playback | D | No frontend surface reads `calls` at all (see #16) | Blocked on #16 first |
| 12 | Missed calls | B | `calls.status` includes `missed`; Runo's `type` enum is `incoming/outgoing/missed` and is correctly mapped | No missed-call QUEUE/UI exists (see #17) |
| 13 | Call transcription | D | Not built. Runo's real "AI Call Analysis" feature (confirmed live) requires **you to supply a signed recording URL to Runo**, i.e. it's an analysis-as-a-service call, not something Runo does automatically on its own recordings | See Runo Research below — real feature, not yet wired |
| 14 | Call summary | D | Same as above — `/call/analysis/result/{id}` returns a `score` + structured `analysis`, unused | Deferred — see §50 scope note |
| 15 | Next action from call | A | `call-webhook.service.ts` creates a CALLBACK task from disposition mapping | none |
| 16 | Runo lead sync (push TO Runo) | **D** | Not implemented. Runo's real `/crm/interaction` / `/crm/allocation` POST endpoints (push a lead into a telecaller's queue) are never called anywhere in the codebase | Would be needed for the "New Lead → telecaller sees it in Runo app" half of the flow, separate from inbound webhook ingestion |
| 17 | Runo call sync (pull) | D | Not implemented, and Runo's own `/call/logs` GET is **past-dates-only** (confirmed live) — cannot be used for same-day reconciliation | Only usable as an end-of-day reconciliation job, not real-time |
| 18 | Runo webhooks | B | Inbound webhook receiver exists and is real (signature-verified); the actual webhook payload SCHEMA is configured in Runo's own Admin UI and is **not published in Runo's OpenAPI reference** — current adapter's payload shape is an assumption, unverified against a real Runo account | Needs verification against an actual Runo sandbox/account before calling this production-ready |
| 19 | Runo API polling/reconciliation | D | Not built | See #17 |
| 20 | Runo click-to-call | **D — not possible via documented API** | Confirmed live against Runo's real OpenAPI spec: no call-initiation/dial endpoint exists anywhere in the public API (Users/Call Logs/CRM/Customers/AI Call Analysis are the only tag groups) | Cannot build this; see Runo Research below for the actual supported handoff mechanism |
| 21 | Runo call recordings (fetch) | D | See #10 — no documented endpoint returns a Runo-recorded call's URL | Cannot promise |
| 22 | Runo disposition mapping | A | `connectorDispositionMappings` table + logic in `call-webhook.service.ts` | none |
| 23 | WhatsApp inbound | A | `whatsapp-webhook.service.ts`, real, tested | none |
| 24 | WhatsApp outbound | A | `whatsapp-meta-cloud.ts::sendMessage` — genuine Graph API POST in live mode, fixture mode otherwise | none |
| 25 | WhatsApp phone-number identity | B | Single `phoneNumberId` per connector row (see #4) — real per-message `phone_number_id` from Meta's webhook payload is not used to distinguish endpoints since only one exists | Needs the multi-endpoint model |
| 26 | WhatsApp status | A | `messages.deliveryStatus` (queued/sent/delivered/read/failed), updated from status webhooks | none |
| 27 | WhatsApp media | C | Schema doesn't preclude it but not specifically audited this pass — not a focus of this implementation round | Out of scope this round |
| 28 | WhatsApp Business app coexistence | D | Not built. Confirmed live against current Meta docs: this is a real, documented, but non-trivial feature (`smb_message_echoes`, `smb_app_state_sync`, Embedded Signup with a Solution Partner/Tech Provider account, WhatsApp Business app v2.24.17+) | See WhatsApp Research below |
| 29 | WhatsApp app-sent-message echoes | D | Would require Coexistence (#28) first | Deferred with #28 |
| 30 | WhatsApp history import | D | Real Meta feature, but only available in a 24-hour window during Embedded Signup onboarding, once — a live-account operational decision, not something to build generically | Deferred with #28 |
| 31 | Conversation | A | `conversations` table + full service, real | none |
| 32 | Conversation Event | B | `channel` enum includes CALL/SMS/EMAIL/INTERNAL but **no code path ever creates a CALL-channel conversation** — calls live only in the separate `calls` table, never joined into the Conversation/Message model | This is the core "unified timeline" gap — see Data Model Delta |
| 33 | Conversation Summary | D | Not built (no `ConversationSummary`-shaped table or service) | Deferred this round — see §50 |
| 34 | Patient Timeline | A | Pre-existing, verified, calls DO write a `timelineEvents` row (title + type only, no rich detail) | Timeline event exists but is a thin pointer, not the full interaction |
| 35 | Follow-ups | C | `tasks` table supports CALLBACK type; no dedicated "Follow-ups" tab/view | See #38 |
| 36 | Telecaller workspace | **D** | `my-work/page.tsx` has exactly 5 generic tabs (My Work/Today/Overdue/Upcoming/Completed) — no New Leads, no Follow-ups, no Missed Calls, no source filter anywhere in `listTasks`/`getTaskCounts` | Real, scoped gap — see Implementation below |
| 37 | Source-wise lead queue | D | No source filter on My Work/Tasks | See #36 |
| 38 | Missed-call queue | D | No queue exists; `calls.status = missed` rows are inert | See #36 |
| 39 | Appointments | A | Pre-existing, verified (state machine enforced this session) | none |
| 40 | No-shows | A | Pre-existing | none |
| 41 | Treatments | A | Pre-existing, verified (state machine already correct) | none |
| 42 | Revenue | A | Pre-existing | none |
| 43 | Campaign attribution | A | Pre-existing | none |
| 44 | Tasks | A | Pre-existing | none |
| 45 | My Work | B | See #36 | none beyond #36 |
| 46 | Patient 360 | B | Custom-field values now display (this session, earlier); calls/conversations do not appear anywhere on the page | See Implementation below |
| 47 | Inbox | B | Real for WhatsApp; "Call" appears only as an inert filter option (see #6 in the code-audit result) since no call ever becomes a conversation | none beyond #32 |

## Runo research (live, current — docs.runo.in OpenAPI v1.9.0, fetched this session)

**APIs**: `https://api.runo.in/v1`, `Auth-Key` header auth. Four real tag groups: Users, Call Logs, CRM,
Customers, plus a separate AI Call Analysis group.
- `GET /call/logs` — **past dates only** ("Only allows the past dates"), max 100/page. Fields (from the
  actual response schema): `callId`, `callerId`, `calledBy` (agent **name**, not an ID or phone), `name`/
  `customerId`/`phoneNumber` (customer), `startTime` (epoch), `duration` (seconds), `type` (enum
  incoming/outgoing/missed), `status` (free-text disposition, nullable — literally documented as
  "Disposition selected by the caller"), `tag` (personal/unanswered, nullable), `createdAt`. **No recording
  URL field anywhere in this schema. No business-number/endpoint field** — Runo's own call log does not
  tell you which hospital SIM/number was used.
- `POST /crm/interaction`, `POST /crm/allocation` — push a lead INTO Runo, assigned to a telecaller by
  phone number. This is the real mechanism for "get a lead in front of a telecaller" — not implemented in
  PulseOS today (see #16 above).
- `GET /crm/whatsapp` — Runo's own WhatsApp feature is **outbound template-message broadcast only**
  (fields: `message`, `label` (template name), `status`), not a general conversation API. Confirms the
  master prompt's own instinct to use Meta's official Cloud API for WhatsApp, not Runo.
- `POST /call/analysis/initiate` / `GET /call/analysis/result/{id}` — real, documented AI call analysis.
  Requires **you to supply a signed recording URL** (e.g. pre-signed S3/GCS); Runo does not expose a way to
  fetch its own call recordings via this API for you to feed back in. Credits charged per minute. Status
  values: PAUSED/COMPLETED/FAILED/IN_PROGRESS/TRANSCRIBED/ANALYSING/NO_CONVERSATION. Result includes score,
  summary, sentiment split, compliance checks, keywords.
- **Webhooks**: configured entirely through Runo's own Admin UI ("Admin → Integrations → Webhooks →
  Pre-Call Event"), not documented anywhere in the published OpenAPI spec. The exact payload shape used by
  PulseOS's existing `runo.ts` adapter is therefore an **unverified assumption**, not confirmed against a
  real Runo account.
- **Click-to-call**: confirmed absent. No call-initiation/dial endpoint exists in the documented API at
  all. The only supported "handoff" mechanism is `POST /crm/interaction`/`/crm/allocation` (puts the lead
  in the telecaller's Runo app queue) — the telecaller must manually tap to call inside their own Runo
  mobile app. This directly answers §04/§32: **there is no way to build a "Call with Runo" button that
  actually dials** with the currently-documented public API. The honest supported flow is "assign this
  lead to this telecaller in Runo" (a queue action), not "initiate this call."

## WhatsApp research (live, current — Meta for Developers, fetched this session)

- **Coexistence**: real, documented feature. Messages sent from the WhatsApp Business mobile app fire an
  `smb_message_echoes` webhook (full payload: sender, recipient, message content, timestamp); Cloud
  API-sent messages appear automatically in the mobile app (no action needed). Requires: WhatsApp Business
  app v2.24.17+, a Solution Partner or Tech Provider account, Embedded Signup flow, skip phone-number
  re-registration since the number is already live.
- **History import**: real, but narrow — only during the 24-hour window right after Embedded Signup
  completes, once per onboarding cycle, up to 180 days back, delivered via chunked `history` webhooks
  (0-1/1-90/90-180 day phases with a `chunk_order` field), explicit business consent required (declining
  returns error 2593109), group chats excluded, media beyond 14 days loses asset IDs.
- **Contact sync**: real, via `smb_app_state_sync` webhook (`add`/`remove` actions), requested through the
  SMB App Data API.
- **Multiple phone numbers**: confirmed real — one WABA can hold many `phone_number_id`s (one per hospital
  line), each with its own independent messaging limit/quality rating. **Critical constraint**: only ONE
  webhook URL per WABA — PulseOS's single webhook receiver must inspect each incoming payload's
  `phone_number_id` (inside Meta's `metadata` object) to resolve which hospital number was actually used,
  rather than assuming one number per connector as today's schema does.
- **Limitations for this pilot**: Coexistence and history import both require an actual Meta
  Solution-Partner-grade account and a live WABA — cannot be built/tested against fixtures alone, and is
  correctly out of reach without real Meta credentials. Multi-number support is buildable now at the data
  model level (the constraint is architectural, not credential-gated) even without live Coexistence.

## Data model delta (proposed, not yet implemented — see final audit for what actually got built)

1. **`communicationEndpoints`** table: `id, tenantId, branchId?, type (PHONE|WHATSAPP), provider, connectorId, publicNumber, providerPhoneNumberId, displayLabel, active`. One WhatsApp connector can now own N endpoint rows (N `phone_number_id`s); the webhook handler resolves the endpoint from the payload's `metadata.phone_number_id` instead of assuming a single number.
2. Relax `connectors`'s `(tenantId, provider)` uniqueness — or keep the connector 1-per-provider (holding shared account-level credentials) and let `communicationEndpoints` be the N-per-connector layer. The latter matches WhatsApp's real WABA→many-phone_number_ids structure better and avoids re-plumbing secret storage per number.
3. Give `calls` a `read path`: an `/calls` (or `/patients/:id/calls`) API route + `api.calls()` client method — currently completely absent.

## What this pass will actually implement (scoped realistically — see final audit for outcome)

Given the size of the full omnichannel vision above, this implementation pass targets the **highest-value,
best-evidenced, most tractable** gap rather than attempting the entire matrix at once: making the already-
real `calls` data readable (Patient 360 display + a real API route), matching the exact pattern that
already worked this session for specialty custom-field values (data existed, was written correctly, had
zero display surface). Multi-endpoint modeling, Coexistence, transcription/AI-summary wiring, and the
telecaller-workspace tab restructure are real, well-scoped next-phase items — documented here with enough
detail to pick up directly, not attempted this pass given they each individually approach the size of
everything already done this session combined.
