import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TZ = "Asia/Kolkata";
const run = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E M6 ${n} ${run}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

/** Calls the real API as the signed-in user (cookie session) and returns the parsed JSON. */
async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ api, method, path, body }) => {
      const res = await fetch(`${api}${path}`, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { api: API, method, path, body },
  );
}

async function createLead(page: Page, name: string): Promise<{ journeyId: string; patientId: string }> {
  const lookups = (await api<{ branches: { id: string }[] }>(page, "GET", "/lookups")).body;
  const res = await api<{ journeyId: string; patientId: string }>(page, "POST", "/leads", {
    name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0]!.id, journeyType: "Cataract", sourceKey: "google", customFieldValues: {},
  });
  return res.body;
}

/**
 * Books a visit via the API, soon enough to fall on the hospital's today. The server refuses a
 * doctor's already-taken minute (409), so try each doctor and later minutes until a slot is free.
 */
async function book(page: Page, lead: { journeyId: string; patientId: string }, minutesFromNow = 10): Promise<string> {
  const lookups = (await api<{ branches: { id: string }[]; doctors: { id: string; name: string }[] }>(page, "GET", "/lookups")).body;
  let last = 0;
  for (let step = 0; step < 30; step++) {
    for (const doctor of lookups.doctors) {
      const res = await api<{ id: string }>(page, "POST", "/appointments", {
        patientId: lead.patientId, journeyId: lead.journeyId, branchId: lookups.branches[0]!.id, doctorId: doctor.id,
        scheduledAt: new Date(Date.now() + (minutesFromNow + step) * 60_000).toISOString(), reason: "Consultation",
      });
      last = res.status;
      if (res.status === 201) return res.body.id;
      expect(res.status).toBe(409);
    }
  }
  throw new Error(`no free appointment slot found (last status ${last})`);
}

const dayInHospital = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });

/** Takes the appointment to With doctor through the API (the walk-through of those steps is FLOW A). */
async function toWithDoctor(page: Page, appointmentId: string) {
  for (const action of ["check_in", "mark_waiting", "send_to_doctor"]) expect((await api(page, "PATCH", `/appointments/${appointmentId}/action`, { action })).status).toBe(200);
}

test.describe("M6 — appointment lifecycle, completion, risk and surgery", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => purgePatients("E2E M6 "));

  test("FLOW A: Book from the Journey → Check in → Waiting → With doctor → Complete (no follow-up) → completed on Front Desk, Journey and Appointments", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "eyev1.coordinator@pulseos.local");
    const name = NAME("A");
    const lead = await createLead(page, name);
    await page.goto(`/journeys/${lead.journeyId}`);

    // Book from the Journey: patient and journey are pre-filled.
    await page.getByTestId("journey-book-appointment").click();
    const drawer = page.getByTestId("new-appointment-drawer");
    await drawer.locator("#appt-branch").selectOption({ index: 1 });
    await drawer.locator("#appt-doctor").selectOption({ index: 1 });
    const soon = new Date(Date.now() + 10 * 60_000);
    const hhmm = soon.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    await drawer.locator("#appt-time").fill(`${dayInHospital(0)}T${hhmm}`);
    await drawer.getByTestId("new-appointment-submit").click();
    await expect(drawer).not.toBeVisible();

    const ctx = page.getByTestId("appointment-context");
    await expect(ctx).toContainText("Booked");
    // One obvious next step at a time, in plain words.
    const primary = page.getByTestId("appointment-context-primary");
    await expect(primary).toHaveText("Check in");
    await primary.click(); // one click: arrived AND waiting
    await expect(ctx).toContainText("Waiting");
    await expect(primary).toHaveText("Send to doctor");
    await primary.click();
    await expect(ctx).toContainText("With doctor");
    await expect(primary).toHaveText("Consultation done");

    // The completion step: "What happens next?", nothing chosen yet, so nothing can be saved by accident.
    await primary.click();
    const sheet = page.getByTestId("complete-consultation");
    await expect(sheet).toContainText("What happens next?");
    await expect(sheet.getByTestId("complete-consultation-save")).toBeDisabled();
    await sheet.getByTestId("complete-next-none").check();
    await sheet.getByTestId("complete-consultation-save").dblclick(); // a double tap completes once
    await expect(sheet).not.toBeVisible();
    await expect(ctx).toContainText("Consultation completed");
    await expect(page.getByText(/Consultation completed · \d/).first()).toBeVisible();
    expect(sql(`SELECT count(*) FROM timeline_events WHERE journey_id = '${lead.journeyId}' AND event_type = 'appointment_completed'`)).toBe("1");
    expect(sql(`SELECT status FROM appointments WHERE journey_id = '${lead.journeyId}'`)).toBe("completed");
    expect(sql(`SELECT count(*) FROM tasks WHERE journey_id = '${lead.journeyId}'`)).toBe("0");

    // The same appointment, the same state, everywhere.
    await page.goto(`/front-desk?q=${encodeURIComponent(name)}`);
    await expect(page.getByTestId("front-desk-today").getByTestId(/appointment-row-/)).toContainText("Completed");
    await page.goto(`/appointments?q=${encodeURIComponent(name)}`);
    await expect(page.locator('[data-testid^="appointment-row-"]').filter({ hasText: name })).toContainText("Completed");
    expect(errors).toEqual([]);
  });

  test("FLOW B: Complete → Create follow-up (Appointment Follow-up, tomorrow) → Journey Next Action → My Work", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("B");
    const lead = await createLead(page, name);
    const appt = await book(page, lead);
    await toWithDoctor(page, appt);
    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-primary").click();
    const sheet = page.getByTestId("complete-consultation");
    await sheet.getByTestId("complete-next-follow_up").check();
    await expect(sheet.getByTestId("complete-followup-fields")).toBeVisible();
    await expect(sheet.getByTestId("complete-followup-type")).toHaveValue(/.+/); // pre-set to Appointment Follow-up
    await expect(sheet.getByTestId("complete-followup-type").locator("option:checked")).toHaveText("Appointment Follow-up");
    await sheet.getByTestId("complete-followup-date").fill(dayInHospital(1));
    await sheet.getByTestId("complete-followup-time").fill("11:00");
    await sheet.getByTestId("complete-followup-note").fill("Review in a day");
    // A refusal leaves the visit With doctor and keeps what was typed.
    await sheet.getByTestId("complete-followup-date").fill(dayInHospital(-2));
    await sheet.getByTestId("complete-consultation-save").click();
    await expect(sheet.getByTestId("complete-consultation-error")).toContainText("future");
    expect(sql(`SELECT status FROM appointments WHERE journey_id = '${lead.journeyId}'`)).toBe("with_doctor");
    await sheet.getByTestId("complete-followup-date").fill(dayInHospital(1));
    await sheet.getByTestId("complete-consultation-save").click();
    await expect(sheet).not.toBeVisible();

    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Follow-up");
    await expect(page.getByTestId("next-action-due")).toContainText("11:00");
    await expect(page.getByText("Follow-up scheduled · Appointment Follow-up")).toBeVisible();
    expect(sql(`SELECT count(*) FROM tasks WHERE journey_id = '${lead.journeyId}'`)).toBe("1");
    await page.goto("/my-work?tab=upcoming");
    await expect(page.locator('[data-testid^="task-row-"]').filter({ hasText: name })).toContainText("Appointment Follow-up");
  });

  test("FLOW C: Complete → Schedule surgery → Journey, Treatments (table, pipeline, calendar) and Patient 360 show the same record; it persists", async ({ page }) => {
    await login(page, "eyev1.coordinator@pulseos.local");
    const name = NAME("C");
    const lead = await createLead(page, name);
    const appt = await book(page, lead);
    await toWithDoctor(page, appt);
    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-primary").click();
    const sheet = page.getByTestId("complete-consultation");
    await sheet.getByTestId("complete-next-surgery").check();
    // Procedures come from the hospital's own catalogue, narrowed to this journey's service.
    const procedures = sheet.getByTestId("complete-surgery-procedure");
    await expect(procedures.locator("option")).toContainText(["Choose a procedure…", "Cataract Surgery"]);
    await expect(procedures.locator("option")).toHaveCount(2);
    await procedures.selectOption({ label: "Cataract Surgery" });
    const day = dayInHospital(12);
    await sheet.getByTestId("complete-surgery-date").fill(day);
    await sheet.getByTestId("complete-surgery-time").fill("09:30");
    await sheet.getByTestId("complete-surgery-doctor").selectOption({ label: "Dr Anand Kulkarni (Visiting Surgeon)" }); // a doctor with no login
    await sheet.getByTestId("complete-surgery-note").fill("Right eye");
    await expect(sheet).not.toContainText(/diagnosis|prescription|consent/i); // scheduling only
    await sheet.getByTestId("complete-consultation-save").click();
    await expect(sheet).not.toBeVisible();

    const card = page.getByTestId("surgery-card");
    await expect(card).toContainText("Surgery scheduled");
    await expect(card.getByTestId("surgery-label")).toHaveText("Cataract Surgery");
    await expect(card.getByTestId("surgery-when")).toContainText("9:30");
    await expect(card.getByTestId("surgery-where")).toContainText("Dr Anand Kulkarni (Visiting Surgeon)");
    expect(sql(`SELECT to_char(planned_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' ' || status FROM treatment_opportunities WHERE journey_id = '${lead.journeyId}'`)).toBe(`${day} 09:30 SCHEDULED`);
    expect(sql(`SELECT count(*) FROM treatment_opportunities WHERE journey_id = '${lead.journeyId}'`)).toBe("1");

    // The same record in the Treatments page, in all three views.
    await page.goto("/treatments?status=SCHEDULED");
    await expect(page.locator("tbody tr").filter({ hasText: name })).toContainText("Cataract Surgery");
    await page.goto("/treatments?view=pipeline");
    await expect(page.getByText(name).first()).toBeVisible();
    await page.goto(`/treatments?view=calendar&cal=agenda&date=${day}`);
    await expect(page.getByText(name).first()).toBeVisible();

    // Patient 360 → Upcoming.
    await page.goto(`/patients/${lead.patientId}?view=upcoming`);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByText("Cataract Surgery").first()).toBeVisible();

    // Refresh persists.
    await page.goto(`/journeys/${lead.journeyId}`);
    await expect(page.getByTestId("surgery-card")).toContainText("Cataract Surgery");

    // Reschedule moves it (and nothing is duplicated); Cancel removes it from the schedule.
    await page.locator('[data-testid^="surgery-reschedule-"]').click();
    const re = page.getByTestId("reschedule-surgery");
    await re.getByTestId("reschedule-surgery-date").fill(dayInHospital(14));
    await re.getByTestId("reschedule-surgery-time").fill("10:00");
    await re.getByTestId("reschedule-surgery-save").click();
    await expect(re).not.toBeVisible();
    await expect(page.getByTestId("surgery-when")).toContainText("10:00");
    expect(sql(`SELECT count(*) FROM treatment_opportunities WHERE journey_id = '${lead.journeyId}'`)).toBe("1");
    await page.locator('[data-testid^="surgery-cancel-"]').click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByTestId("surgery-card")).toHaveCount(0);
    expect(sql(`SELECT status FROM treatment_opportunities WHERE journey_id = '${lead.journeyId}'`)).toBe("CANCELLED");
  });

  test("Front Desk cannot schedule a surgery: the option is not offered (Admin and Coordinator manage treatments)", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const lead = await createLead(page, NAME("FD"));
    await toWithDoctor(page, await book(page, lead));
    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-primary").click();
    await expect(page.getByTestId("complete-next-none")).toBeVisible();
    await expect(page.getByTestId("complete-next-follow_up")).toBeVisible();
    await expect(page.getByTestId("complete-next-surgery")).toHaveCount(0);
  });

  test("FLOW D: No-show with a reason → exactly one Appointment Risk task → in My Work's Appointment Risk bucket; Front Desk flags it", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("D");
    const lead = await createLead(page, name);
    const appt = await book(page, lead, 3);
    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-open").click();
    const drawer = page.getByTestId("appointment-drawer");
    await drawer.getByTestId("drawer-action-no-show").click();
    await expect(drawer.getByTestId("drawer-reason-reason")).toHaveValue("patient_no_show");
    await drawer.getByTestId("drawer-reason-note").fill("Phone off");
    await drawer.getByTestId("drawer-reason-confirm").dblclick(); // a double click raises one task
    await expect(drawer).not.toBeVisible();

    expect(sql(`SELECT count(*) FROM tasks WHERE appointment_id = '${appt}' AND risk_reason = 'no_show' AND status = 'pending'`)).toBe("1");
    expect(sql(`SELECT count(*) FROM timeline_events WHERE journey_id = '${lead.journeyId}' AND event_type = 'appointment_no_show'`)).toBe("1");
    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Risk");

    await page.goto("/my-work?tab=appointment_risk");
    await expect(page.locator('[data-testid^="task-row-"]').filter({ hasText: name })).toBeVisible();
    await page.goto(`/front-desk?q=${encodeURIComponent(name)}`);
    await expect(page.getByTestId("front-desk-at-risk")).toContainText(name);
  });

  test("FLOW E: A hospital reschedule (doctor unavailable) → new time in the hospital's clock → Appointment Risk → every view updates", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("E");
    const lead = await createLead(page, name);
    const appt = await book(page, lead, 24 * 60);
    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-open").click();
    const drawer = page.getByTestId("appointment-drawer");
    await drawer.getByTestId("drawer-action-reschedule").click();
    // The reason is required; so is the time.
    await drawer.getByTestId("drawer-reason-confirm").click();
    await expect(drawer.getByTestId("drawer-reason-error")).toContainText("new date and time");
    const day = dayInHospital(3);
    await drawer.getByTestId("drawer-reschedule-date").fill(day);
    await drawer.getByTestId("drawer-reschedule-time").fill("15:30");
    await drawer.getByTestId("drawer-reason-confirm").click();
    await expect(drawer.getByTestId("drawer-reason-error")).toContainText("why it is being rescheduled");
    await drawer.getByTestId("drawer-reason-reason").selectOption({ label: "Doctor unavailable" });
    await drawer.getByTestId("drawer-reason-note").fill("Doctor at a conference");
    await drawer.getByTestId("drawer-reason-confirm").click();
    await expect(drawer).not.toBeVisible();

    expect(sql(`SELECT to_char(scheduled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' ' || status_reason_code FROM appointments WHERE id = '${appt}'`)).toBe(`${day} 15:30 doctor_unavailable`);
    expect(sql(`SELECT count(*) FROM tasks WHERE appointment_id = '${appt}' AND risk_reason = 'hospital_reschedule' AND status = 'pending'`)).toBe("1");
    await expect(page.getByTestId("appointment-context")).toContainText("3:30");
    await expect(page.getByText(/Appointment rescheduled · .*3:30 pm/)).toBeVisible();
    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Risk");

    await page.goto(`/appointments?view=day&date=${day}&q=${encodeURIComponent(name)}`);
    await expect(page.getByText(name).first()).toBeVisible();
    await page.goto("/my-work?tab=appointment_risk");
    await expect(page.locator('[data-testid^="task-row-"]').filter({ hasText: name })).toBeVisible();
  });

  test("Cancel needs a reason; a patient-requested cancellation raises no risk; the Journey stays open", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const lead = await createLead(page, NAME("X"));
    const appt = await book(page, lead, 24 * 60);
    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-open").click();
    const drawer = page.getByTestId("appointment-drawer");
    await drawer.getByTestId("drawer-action-cancel").click();
    await drawer.getByTestId("drawer-reason-confirm").click();
    await expect(drawer.getByTestId("drawer-reason-error")).toContainText("why it is being cancelled");
    await drawer.getByTestId("drawer-reason-reason").selectOption({ label: "Patient requested" });
    await drawer.getByTestId("drawer-reason-confirm").click();
    await expect(drawer).not.toBeVisible();
    expect(sql(`SELECT status || ' ' || status_reason_code FROM appointments WHERE id = '${appt}'`)).toBe("cancelled patient_requested");
    expect(sql(`SELECT count(*) FROM tasks WHERE appointment_id = '${appt}'`)).toBe("0");
    expect(sql(`SELECT stage FROM journeys WHERE id = '${lead.journeyId}'`)).not.toBe("lost");
    await expect(page.getByTestId("appointment-context-empty")).toBeVisible();
  });

  test("Settings → Doctors: an Admin adds a doctor with no login, who can then be booked; Staff don't see the tab", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=doctors");
    await expect(page.getByTestId("resources-section")).toBeVisible();
    await expect(page.getByTestId("resources-section")).not.toContainText(/linked_user|resourceId/);
    const label = `Dr E2E Visiting ${run}`;
    await page.getByTestId("resource-add").click();
    await page.getByTestId("resource-name").fill(label);
    await page.getByTestId("resource-save").click();
    const row = page.locator('[data-testid^="resource-row-"]').filter({ hasText: label });
    await expect(row).toContainText("No login");
    const lookups = (await api<{ doctors: { id: string; name: string }[] }>(page, "GET", "/lookups")).body;
    expect(lookups.doctors.map((d) => d.name)).toContain(label);
    // Clean up: archive it (resources are never deleted) and it leaves the booking list.
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(row).toContainText("Archived");
    sql(`DELETE FROM schedule_resources WHERE name = '${label}' AND id NOT IN (SELECT resource_id FROM appointments WHERE resource_id IS NOT NULL)`);

    await login(page, "eyev1.frontdesk@pulseos.local");
    await page.goto("/settings");
    await expect(page.getByTestId("settings-tab-doctors")).toHaveCount(0);
  });

  test("keyboard: the drawer and the completion sheet trap focus, Escape closes, focus returns to the control that opened them", async ({ page }) => {
    await login(page, "eyev1.coordinator@pulseos.local");
    const lead = await createLead(page, NAME("K"));
    await toWithDoctor(page, await book(page, lead));
    await page.goto(`/journeys/${lead.journeyId}`);
    const open = page.getByTestId("appointment-context-open");
    await open.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByTestId("appointment-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(":focus")).toHaveCount(1);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    await expect(drawer.locator(":focus")).toHaveCount(1); // Tab never leaves the dialog
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();

    const primary = page.getByTestId("appointment-context-primary");
    await primary.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByTestId("complete-consultation");
    await expect(sheet).toBeVisible();
    // The three choices are one radio group: arrow keys move between them, Space selects.
    await sheet.getByTestId("complete-next-none").focus();
    await page.keyboard.press("ArrowDown");
    await expect(sheet.getByTestId("complete-next-follow_up")).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]] as const) {
    test(`Front Desk, drawer and completion at ${w}x${h}: reachable, contained, no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await login(page, "eyev1.coordinator@pulseos.local");
      const lead = await createLead(page, NAME(`V${w}`));
      await toWithDoctor(page, await book(page, lead));
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      await page.goto(`/front-desk?q=${encodeURIComponent(`E2E M6 V${w} ${run}`)}`);
      await expect(page.getByTestId("front-desk-page")).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);
      if (w === 390) {
        // Every row action is a phone-sized target.
        const buttons = page.locator('[data-testid^="appointment-action-"], [data-testid^="appointment-complete-"], [data-testid^="appointment-noshow-"]');
        expect(await buttons.count()).toBeGreaterThan(0);
        for (const b of await buttons.all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(43);
      }

      await page.goto(`/journeys/${lead.journeyId}`);
      await page.getByTestId("appointment-context-open").click();
      const drawer = page.getByTestId("appointment-drawer");
      await expect(drawer).toBeVisible();
      await page.waitForTimeout(500); // the panel slides in: measure once it has settled
      const box = (await drawer.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(w + 1);
      if (w === 390) {
        expect(box.width).toBeGreaterThanOrEqual(w - 2); // full width on a phone
        for (const id of ["drawer-action-complete"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(43);
      }
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.getByTestId("drawer-action-complete").click();

      const sheet = page.getByTestId("complete-consultation");
      await expect(sheet).toBeVisible();
      await page.waitForTimeout(500);
      for (const kind of ["none", "follow_up", "surgery"]) {
        await sheet.getByTestId(`complete-next-${kind}`).check();
        expect(await overflow()).toBeLessThanOrEqual(0);
        const sb = (await sheet.boundingBox())!;
        expect(sb.x + sb.width).toBeLessThanOrEqual(w + 1);
      }
      if (w === 390) {
        // The three choices stack vertically with phone-sized targets.
        const boxes = await Promise.all(["none", "follow_up", "surgery"].map(async (k) => (await sheet.getByTestId(`complete-next-${k}`).locator("xpath=ancestor::label").boundingBox())!));
        expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
        expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y + boxes[1]!.height - 1);
        for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(43);
        expect((await sheet.getByTestId("complete-consultation-save").boundingBox())!.height).toBeGreaterThanOrEqual(43);
      }
    });
  }
});
