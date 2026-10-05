# Prototype Verification Log

Records the pass/fail result of every verification-only task in the plan (no code change, manual/E2E proof against the real running application).

## Task 12 — Human-takeover toggle (`is_ai_silenced`) end-to-end

**Method**: Real inbound WhatsApp webhook POSTs to `POST /api/whatsapp/webhook/TT001`, crafted to match Meta's payload shape, targeting the demo Contact (`CNT00002`, "Anita Verma", phone `9823456781`) via the mocked WhatsApp account's `phone_number_id` (`MOCK_PHONE_ID_TT001`). This exercises the real, unmodified `receiveMessage` handler in `AuthWhatsapp.controller.js` — not the Playground simulator, which is a separate sandboxed path.

**Pre-condition discovered**: the demo tenant's wallet balance was ₹0, which caused the billing-access gate to block AI processing *before* the `is_ai_silenced` check was ever reached — a different, unrelated gate. Funded the wallet to ₹500 (also added to the seed script) to isolate the gate under test.

| Step | Result |
|---|---|
| 1. `is_ai_silenced=false`, send inbound message | **PASS** — message stored (`messages` table), lead score updated, intent classification + knowledge search genuinely attempted (both failed only at the OpenAI call itself, due to the placeholder API key — expected/correct, not a false pass). No "AI is silenced" log line. |
| 2. `PATCH /whatsapp/contact/CNT00002/silence {is_ai_silenced:true}`, send inbound message | **PASS** — message still stored (a human must still see it), lead score still updated, but log shows exactly `[WEBHOOK] AI is silenced for specific contact: 919823456781` and **zero** AI/OpenAI/intent/knowledge calls were made — full skip confirmed. |
| 3. `PATCH .../silence {is_ai_silenced:false}`, send inbound message | **PASS** — AI processing resumed exactly as in step 1 (intent classification + knowledge search attempted again), no silence log line. |

**Verdict: PASS.** The existing `is_ai_silenced` mechanism (`ContactsTable.is_ai_silenced`, `AuthWhatsapp.controller.js:1082-1087`, `PATCH /whatsapp/contact/:contact_id/silence`) works correctly end-to-end against the real, unmodified production code path. No code change made in this task, per the plan.

## Task 13 — Scheduled follow-up mechanism (`ScheduledMessageTable` + cron)

**Method**: no manual/UI creation endpoint for a `send_type: "follow_up"` row exists (confirmed — the plan's assumed "existing reminder-creation flow" only covers `send_type: "appointment_reminder"`; the real `follow_up` creation site is `appointment.service.js:879-886`, reached only via completing an appointment with a follow-up date, which doesn't exist yet at this point in the build sequence). Created one `ScheduledMessages` row directly with the exact field shape that real code path uses (`tenant_id: TT001, contact_id: CNT00002, send_type: "follow_up", scheduled_at: 1 minute in the past`, a placeholder `template_id`), then waited for the real, unmodified cron (`runScheduledMessageCron`, scheduled `* * * * *` in `src/app.js:325-332`) to run on its own.

**Result: PASS.** Within one cron cycle (~60s), the row was picked up (`SELECT ... WHERE status='pending' AND scheduled_at <= now`), an attempt to process it was made, and it correctly failed with `Template not found: TEST-VERIFY-TEMPLATE` (expected — no real WhatsApp template exists for the demo tenant) with `status` updated to `failed` and the error logged. This proves pickup + send-attempt works exactly as designed. Test row deleted after verification.

## Task 14 — Lead status/stage field scope

**Finding**: `LeadsTable` (`src/database/tables/LeadsTable/index.js`) has two separate fields the plan's phrasing could refer to: `status` (`ENUM("active","archived","blocked")` — a record-lifecycle flag, not a CRM pipeline concept) and `lead_stage` (`ENUM("New","Contacted","Qualified","Negotiation","Lost","Won")` — the real pipeline/stage field). Confirmed via `grep` that `services/leadIntelligene/index.ts` has no dedicated update-stage function for either field (only a generic `bulkUpdateLeads(leadIds, updates)`), and `leadDetailsView.tsx:257-258` renders `lead_stage` as a static, non-interactive `<span>` badge (`{lead.lead_stage || 'New'}`) — no `onClick`, no dropdown, no edit control anywhere in either leads view.

**Verdict: NOT EDITABLE from the frontend.** Per the plan's explicit contingency for this exact outcome: no new stage-editing UI is added in the prototype track (that belongs to Part B Task M8-full / PipelineStageTable). The demo narrates stage progression via the Timeline view (Task 11) instead.

## Task 15 — Book a demo appointment through the existing booking system

**Method**: used the plan's explicit "OR" alternative — the confirmed-LIVE `POST /whatsapp/appointment` create endpoint (`appointment.routes.js:29`) — rather than driving the full conversational `Advanced_Appointment_Booking.service.js` state machine via Playground turn-by-turn (which would depend on OpenAI parsing at several steps, unreliable with the placeholder API key). Note for the record: `POST /whatsapp/appointment` calls `AppointmentService.createAppointmentService` (`appointment.service.js`), a separate direct/admin-booking code path from the conversational state machine the plan names in "Consumes" — both are real, live, production paths (manual staff booking vs. AI-driven WhatsApp booking); this task exercises the former.

**Blockers discovered and resolved along the way** (none required code changes, all real data/config the tenant genuinely lacked): (1) no Doctor existed for TT001 — created one (`DOC00001`, Dr Rajesh Kumar) via the real `POST /whatsapp/doctor` endpoint; (2) the doctor had no availability schedule — set one via `PUT /whatsapp/doctor/:id` (Mon-Fri 09:00-17:00, Sat 09:00-13:00); (3) only one bookable slot (`09:00 AM`) was actually materialized for the target date despite the full-day window — used it as-is rather than investigating slot-generation internals further (out of this task's scope).

**Result: PASS.** `POST /whatsapp/appointment` returned `201` with `appointment_id: AP001`, correctly auto-linked to `contact_id: CNT00002` **and** `lead_id: L043` (our demo Journey) purely from the contact_id — confirming the appointment↔journey correlation already works today. Verified in-browser: the appointment renders correctly in the Appointments "All Appointments" list (patient, doctor, date, time, status) and in `appointmentDrawer.tsx`'s detail view (all fields correct, including Token Number and Notes).
