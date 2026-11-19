# WhatsNexus inbound forwarding reliability

## Release decision

The P0 acknowledgment gap was reproduced in source and the companion implementation has been changed. Production rollout is **BLOCKED** pending signed Meta and PulseOS staging acceptance, production schema confirmation, and approval of outbox payload retention. This task leaves tenant messaging pause and resume for the separate milestone.

## Source verification

| Stage | Finding |
| --- | --- |
| Signature | **VERIFIED.** Express captures the raw bytes for the Meta route. The original middleware could bypass signature verification in its default mode. Inbound message POSTs now require valid raw-body HMAC before the controller runs, even when the legacy signature mode is off. Other webhook event types keep their existing mode. |
| Batch routing | **FIXED.** The controller handles one event at a time. The route now splits batches containing inbound messages even when legacy batching is off. It preserves envelope and matching contact data. It processes valid siblings and reports a non-2xx result if a required item fails. Oversized inbound batches are rejected explicitly. Status-only behavior keeps its existing feature switch. |
| Tenant resolution | **VERIFIED.** The handler resolves the active or verified account by phone-number ID. It checks the WABA ID when configured and checks the URL tenant when supplied. The original Meta WAMID remains the dedupe and forwarding identity. |
| Local persistence | **FIXED.** The dedupe marker previously committed before the contact, live chat and inbox message. It could turn an incomplete delivery into a duplicate success. The marker, contact and chat writes, inbox message and required forwarding intent now commit in one MySQL transaction. Stable duplicates acknowledge only when the matching tenant and line already have a user message. An orphan historical marker returns a failure for review. |
| Pairing and forwarding | **FIXED.** Previously, a synchronous PulseOS request preceded all local writes. A non-2xx threw, and the outer catch replied 200. An enabled binding now creates a durable intent first. The worker loads fresh tenant credentials, verifies phone ownership and the stored destination fingerprint, and signs the existing body and timestamp contract per attempt. |
| Automation and acknowledgment | **PARTIALLY VERIFIED.** Only the request that committed a new local message enters inbox notifications, lead handling, handoff and the existing AI path. The retry worker does not execute those paths. The handler sends a non-2xx for a pre-ack inbound exception. A crash after commit can still skip post-commit automation. |
| Delivery statuses | **VERIFIED in source.** The existing status callback outbox remains dispatch-bound. It continues using its own ingress, worker, replay and billing correlation. |

Forwarding is optional when the integration feature is off or the tenant integration is disabled or absent. With the feature and tenant integration enabled, a usable paired hospital UUID, matching HTTPS callback path, current API key record and callback secret are required for new inbound acceptance. An incomplete enabled pairing yields a pre-ack failure. Staging must inventory older configurations, alternate domains, gateway paths, webhook secrets and WABA/account mapping before switching binaries. The configured Meta app secrets remain an installation-level trust set. The WABA and phone checks do not establish which configured secret signed an event, so isolated-app deployments must verify that their gateway and secret policy enforce their intended trust boundary.

## Outbox and recovery

| State | Behavior |
| --- | --- |
| Pending | Created with the inbox row, scoped to tenant, phone-number ID and original WAMID. The worker picks up committed, due rows even when the first process stopped before delivery. |
| Sending | Conditional atomic claim increments the attempt count and assigns a bounded lease token. Only the current lease can complete the row. Expired leases are recovered and classified as unknown outcome. |
| Retry | 503, 408, 429, other 5xx and ambiguous transport errors use bounded exponential backoff with jitter. The worker reuses the original body and WAMID, with a fresh HMAC timestamp. A timeout does not establish whether PulseOS committed the event. |
| Sent | A 2xx acknowledgment records the verified callback response time and clears the copied payload. A response from a receiver with its inbox capability disabled can be a transport acknowledgment without inbox application. Verify receiver capabilities in staging. |
| Dead | Revoked or changed binding, rejected destination, non-retryable HTTP response or exhausted retries. Stores a safe reason code. The original inbox record remains. Dead and pending payloads require an approved retention and disposal schedule before production. |
| Controlled replay | Existing management authorization permits read access to platform and super administrators, while only a super administrator can explicitly retry a selected dead-letter ID. Requires the same tenant, retained payload and matching current binding. Saves replay count, last actor and time. Reuses the same WAMID. |

The worker reads current credentials before sending. A revocation can race an already-admitted HTTP request. Keep old credentials invalid at PulseOS and verify rotations and in-flight outcomes in staging. Flipping the feature off stops new forwarding and pauses the inbound worker while preserving existing intents.

## Runbook

1. Use `GET /api/management/integrations/pulseos/:tenantId/inbound-forwards` to inspect status and reason counts, oldest pending timestamp, last successful timestamp and a bounded dead-letter list. These are tenant-scoped and omit patient text, phone numbers and credentials.
2. For `PULSEOS_UNAVAILABLE` or `HTTP_TRANSIENT`, confirm hospital lifecycle state, receiver capability and gateway availability. Restore normal service before manually retrying exhausted rows. Treat `OUTCOME_UNKNOWN` as possibly accepted, and reconcile by original WAMID through approved tenant tooling before replaying.
3. For `BINDING_INACTIVE` and `DESTINATION_REJECTED`, verify the existing hospital/phone pairing and signing settings. A changed destination is ineligible for replay from the old binding. Avoid repointing events to another hospital.
4. When authorized, retry a specific dead-letter via `POST /api/management/integrations/pulseos/:tenantId/inbound-forwards/:id/retry` with `{"approved":true}`. Check the resulting state and reconcile at PulseOS. Use approved tenant support tooling for any evidence that contains patient data.
5. An old acknowledgment with no outbox row cannot establish loss or acceptance. Reconcile only when the original WAMID, tenant/line ownership and original message evidence are available. Avoid bulk historical forwarding. Old dedupe markers without matching inbox rows require an operator review.
6. Approve a retention window and access controls for unresolved copied payloads, and establish backlog and age alerts. Successful payloads are cleared automatically. The new migration leaves unresolved rows and their payloads intact for controlled recovery.

## Cutover and rollback

- **BLOCKED pending staging.** Apply the additive `20261118_create_pulseos_inbound_outbox.js` migration before switching webhook workers. Verify InnoDB for all transactional intake tables, including message, dedupe, contact, live chat, sequence and outbox tables.
- **BLOCKED pending staging.** Verify real Meta app HMACs and phone/WABA ownership per configured route, including multi-item deliveries. Check strict inbound signature enforcement against every gateway path. Verify real PulseOS signed callbacks, 503 while suspended, restart recovery, duplicate retry and pairing revocation.
- **BLOCKED pending staging.** Drain prior webhook servers using synchronous forwarding. Switch the API and worker together, or hold workers off until all new webhook servers can commit outbox rows. Track already acknowledged historical deliveries separately. Existing status callbacks and machine paths require their usual routing and independent worker continuity.
- **VERIFIED design.** Roll back by preserving the additive table and all pending rows. Fence legacy synchronous inbound traffic before switching to an older binary or isolate the old route. Preserve the new worker or restart it after a compatible roll-forward. Reconcile in-flight sends by WAMID. Do not drop the outbox, regenerate event IDs or rerun the original inbound automation.

## Files changed

Sequelize SQL statement logging is disabled because statement text can contain patient message bodies and credential data. The changed webhook path omits AI reply previews and forwarding errors use fixed reason codes. Existing historical logs remain subject to the deployment retention review.

The implementation is in the sibling `Whatsnexus/invictus-chatbot` repository.

| Area | Files |
| --- | --- |
| Migration and state machine | `migrations/20261118_create_pulseos_inbound_outbox.js`, `src/models/IntegrationModel/pulseos.inbound.js`, `src/models/IntegrationModel/pulseos.inbound.store.js` |
| Integration and operations | `src/app.js`, `src/database/index.js`, `src/models/IntegrationModel/pulseos.service.js`, `pulseos.hook.js`, `pulseos.management.routes.js` |
| Meta admission | `src/middlewares/metaWebhook.js`, `src/models/AuthWhatsapp/AuthWhatsapp.routes.js`, `AuthWhatsapp.controller.js`, `AuthWhatsapp.service.js` |
| Local transaction services | `src/models/ContactsModel/contacts.service.js`, `src/models/LiveChatModel/livechat.service.js`, `src/models/Messages/messages.service.js` |
| Tests | `tests/pulseos.inbound.test.js`, `tests/metaWebhook.test.js`, `tests/pulseos.webhook.mysql.test.js`, `tests/regression.mysql.test.js` |

## Actual verification

- **VERIFIED.** JavaScript syntax checks and Git whitespace checks passed.
- **VERIFIED.** 244 fixture and unit tests passed across nine Jest suites. Coverage included signature and batch rules, retry worker classification, pairing, callback signing, dispatch, billing access and appointment logic.
- **VERIFIED.** 60 tests passed across three suites on disposable MySQL 8.0.42. The signed Express route exercised wrong signature and tenant rejection, SQL outbox failure rollback, worker-off acceptance, duplicate local delivery, concurrent claims, expired lease recovery, cross-tenant replay rejection and successful mocked forwarding. Existing flows covered status receipts, manual sends, inbox persistence, appointment follow-ups, wallet/ledger and machine dispatch.
- **PARTIALLY VERIFIED.** The worker cannot invoke AI or inbound business logic, and duplicate delivery returns before those calls. Redis/BullMQ campaign execution and end-to-end AI reply generation were outside the available fixtures.
- **BLOCKED.** The HTTP provider responses were mocked. No production migrations, live provider calls or deployment were made. Stage externally signed mixed batches, timeout after real receiver commit, 503 then restore, revocation mid-flight and gateway/campaign continuity before rollout.
