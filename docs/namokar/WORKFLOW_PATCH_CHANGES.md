# Namokar V1/V2 workflow patch: what changed

Branch `claude/wonderful-carson-o7jbjk`, six commits on top of `f07addc` (28 files, +1,244 / −55). Local demo only; nothing deployed.
These commits are local: they are not pushed (see "Git" below).

## 1. Log Call can book the appointment in the same save

**API** ([call.service.ts](../../apps/api/src/domain/call/call.service.ts), [call.routes.ts](../../apps/api/src/domain/call/call.routes.ts), types in [packages/types](../../packages/types/src/index.ts))
- `POST /journeys/:id/calls` accepts an optional `appointment { scheduledAt, confirmed?, doctorId?, branchId?, reason? }`.
- One next action only: a callback **or** an appointment. Sending both is refused (400).
- One transaction: call, appointment and their timeline lines are saved together. If the booking is refused, neither is kept.
  - Refusals reuse the booking rules: `appointment_time_in_past`, `outside_clinic_hours` (422), `resource_unavailable` (409), `doctor_not_found` / `branch_not_found` (404).
- Doctor and branch default to the hospital's only one. If there is a choice and none is given: `doctor_required` / `branch_required`.
- `confirmed: true` confirms the visit after the transaction commits. The confirmation and the 1-hour reminder are then planned once. `confirmed: false` leaves it Booked and sends nothing.
- Booking from a call needs the `MANAGE_APPOINTMENTS` permission (403 otherwise).
- A booked visit satisfies an outcome that requires a follow-up, so no extra callback task is created.
- The same idempotency key returns the first call: no second call, visit or message set (tested with two simultaneous submits).
- The result now includes `appointmentId` and `appointmentStatus` (`scheduled` or `confirmed`).

**Web** ([LogCallSheet.tsx](../../apps/web/components/calls/LogCallSheet.tsx), [callForm.ts](../../apps/web/components/calls/callForm.ts))
- New **Next action** control: None / Callback / Book appointment.
- Book appointment reveals date and time, a doctor/branch picker only when there is more than one, the clinic-hours hint, and **Appointment confirmed with patient** (on by default).
- The save button reads "Save call", "Save call & book appointment" or "Save call & confirm appointment".
- Checked in the form before sending: missing date/time, closed day, outside hours, past time. An advisory warning appears if the doctor already has that slot.
- A failed save keeps everything typed and shows the error inline.
- After saving, journeys, leads, tasks, appointments, Front Desk and patients refresh with no page reload.
- An outcome that requires a follow-up pre-selects Callback and disables "None".

**Journey** ([NextActionCard.tsx](../../apps/web/components/followups/NextActionCard.tsx), [progressSteps.ts](../../apps/web/components/journey/progressSteps.ts))
- With no follow-up task but an upcoming visit, Next action reads "Patient visit · date/time" and the status, instead of "No follow-up scheduled".

## 2. CRM Fields: control over Add Lead

The field system already had placements, required, order, archive and conditional rules, and the server already filtered Add Lead by placement. What was added:
- A per-row **On Add Lead** switch in Settings → CRM Fields ([CrmFieldsSection.tsx](../../apps/web/components/settings/CrmFieldsSection.tsx)). It saves at once and Add Lead shows or hides the question on its next open. Hiding never deletes values.
- The list shows the full **Used in** list (no "+2") and a **Filterable** badge.
- The placement label "Follow-up outcome" is now "Call / follow-up".
- A new `TouchCheckbox` in [FormBits.tsx](../../apps/web/components/settings/FormBits.tsx): 44px tap target on a phone, compact on desktop. `CheckRow` uses it too.
- **Namokar V1 and V2 seeds** ([namokar.ts](../../apps/api/src/seed/demo/namokar.ts)): the ophthalmology template's clinical questions are no longer on Add Lead. They stay on the journey and patient record. A hospital can switch any of them back on.

Still not built: a separate placement for Call in Log Call (the existing "Call / follow-up" placement applies to the Log outcome sheet only), and call-specific custom field entry inside Log Call.

## 3. Clinic hours and the Doctor Planner

- **Settings → Clinic Hours** (new tab, [ClinicHoursSection.tsx](../../apps/web/components/settings/ClinicHoursSection.tsx), [clinicHoursForm.ts](../../apps/web/components/settings/clinicHoursForm.ts)): open/closed and times for each weekday. At least one day must be open. It uses the existing `PUT /clinic-hours` (admin only) and refreshes lookups, appointments, Front Desk and slot checks.
- **Doctor Planner** ([DoctorScheduleView.tsx](../../apps/web/components/appointments/DoctorScheduleView.tsx)): added **Choose date**, a "Clinic hours 09:00–16:00" / "Clinic closed this day" line from the tenant's own hours, and the service shown on each row. Previous/Next/Today already existed.
- New helper `clinicHoursOn(hours, date)` in [packages/ui](../../packages/ui/src/clinicHours.ts).
- One source of truth: booking, slot pre-check, the Log Call form and the planner all read the tenant's hours. No hours are hardcoded in the UI.

## 4. V1 / V2 isolation

Configuration is per hospital. Tested: changing V2's Saturday hours or an Add Lead placement does not change V1, and the reverse. Only an administrator may change hours.

## 5. Tests added or changed

| Area | Test |
|---|---|
| API | [call-appointment.integration.test.ts](../../apps/api/src/__tests__/call-appointment.integration.test.ts), 12 tests: callback task; booked vs confirmed; confirmation and 1-hour reminder planned once; no provider means blocked, never sent; timeline events; double submit; refused bookings keep nothing; callback+visit refused; permission; cross-tenant doctor; sole-doctor default |
| API | [tenant-config-propagation.integration.test.ts](../../apps/api/src/__tests__/tenant-config-propagation.integration.test.ts), 3 tests: hours reach lookups, slot-check and booking at once; per-hospital isolation; Add Lead placement on/off |
| Web unit | `callForm` (appointment cases), `clinicHoursForm`, `placementSummary`, and `clinicHoursOn` in ui |
| E2E | [namokar-workflow-closure.spec.ts](../../apps/web/e2e/namokar-workflow-closure.spec.ts): Add Lead switch on/off with V1 unaffected; one-save call + appointment through Journey, Front Desk and Planner; clinic-hours change reaching booking, Log Call and Planner. Cleans up after itself |
| E2E | [namokar-workflow-responsive.spec.ts](../../apps/web/e2e/namokar-workflow-responsive.spec.ts): 1440 / 768 / 390, no sideways scroll, phone tap targets |
| Updated | `calls-m4.spec.ts` follows the new Next action wording |

## 6. Verification

- Lint and typecheck: clean.
- API: 1,438 passed. Web unit: 268. UI unit: 142.
- Full Playwright run on the final code: **403 passed, 2 skipped, 0 failed**.
- An earlier full run found two problems caused by this patch (20px checkboxes failing the 44px phone target rule; a spec expecting the old "Callback needed" text). Both were fixed and the run was repeated.
- Demo data was reseeded afterwards: V1 has its fictional data, V2 has zero rows.

## 7. Git

- Six commits are local on `claude/wonderful-carson-o7jbjk` (`db2d4f8` … `0ff4e45`).
- **Not pushed.** GitHub has two newer commits from another session (`dfd7894`, `0402ba0`: shared UI styling and appearance controls). Merging them needs a fresh check before pushing; no force-push, never `main`.
- This file is also uncommitted.

---

# Update: convergence with the cloud UI, and workflow simplification

Branch `integration/pulseos-converged-v1-v2` = the local workflow commits above + cloud UI commits `dfd7894` (shared MetricStrip, no KPI notch) and `0402ba0` (Settings → Appearance, floating/content surfaces, exclusive top-bar menus), merged with one conflict (the Settings tab list: both **Clinic Hours** and **Appearance** are kept). Migrations 0039 (clinic hours) and 0040 (surface style) are sequential; all 41 apply from an empty database and two seeds give identical counts.

## Appointment day: three staff steps
- **Check in** now means arrived **and** waiting, in one server-side transaction (`PATCH /appointments/:id/action { action: "check_in", queue: true }`). The arrival time and the waiting start are the same instant; the timeline gets one line ("Patient checked in · Waiting · 10:32 am"). A repeat or simultaneous click changes nothing twice. If recording the timeline line fails, the visit stays untouched (tested with a failing trigger).
- **Send to doctor** → With doctor. **Consultation done** → Completed (backend enum values unchanged: `waiting`, `with_doctor`, `completed`).
- Planner/agenda rows show "Waiting · 8 min", derived from the recorded waiting start.
- The two-step API (`check_in` then `mark_waiting`) still works for integrations and for visits already checked in the old way.

## Log outcome (follow-up) books the visit in the same save
- Tick **Book the appointment now** on an outcome that allows visits; date, time and **confirmed with patient** appear inline (the same component as Log Call: `InlineAppointmentFields`).
- Same rules as Log Call: one transaction (refused booking keeps nothing), confirm after commit (confirmation + 1-hour reminder planned once), no extra follow-up task, doctor/branch default to the only one, `MANAGE_APPOINTMENTS` required.
- Not changed: **Add follow-up** schedules a *future* task; it has no outcome to book from, so the visit is booked at the moment the follow-up is *logged*.

## Lead creation
- The first timeline line is one "Lead created — <service>" event, now with "Source: Phone · Assigned to Shivani". No duplicate creation events.

## Settings navigation
- When tabs overflow, ‹ and › buttons appear on the side that has more (phone-sized targets), in addition to trackpad, touch, arrow keys, Home/End and active-tab-into-view. No page-level horizontal scroll.

## Add Lead fields
- Unchanged mechanics (placement-driven, per hospital). Acceptance covered end to end: a new custom field → "On Add Lead" on → appears in Add Lead at once → off → gone; stored values stay; V1 never sees V2's field.
- Note: Add Lead already has a built-in **Preferred language** question, so a custom field with that exact name would show twice.

## Test hygiene found on the way
- `attribution.service.test.ts` borrowed an arbitrary workspace and left a patient behind, which broke the clean-V2 checks once table order changed. It now removes its rows.

## Verification (final tree)
Lint and typecheck clean · Web 288 · UI 155 · API 1,457 (1 skipped) · Full Playwright 425 passed, 2 skipped, 0 failed · Fresh database: 41 migrations, seed ×2 identical.

---

# Update: Oct 5 demo-feedback audit

| Requirement | Before | Status | After |
|---|---|---|---|
| Configurable Add Lead (CRM fields, "On Add Lead", order, required, archive, V1/V2 isolation) | Built | **DONE** | Left unchanged, re-verified |
| Lead Sources (Google, Phone, Instagram, Referral, Walk-in…) | Settings → Lead Sources: add / edit / archive | **DONE** | Left unchanged |
| Add a **service** | Services could only be enabled / disabled / renamed | **MISSING** | `POST /specialties` + "Add service" form in Settings → Services |
| Patient type New / Existing, Namokar UID | Not present | **MISSING** | Ordinary CRM fields seeded for Namokar: **Patient type** (on Add Lead) and **Namokar UID** (shown only when Existing, never required). A New patient is never asked for a UID; none is invented |
| UID helps find the patient | Search was name/phone only | **PARTIAL** | Patient search also matches a hospital's filterable text identifier (e.g. UID); same hospital only; clinical-only fields never searchable. Phone still decides who the person is: a repeat enquiry is the same patient with a new journey |
| Address, PIN code, Area / Locality, Gender | Not present | **MISSING** | CRM fields on the journey and patient record, not on Add Lead and not required; the Super Admin switches "On Add Lead" / required |
| Age vs date of birth | Both exist; age is derived from DOB when known | **DONE** | Unchanged; reporting uses DOB first, then reported age |
| Funnel: remove "Contacted" | Performance funnel started Enquiry → **Contacted** → … | **WRONG** | Removed. Funnel is Enquiries → Appointment booked → Visit attended → Consultation completed → Procedure advised → Procedure scheduled → **Procedure done** |
| "Attended" vs a call being answered | "Attended" meant a visit, but read like a call | **WRONG** | Renamed "Visit attended" (the patient arrived). An answered call is never a funnel stage; a test proves a connected call alone is not a visit |
| Scheduled vs Done | "Procedure scheduled" counted scheduled **or done** | **WRONG** | Separate steps; Done = treatment completed only |
| Main Command Centre funnel and exports | "Contacted", "Attended", "Treatment advised/converted" | **WRONG** | Same clinic wording; Contacted hidden from the funnel; export stage labels follow |
| Source-wise and service-wise breakdown | Present | **DONE** | Gains a Done column; "Contacted" column removed |
| Area / Age group / Gender reporting | Not present | **MISSING** | "Who is enquiring" on Performance: age group (derived from DOB or reported age) plus every filterable choice field, and free text that repeats (an area). Unique identifiers (UID), clinical-only and unanswered fields never appear; nothing is shown when nothing is recorded |
| Lead creation visible in the journey | One "Lead created" line | **DONE** (improved last round) | Unchanged |
| Photo request on WhatsApp | No such action | **PARTIAL – deferred** | Added the follow-up type **Request photo on WhatsApp** (a task for the coordinator; not a sent message). Sending it through the provider needs a second approved message template and a template chooser; the WhatsApp provider is not connected in this pilot, so nothing is claimed as sent |
| Per-user **Interface size** and **Text size** | Not present | **MISSING** | **Display settings** in the profile menu for every role: Interface size (Compact / Comfortable / Large) and Text size (Small / Default / Large / Extra large), independent, with a live preview and Save / Cancel. Stored on the person (`users.interface_size`, `users.text_size`, migration 0041), carried in the session. Implemented with design tokens (`--spacing`, the type scale), never zoom or transform; Compact applies from 768px up so phones keep 44px targets; captions have a readable floor |
| Settings tab navigation when overflowing | Done last round | **DONE** | Verified |
| Roles | Super Admin: settings + reports; Front Desk: intake + appointments; Coordinator: follow-ups; Doctor: planner | **DONE** | No permission changed |

Verification: lint/typecheck clean · Web 288 · UI 155 · API 1,486 (1 skipped) · full Playwright 439 passed, 1 skipped, 0 failed.
