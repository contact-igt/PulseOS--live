import { test, expect, type Page } from "@playwright/test";
import { purgePatients } from "./support/fixtures";

// M6.6 Add Lead: the short path, one Save, callback or appointment created together with the lead.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TZ = "Asia/Kolkata";
const RUN = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E M66A ${n} ${RUN}`;
const dayIST = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
// A day nobody else books: 60–120 days out, distinct per run.
const FAR_DAY = dayIST(60 + (Number(RUN) % 60));
const FAR_HOUR = String(9 + (Number(RUN) % 8)).padStart(2, "0");

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function openAddLead(page: Page) {
  await page.goto("/leads");
  await page.getByTestId("add-lead-button").click();
  await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
}

async function fillCore(page: Page, name: string, opts: { channel?: string; source?: string } = {}) {
  await page.getByTestId("lead-phone-input").fill(phone());
  await page.getByTestId("lead-name-input").fill(name);
  await page.getByTestId("lead-specialty-select").selectOption({ label: "Cataract" });
  // A multi-branch hospital is asked which branch (never silently the first one); a single-branch hospital is not.
  const branch = page.locator("#lead-branch");
  if ((await branch.inputValue()) === "") await branch.selectOption({ index: 1 });
  if (opts.source) await page.getByTestId("lead-source-select").selectOption(opts.source);
  if (opts.channel) await page.getByTestId("lead-channel-select").selectOption(opts.channel);
}

test.describe("M6.6 — Add Lead", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => purgePatients("E2E M66A "));

  test("A: Instagram → Cataract → Callback tomorrow 11:00 → Save → Leads → Journey → My Work", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await openAddLead(page);
    const name = NAME("A");
    await fillCore(page, name, { channel: "INSTAGRAM_DM", source: "instagram" });

    // Short path: nothing about appointments, call details or extra fields is showing yet.
    await expect(page.getByTestId("lead-appt-fields")).toHaveCount(0);
    await expect(page.getByTestId("lead-callback-fields")).toHaveCount(0);
    await expect(page.getByTestId("lead-call-details")).toHaveCount(0);
    await expect(page.locator("#lead-email")).toBeHidden(); // inside collapsed "Additional details"

    await page.getByTestId("lead-outcome-select").selectOption({ label: "Needs callback" });
    await expect(page.getByTestId("lead-next-callback")).toBeChecked(); // an outcome that needs a follow-up moves the choice
    await expect(page.getByTestId("lead-next-none")).toBeDisabled();
    await expect(page.getByTestId("lead-next-appointment")).toBeDisabled();
    await expect(page.getByTestId("lead-callback-fields")).toBeVisible();
    await page.getByTestId("lead-callback-date").fill(dayIST(1));
    await page.getByTestId("lead-callback-time").fill("11:00");
    await page.getByTestId("lead-callback-note").fill("Prefers morning");

    const saved = page.waitForResponse((r) => r.url().endsWith("/leads") && r.request().method() === "POST");
    await page.getByTestId("add-lead-submit").click();
    expect((await saved).status()).toBe(201);
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();

    // Leads: the row shows enquiry, original source, outcome and the callback as next action.
    await page.goto("/leads");
    const row = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Instagram");
    await expect(row).toContainText("Needs callback");
    await expect(row).toContainText("Callback");

    // Journey: callback at 11:00 hospital time, honest manual capture line, source and channel apart.
    await row.click({ position: { x: 300, y: 10 } });
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByText(/Instagram DM manually captured/)).toBeVisible();
    await expect(page.getByText(/Follow-up scheduled · Callback/)).toBeVisible();
    await expect(page.getByText(/11:00 am/i).first()).toBeVisible();

    // My Work lists the callback.
    await page.goto("/my-work");
    await expect(page.getByText(name).first()).toBeVisible();
  });

  test("B: Phone → Cataract → Appointment → Save → Journey → Appointments", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.frontdesk@pulseos.local");
    await openAddLead(page);
    const name = NAME("B");
    await fillCore(page, name, { channel: "MANUAL_CALL", source: "phone" });
    await expect(page.getByTestId("lead-call-details")).toBeVisible(); // phone enquiries can record the call
    await page.getByTestId("lead-call-toggle").check();
    await page.getByTestId("lead-call-minutes").fill("2");
    await page.getByTestId("lead-call-note").fill("Asked about surgery cost");

    await page.getByTestId("lead-next-appointment").check();
    await expect(page.getByTestId("lead-appt-fields")).toBeVisible();
    const doctor = page.getByTestId("lead-appt-doctor");
    await doctor.selectOption({ index: 1 });
    await page.getByTestId("lead-appt-date").fill(FAR_DAY);
    await page.getByTestId("lead-appt-time").fill(`${FAR_HOUR}:15`);

    const saved = page.waitForResponse((r) => r.url().endsWith("/leads") && r.request().method() === "POST");
    await page.getByTestId("add-lead-submit").click();
    const res = await saved;
    expect(res.status(), await res.text()).toBe(201);
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();

    await page.goto("/leads");
    const row = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(row.locator('[data-testid^="lead-visit-"]')).toBeVisible(); // the Appointment column shows the booked visit
    await row.click({ position: { x: 300, y: 10 } });
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByText(/Appointment booked/).first()).toBeVisible();
    await expect(page.getByText(/Phone call recorded manually/)).toBeVisible();
    await expect(page.getByText(/call/i).first()).toBeVisible();

    await page.goto(`/appointments?view=calendar&date=${FAR_DAY}`);
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await expect(page.getByText(name).first()).toBeVisible();
  });

  test("C: doctor already booked → clear message, nothing saved, the form is kept → another time succeeds", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    // Book the doctor at a slot first, through the API.
    const day = dayIST(130 + (Number(RUN) % 60));
    await openAddLead(page);
    const first = NAME("C1");
    await fillCore(page, first, { source: "google" });
    await page.getByTestId("lead-next-appointment").check();
    await page.getByTestId("lead-appt-doctor").selectOption({ index: 1 });
    await page.getByTestId("lead-appt-date").fill(day);
    await page.getByTestId("lead-appt-time").fill(`${FAR_HOUR}:30`);
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();

    // Second lead, same doctor, same minute.
    await openAddLead(page);
    const second = NAME("C2");
    await fillCore(page, second, { source: "google" });
    await page.getByTestId("lead-next-appointment").check();
    await page.getByTestId("lead-appt-doctor").selectOption({ index: 1 });
    await page.getByTestId("lead-appt-date").fill(day);
    await page.getByTestId("lead-appt-time").fill(`${FAR_HOUR}:30`);
    // The advisory check warns while typing…
    await expect(page.getByTestId("lead-appt-warning")).toContainText("already has another appointment");
    // …and the save is refused with the same plain sentence, without losing a keystroke.
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-error")).toContainText("This doctor already has another appointment at this time. Choose a different time or doctor.");
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await expect(page.getByTestId("lead-name-input")).toHaveValue(second);
    await expect(page.getByTestId("lead-appt-date")).toHaveValue(day);
    await expect(page.getByTestId("lead-appt-time")).toHaveValue(`${FAR_HOUR}:30`);
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0); // a business error never becomes an overlay

    // Nothing was saved for the refused attempt.
    await page.getByTestId("add-lead-drawer-close").click();
    await page.goto("/leads?range=today");
    await expect(page.locator('[data-testid^="lead-row-"]').filter({ hasText: second })).toHaveCount(0);

    // Choose another time: the same form, one change, success.
    await openAddLead(page);
    await fillCore(page, second, { source: "google" });
    await page.getByTestId("lead-next-appointment").check();
    await page.getByTestId("lead-appt-doctor").selectOption({ index: 1 });
    await page.getByTestId("lead-appt-date").fill(day);
    await page.getByTestId("lead-appt-time").fill(`${FAR_HOUR}:45`);
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();
  });

  test("outcome rules shape the next step: a lost outcome has none; an appointment needs an outcome that allows it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await openAddLead(page);
    await page.getByTestId("lead-outcome-select").selectOption({ label: "Not interested" });
    for (const k of ["callback", "appointment", "follow_up"]) await expect(page.getByTestId(`lead-next-${k}`)).toBeDisabled();
    await expect(page.getByTestId("lead-next-none")).toBeChecked();
    await expect(page.getByTestId("lead-outcome-reason")).toBeVisible(); // this outcome asks why
    await expect(page.getByTestId("lead-next-hint")).toContainText("closes the journey");
    await page.getByTestId("lead-outcome-select").selectOption({ label: "Price enquiry" });
    await expect(page.getByTestId("lead-next-appointment")).toBeDisabled();
    await expect(page.getByTestId("lead-next-callback")).toBeEnabled();
    await page.getByTestId("lead-outcome-select").selectOption({ label: "Interested" });
    await expect(page.getByTestId("lead-next-appointment")).toBeEnabled();
  });

  test("a past time is caught inline and on Save, and the form keeps what was typed; IVR is not a manual channel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await openAddLead(page);
    const options = await page.getByTestId("lead-channel-select").locator("option").allTextContents();
    expect(options).toEqual(["Not specified", "Phone call", "WhatsApp", "Instagram DM", "Facebook DM", "Walk-in"]);
    const name = NAME("P");
    await fillCore(page, name);
    await page.getByTestId("lead-next-callback").check();
    await page.getByTestId("lead-callback-date").fill(dayIST(0));
    await page.getByTestId("lead-callback-time").fill("00:01");
    await expect(page.getByTestId("lead-callback-past")).toContainText("future");
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-error")).toContainText(/future/i);
    await expect(page.getByTestId("lead-name-input")).toHaveValue(name);
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
  });

  test("a multi-branch hospital is asked for the branch: it is never silently the first one, and Save does not go through without it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await openAddLead(page);
    const branch = page.locator("#lead-branch");
    expect((await branch.locator("option").count()) - 1).toBeGreaterThan(1); // the demo hospital has several branches
    await expect(branch).toHaveValue("");
    await page.getByTestId("lead-phone-input").fill(phone());
    await page.getByTestId("lead-specialty-select").selectOption({ label: "Cataract" });
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible(); // refused: the browser asks for the branch
    expect(await branch.evaluate((el) => (el as HTMLSelectElement).validity.valueMissing)).toBe(true);
  });

  test("keyboard: the drawer traps focus, Escape closes it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await openAddLead(page);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="add-lead-drawer"]'))).toBe(true); // focus moved into the dialog
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="add-lead-drawer"]'))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();
  });

  for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    test(`${vp.width}x${vp.height}: Add Lead is contained, scrollable to Save, with 44px touch targets on phones`, async ({ page }) => {
      await page.setViewportSize(vp);
      await login(page, "eyev1.coordinator@pulseos.local");
      await openAddLead(page);
      await page.getByTestId("lead-next-appointment").check();
      const box = await page.getByTestId("add-lead-drawer").boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
      await page.getByTestId("add-lead-submit").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("add-lead-submit")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if (vp.width < 768) {
        for (const id of ["lead-phone-input", "lead-specialty-select", "lead-appt-doctor", "add-lead-submit", "lead-additional-toggle"]) {
          expect((await page.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(43.5);
        }
      }
    });
  }
});
