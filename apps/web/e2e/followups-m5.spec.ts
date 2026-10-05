import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TZ = "Asia/Kolkata";
const run = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E FollowUp ${n} ${run}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

/** A fresh named lead through the real API as the signed-in user (removed afterwards by name prefix). */
async function createLead(page: Page, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return page.evaluate(
    async ({ api, name, phone, extra }) => {
      const branches = ((await (await fetch(`${api}/lookups`, { credentials: "include" })).json()) as { branches: { id: string }[] }).branches;
      const res = await fetch(`${api}/leads`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone, specialtyKey: "CATARACT", branchId: branches[0]!.id, journeyType: "Cataract", sourceKey: "google", customFieldValues: {}, ...extra }),
      });
      return ((await res.json()) as { journeyId: string }).journeyId;
    },
    { api: API, name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, extra },
  );
}

const dayInHospital = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });

test.describe("M5 — follow-ups and the Journey workspace", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => {
    purgePatients("E2E FollowUp ");
    sql(`DELETE FROM followup_types WHERE key LIKE 'custom_e2e_%' AND tenant_id IN (SELECT id FROM tenants WHERE name = 'PulseOS Ophthalmology V1 Demo')`);
  });

  test("FLOW A: Add follow-up → Appointment Follow-up, tomorrow 11:00 → Next Action → My Work → persists after refresh", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("A");
    const journeyId = await createLead(page, name);
    await page.goto(`/journeys/${journeyId}`);
    await expect(page.getByTestId("next-action-empty")).toHaveText("No follow-up scheduled");
    await expect(page.getByTestId("appointment-context-empty")).toBeVisible();
    // The three primary actions sit together at the top.
    for (const id of ["journey-log-call", "journey-add-followup", "journey-book-appointment"]) await expect(page.getByTestId(id)).toBeVisible();

    await page.getByTestId("journey-add-followup").click();
    const sheet = page.getByTestId("add-followup");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("add-followup-date")).toHaveValue(""); // nothing assumed
    await sheet.getByTestId("add-followup-type").selectOption({ label: "Appointment Follow-up" });
    await sheet.getByTestId("add-followup-date").fill(dayInHospital(1));
    await sheet.getByTestId("add-followup-time").fill("11:00");
    await sheet.getByTestId("add-followup-note").fill("Interested, will decide on a slot");
    await sheet.getByTestId("add-followup-save").dblclick(); // a double tap must not create two
    await expect(sheet).not.toBeVisible();

    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Follow-up");
    await expect(page.getByTestId("next-action-due")).toContainText("11:00");
    await expect(page.getByTestId("next-action-owner")).not.toHaveText("Unassigned");
    await expect(page.getByTestId("next-action-note")).toContainText("Interested");
    await expect(page.getByText("Follow-up scheduled · Appointment Follow-up")).toBeVisible();
    expect(sql(`SELECT count(*) FROM tasks WHERE journey_id = '${journeyId}'`)).toBe("1");

    await page.goto("/my-work?tab=upcoming");
    const row = page.locator('[data-testid^="task-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Appointment Follow-up");

    await page.goto(`/journeys/${journeyId}`);
    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Follow-up");
  });

  test("FLOW B: Appointment Risk — needs a reason, shows in its own My Work bucket, completes out of it, and the Timeline records it", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("B");
    const journeyId = await createLead(page, name);
    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("journey-add-followup").click();
    const sheet = page.getByTestId("add-followup");
    await sheet.getByTestId("add-followup-type").selectOption({ label: "Appointment Risk" });
    await sheet.getByTestId("add-followup-date").fill(dayInHospital(1));
    await sheet.getByTestId("add-followup-time").fill("10:00");
    await sheet.getByTestId("add-followup-save").click();
    await expect(sheet.getByTestId("add-followup-error")).toContainText("needs a note"); // client-side, nothing sent
    await sheet.getByTestId("add-followup-note").fill("Patient asked to move the time");
    await sheet.getByTestId("add-followup-save").click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Risk");
    await expect(page.getByTestId("next-action")).toContainText("High priority");

    await page.goto("/my-work?tab=appointment_risk");
    await expect(page.getByTestId("my-work-tab-count-appointment_risk")).not.toHaveText("0");
    await expect(page.locator('[data-testid^="task-row-"]').filter({ hasText: name })).toBeVisible();

    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("next-action-complete").click();
    await expect(page.getByTestId("next-action-empty")).toBeVisible(); // nothing else open: the card says so
    await expect(page.getByText("Follow-up completed · Appointment Risk")).toBeVisible();

    await page.goto("/my-work?tab=appointment_risk");
    await expect(page.locator('[data-testid^="task-row-"]').filter({ hasText: name })).toHaveCount(0);
  });

  test("an empty Appointment Risk bucket says so properly", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/my-work?tab=appointment_risk&type=surgery_followup");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await expect(page.getByText("No appointment risks")).toBeVisible();
  });

  test("FLOW C: Book appointment from the Journey → doctor, date, time → Journey shows it → Appointments shows it → persists", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("C");
    const journeyId = await createLead(page, name);
    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("journey-book-appointment").click();
    const drawer = page.getByTestId("new-appointment-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(name)).toBeVisible(); // patient pre-filled
    await expect(drawer.locator("#appt-journey")).toHaveValue(journeyId); // journey pre-selected
    await drawer.locator("#appt-branch").selectOption({ index: 1 });
    await drawer.locator("#appt-doctor").selectOption({ index: 1 });
    await drawer.locator("#appt-time").fill(`${dayInHospital(1)}T10:30`);
    await drawer.getByTestId("new-appointment-submit").click();
    await expect(drawer).not.toBeVisible();

    const ctx = page.getByTestId("appointment-context");
    await expect(ctx).toContainText("Upcoming appointment");
    await expect(ctx).toContainText("10:30");
    await expect(page.getByTestId("appointment-context-doctor")).not.toBeEmpty();
    await expect(page.getByText(/Appointment booked · .*10:30 am/)).toBeVisible();

    // The stored instant is 10:30 in the hospital (05:00 UTC), whatever the browser's zone.
    expect(sql(`SELECT to_char(scheduled_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM appointments WHERE journey_id = '${journeyId}'`)).toBe("10:30");
    expect(sql(`SELECT count(*) FROM appointments WHERE journey_id = '${journeyId}'`)).toBe("1");

    await page.goto(`/appointments?date=${dayInHospital(1)}`);
    await expect(page.getByText(name).first()).toBeVisible();
    await page.goto(`/journeys/${journeyId}`);
    await expect(page.getByTestId("appointment-context")).toContainText("Upcoming appointment");
  });

  test("FLOW D: a callback from a logged call shows as 'Callback' in My Work and as the Journey's Next Action", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("D");
    const journeyId = await createLead(page, name);
    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("journey-log-call").click();
    const sheet = page.getByTestId("log-call");
    await sheet.getByTestId("log-call-feedback").fill("Wants a call back");
    await sheet.getByTestId("log-call-outcome").selectOption("needs_callback");
    await sheet.getByTestId("log-call-save").click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByTestId("next-action-type")).toHaveText("Callback");
    await page.goto("/my-work");
    const row = page.locator('[data-testid^="task-row-"]').filter({ hasText: name });
    await expect(row).toContainText("Callback");
  });

  test("Reschedule moves the due time and Reassign changes only the follow-up's owner — the journey keeps its own", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const name = NAME("R");
    const journeyId = await createLead(page, name);
    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("journey-add-followup").click();
    let sheet = page.getByTestId("add-followup");
    await sheet.getByTestId("add-followup-date").fill(dayInHospital(1));
    await sheet.getByTestId("add-followup-time").fill("09:00");
    await sheet.getByTestId("add-followup-save").click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByTestId("next-action-due")).toContainText("9:00");

    await page.getByTestId("next-action-reschedule").click();
    sheet = page.getByTestId("reschedule-followup");
    await sheet.getByTestId("reschedule-date").fill(dayInHospital(3));
    await sheet.getByTestId("reschedule-time").fill("16:15");
    await sheet.getByTestId("reschedule-note").fill("Patient asked for Friday afternoon");
    await sheet.getByTestId("reschedule-save").click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByTestId("next-action-due")).toContainText("4:15");
    await expect(page.getByTestId("next-action-note")).toContainText("Friday afternoon");

    // A past time is refused and nothing changes.
    await page.getByTestId("next-action-reschedule").click();
    sheet = page.getByTestId("reschedule-followup");
    await sheet.getByTestId("reschedule-date").fill(dayInHospital(-1));
    await sheet.getByTestId("reschedule-save").click();
    await expect(sheet.getByTestId("reschedule-error")).toContainText("future");
    await page.keyboard.press("Escape");

    await page.getByTestId("next-action-reassign").click();
    sheet = page.getByTestId("reassign-followup");
    await sheet.getByTestId("reassign-owner").selectOption({ label: "Arun Kulkarni" });
    await sheet.getByTestId("reassign-save").click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByTestId("next-action-owner")).toHaveText("Arun Kulkarni");
    expect(sql(`SELECT owner_user_id IS NULL FROM journeys WHERE id = '${journeyId}'`)).toBe("t"); // the journey's owner was never set, never touched
  });

  test("Settings → Follow-up Types: Admin sees the five defaults, can add and archive; Staff do not see the tab", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=followups");
    await expect(page.getByTestId("followup-types-section")).toBeVisible();
    for (const key of ["callback", "appointment_followup", "appointment_risk", "general_followup", "surgery_followup"]) await expect(page.getByTestId(`followup-type-row-${key}`)).toBeVisible();
    await expect(page.getByTestId("followup-type-row-appointment_risk")).toContainText("Needs a note");
    await expect(page.getByTestId("followup-types-section")).not.toContainText("FOLLOW_UP"); // internal names are never shown

    const label = `E2E Pre-op ${run}`;
    await page.getByTestId("followup-type-add").click();
    await page.getByTestId("followup-type-name").fill(label);
    await page.getByTestId("followup-type-priority").selectOption("high");
    await page.getByTestId("followup-type-save").click();
    await expect(page.getByText(label)).toBeVisible();

    await page.getByTestId("followup-type-toggle-surgery_followup").click();
    await expect(page.getByTestId("followup-type-row-surgery_followup")).toContainText("Archived");
    await page.getByTestId("followup-type-toggle-surgery_followup").click();
    await expect(page.getByTestId("followup-type-row-surgery_followup")).not.toContainText("Archived");
    await page.getByTestId(`followup-type-toggle-custom_e2e_pre_op_${run}`).click();

    await login(page, "eyev1.frontdesk@pulseos.local");
    await page.goto("/settings");
    await expect(page.getByTestId("settings-tab-followups")).toHaveCount(0);
  });

  test("Doctor has none of the three actions", async ({ page }) => {
    await login(page, "eyev1.doctor@pulseos.local");
    const journeyId = sql(`SELECT j.id FROM journeys j JOIN tenants t ON t.id = j.tenant_id WHERE t.name = 'PulseOS Ophthalmology V1 Demo' ORDER BY j.created_at LIMIT 1`);
    await page.goto(`/journeys/${journeyId}`).catch(() => undefined);
    for (const id of ["journey-log-call", "journey-add-followup", "journey-book-appointment"]) await expect(page.getByTestId(id)).toHaveCount(0);
  });

  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    test(`Journey workspace + My Work at ${w}x${h}: actions reachable, sheets contained, no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await login(page, "eyev1.frontdesk@pulseos.local");
      const journeyId = await createLead(page, NAME(`V${w}`));
      await page.goto(`/journeys/${journeyId}`);
      await expect(page.getByTestId("journey-add-followup")).toBeVisible();
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(await overflow()).toBeLessThanOrEqual(1);
      const addBox = (await page.getByTestId("journey-add-followup").boundingBox())!;
      expect(addBox.height).toBeGreaterThanOrEqual(w <= 430 ? 44 : 30);
      expect(addBox.x + addBox.width).toBeLessThanOrEqual(w + 1);

      await page.getByTestId("journey-add-followup").click();
      const sheet = page.getByTestId("add-followup");
      await expect(sheet).toBeVisible();
      await expect.poll(async () => { const b = (await sheet.boundingBox())!; return b.x + b.width; }, { timeout: 3000 }).toBeLessThanOrEqual(w + 1);
      if (w <= 430) expect((await sheet.boundingBox())!.width).toBeGreaterThan(w * 0.9);
      await sheet.getByTestId("add-followup-date").fill(dayInHospital(2));
      await sheet.getByTestId("add-followup-time").fill("12:00");
      expect(await overflow()).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
      await expect(sheet).not.toBeVisible();
      await expect(page.getByTestId("journey-add-followup")).toBeFocused();

      await page.goto("/my-work");
      await expect(page.getByTestId("my-work-tab-appointment_risk")).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(1);
    });
  }
});
