# WhatsNexus tenant messaging control

**PARTIALLY VERIFIED. Production rollout is blocked.** The implementation is in the sibling Whatsnexus/invictus-chatbot repository. PulseOS source was outside this milestone.

## Send inventory

| Origin | Entrypoint, tenant and scheduling | Meta submission and handling |
| --- | --- | --- |
| Campaign | Campaign service, dispatch worker, recipient worker and cron recovery. Campaign and recipient records use the worker tenant. | Shared template helper. Dispatch and enqueue check eligibility, recipient jobs carry generation, and final admission checks it. Existing Redis locks and billing allocations remain in use. Validate generation-specific job cleanup and crash/retry accounting before rollout. |
| Scheduled and follow-up | scheduledMessageCron selects due rows and uses the row tenant. | Shared template helper with schedule row identity. Paused rows remain pending. Appointment reminders recheck the appointment and suppress reminders due before resume. Unknown outcomes are recorded as failures for reconciliation. |
| Appointment | appointment.service direct notifications, scheduled reminders and interactive controller replies. | Shared template and dedicated appointment payload/interactive helpers all use the transport gate. Dedicated appointment calls still need end-to-end stale-work and billing tests. |
| AI and handoff | AuthWhatsapp inbound handler, deferred AI callback and handoff recovery. | Text, template, location and interactive helpers use the gate. Main AI callback carries the captured generation. Verify queued AI and independent handoff behavior after a pause/resume cycle. |
| Manual | Authenticated Messages routes use the session tenant and capture the generation before billing/media preparation. | Text, template and media helpers use final admission. Paused manual requests return 409. Media upload and status operations are separate from sending. |
| PulseOS | Authenticated machine messages, text and media routes use the paired machine tenant. | Template dispatch retains its external ID, existing lookup and unknown-outcome path. Text and media use authenticated request generation and final transport admission. |
| OTP | Tenant-specific OTP controller calls the shared template helper. | Final admission covers OTP sends. Verify paused response and attempt accounting in staging. |

Read receipts and typing indicators use the same Meta URL but are distinct transport operations. Inbound webhook handling, inbound forwarding, callbacks, dispatch lookup and reconciliation stay outside outbound admission.

## State and authorization

Migration 20261118_create_messaging_control.js adds messaging_control, messaging_commands and messaging_send_permits with existing-tenant ACTIVE backfill. A tenant row lock serializes commands, admission and permit settlement in that order. Provider HTTP executes outside the transaction with a 15-second Axios timeout. Pause advances generation, commits PAUSING and rejects further admissions. It settles to PAUSED when no sending permits remain. An accepted Meta request can still deliver. Scheduled, campaign and PulseOS template work carry stable references. Ambiguous stable work is quarantined and existing accepted references can return their WAMID without a second submission.

Management-only messaging-pause, messaging-resume, messaging-status and messaging-fence use the existing integration namespace. Writes additionally require an explicit server-side actor/tenant/action grant via PULSEOS_MESSAGING_CONTROL_GRANTS, a current paired hospital binding, a command UUID, expected provider state version, PulseOS lifecycle version and a bounded reason code. Fence requires explicit sender-fenced attestation and the specific permit. Status shows sanitized commands and permit counts. Provider verification time stays empty without independent evidence.

Crash recovery is operator-driven. A clock timeout alone cannot establish that a stopped or partitioned process is unable to submit. Verify the process is terminated or its Meta egress is blocked before fencing its permit. Keep the result unresolved for reconciliation. Never infer send failure from silence.

## Verification and open issues

- **VERIFIED on the initial test revision.** The disposable MySQL run reported 61 passes and one failure. The new control suite passed its two tests for draining a permit, stale generation/version, binding conflicts and ambiguous reference reuse. Existing dispatch and general regression suites passed. The webhook suite failed during WhatsApp account fixture creation on a reused database.
- **BLOCKED.** The final fresh-schema rerun was rejected by automatic approval review due to its usage limit. This also prevented applying a pending template-dispatch mapping for TENANT_MESSAGING_PAUSED to HTTP 409 and adding the crash-fencing test. The current template status map defaults unmapped codes to 500. Earlier JavaScript syntax checks passed.
- **PARTIALLY VERIFIED.** Generation coverage, ambiguous outcome handling and refund/hold settlement need full route-level tests per origin. The implementation does not establish safe idempotency for every direct manual or AI operation after an ambiguous timeout. Redis/BullMQ restart, fallback, signed callbacks and inbound during PAUSED, delayed/cancelled appointments, management authorization, and real provider traffic still need the requested checks.

## Changed files

- Migration and control: migrations/20261118_create_messaging_control.js, src/services/messagingControl.js, tests/messagingControl.mysql.test.js.
- Transport and inbound-triggered automation: src/models/AuthWhatsapp/AuthWhatsapp.service.js, AuthWhatsapp.controller.js, whatsappButtons.service.js, and src/models/AppointmentModel/whatsappAppointmentTemplates.service.js.
- Worker and scheduler: src/workers/campaignDispatchWorker.js, campaignSendWorker.js, dispatchCampaign.js, src/cron/scheduledMessageCron.js, and src/models/WhatsappCampaignModel/whatsappcampaign.service.js.
- Requests and machine dispatch: src/models/Messages/messages.routes.js and messages.controller.js, and src/models/IntegrationModel/pulseos.routes.js, pulseos.controller.js, pulseos.management.routes.js, pulseos.dispatch.service.js and pulseos.sendOutcome.js.

## Cutover and rollback

Apply the additive migration before starting the new send-capable binaries. Inventory and drain or fence every prior API, campaign worker, cron fallback and scheduler. Check gateway authentication, actor grants and exact hospital binding. Stage pause/resume for every origin with simulated crashes and real authorized provider callbacks. Reconcile in-flight permits and billing outcomes by original reference before any retry. Retain pause state, permits and command audit on rollback. Keep Meta egress fenced for older binaries until a compatible gate is back in service. No deployment, real tenant commands or live sends occurred.
