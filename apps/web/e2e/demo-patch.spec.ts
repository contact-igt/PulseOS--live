import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { purgeSignupTenants, sql } from "./support/fixtures";
import { pickPeriod, periodOptionLabels } from "./support/period";

// The rapid demo patch: PulseOS-owned date controls, Sign up, 7-day Remember me, Developer Access that lists new
// hospitals, a guided empty workspace, day navigation on Front Desk / Doctor Home, the Treatments date dimension and the
// Namokar telecalling demo. Screenshots land in review-artifacts/demo-patch (gitignored).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const OUT = path.resolve(__dirname, "../../../review-artifacts/demo-patch");
const NATIVE_LISTBOX = "select"; // a native <select> anywhere inside the period control would fail these specs

test.describe("demo patch", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));
  test.afterAll(() => purgeSignupTenants());

  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

  async function devLogin(page: Page, environment: string, role: string) {
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    await page.getByTestId(`dev-login-env-${environment}`).click();
    await page.getByTestId(`dev-login-role-${role}`).click();
    await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
  }

  test("login offers Sign in, Remember me, Create account and Developer access", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByTestId("remember-me")).not.toBeChecked();
    await expect(page.getByTestId("signup-link")).toBeVisible();
    await expect(page.getByTestId("dev-login-toggle")).toContainText("Developer access");
    await shot(page, "01-login");
  });

  test("Remember me: a persistent cookie that expires in about seven days, and it is not readable by page script", async ({ page, context }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("namokar.admin@pulseos.local");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByTestId("remember-me").check();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/command-centre/);
    const cookie = (await context.cookies()).find((c) => c.name === "pulseos_session")!;
    const days = (cookie.expires - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(cookie.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("pulseos_session");
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(cookie.value);
  });

  test("sign up in five steps, land in a guided empty workspace, and the new hospital appears in Developer Access", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const stamp = Date.now().toString(36);
    const email = `e2e.signup.${stamp}@example.test`;
    const hospital = `E2E Signup Eye Care ${stamp}`;

    await page.goto("/login");
    await page.getByTestId("signup-link").click();
    await expect(page).toHaveURL(/\/signup/);

    // Step 1 - the checks are friendly and stay on the step.
    await page.getByTestId("signup-next").click();
    await expect(page.getByText("Enter your full name")).toBeVisible();
    await page.getByTestId("signup-field-fullName").fill("Asha Verma");
    await page.getByTestId("signup-field-email").fill(email);
    await page.getByTestId("signup-field-phone").fill("+91 98765 43210");
    await page.getByTestId("signup-field-password").fill("Correct-Horse-9");
    await shot(page, "02-signup-step1");
    await page.getByTestId("signup-next").click();

    // Step 2
    await expect(page.getByTestId("signup-progress")).toHaveText("Step 2 of 5");
    await page.getByTestId("signup-field-organizationName").fill(hospital);
    await page.getByTestId("signup-orgtype-Eye Hospital").click();
    await page.getByTestId("signup-department-Ophthalmology").click();
    await shot(page, "03-signup-step2");
    await page.getByTestId("signup-next").click();

    // Step 3
    await page.getByTestId("signup-field-addressLine").fill("12 MG Road");
    await page.getByTestId("signup-field-city").fill("Bengaluru");
    await page.getByTestId("signup-field-state").fill("Karnataka");
    await page.getByTestId("signup-field-pinCode").fill("560038");
    await page.getByTestId("signup-next").click();

    // Step 4
    await page.getByTestId("signup-discovery-Referral").click();
    await page.getByTestId("signup-field-discoveryNotes").fill("Dr. Rao");
    await page.getByTestId("signup-next").click();

    // Step 5 - V1 is the default.
    await expect(page.getByTestId("signup-edition-V1")).toHaveAttribute("aria-checked", "true");
    await shot(page, "04-signup-step5");
    await page.getByTestId("signup-submit").click();
    await expect(page.getByTestId("signup-success")).toContainText("Your PulseOS workspace is ready.");
    await shot(page, "05-signup-success");

    await page.getByTestId("signup-go-dashboard").click();
    await expect(page).toHaveURL(/command-centre/);
    // Nothing to chart yet: the guided welcome, not a wall of zeros.
    await expect(page.getByTestId("workspace-welcome")).toBeVisible();
    await expect(page.getByTestId("kpi-strip")).toHaveCount(0);
    await expect(page.getByTestId("welcome-step-lead")).toHaveAttribute("data-done", "false");
    await expect(page.getByTestId("welcome-step-crm")).toHaveAttribute("data-done", "true"); // the Ophthalmology template is installed
    await shot(page, "06-new-workspace-welcome");

    // The hospital is saved in the database and listed in Developer Access (queried, not hard-coded).
    expect(sql(`SELECT count(*) FROM tenants WHERE name = '${hospital}'`)).toBe("1");
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    await page.getByRole("button", { name: hospital }).click();
    await page.getByTestId("dev-login-role-SUPER_ADMIN").click();
    await page.waitForURL(/command-centre/);
    await expect(page.getByTestId("workspace-welcome")).toBeVisible();
  });

  test("a duplicate email is refused on step 1 with a plain message", async ({ page }) => {
    await page.goto("/signup");
    await page.getByTestId("signup-field-fullName").fill("Asha Verma");
    await page.getByTestId("signup-field-email").fill("eye.admin@pulseos.local");
    await page.getByTestId("signup-field-phone").fill("+91 98765 43210");
    await page.getByTestId("signup-field-password").fill("Correct-Horse-9");
    await page.getByTestId("signup-next").click();
    await page.getByTestId("signup-field-organizationName").fill("E2E Signup Duplicate");
    await page.getByTestId("signup-orgtype-Clinic").click();
    await page.getByTestId("signup-department-Other").click();
    await page.getByTestId("signup-next").click();
    await page.getByTestId("signup-field-addressLine").fill("1 Test Road");
    await page.getByTestId("signup-field-city").fill("Pune");
    await page.getByTestId("signup-field-state").fill("Maharashtra");
    await page.getByTestId("signup-field-pinCode").fill("411001");
    await page.getByTestId("signup-next").click();
    await page.getByTestId("signup-discovery-Google").click();
    await page.getByTestId("signup-next").click();
    await page.getByTestId("signup-submit").click();
    await expect(page.getByTestId("signup-progress")).toHaveText("Step 1 of 5");
    await expect(page.getByText(/already exists/)).toBeVisible();
    expect(sql(`SELECT count(*) FROM tenants WHERE name = 'E2E Signup Duplicate'`)).toBe("0");
  });

  test("Developer Access lists the Namokar demo and signs in as its staff", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    await page.getByTestId("dev-login-env-namokar").click();
    const roles = await page.getByTestId("dev-login-roles").locator("button").allTextContents();
    expect(roles.join("|")).toMatch(/Admin/);
    expect(roles.join("|")).toMatch(/Front Desk/);
    expect(roles.join("|")).toMatch(/Coordinator/);
    expect(roles.join("|")).toMatch(/Doctor/);
    await shot(page, "07-developer-access");
    await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
    await page.waitForURL(/command-centre/);
  });

  test("Namokar Command Centre shows a real day, with the PulseOS period menu and calendar (no native controls)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "namokar", "HOSPITAL_ADMIN");
    // Namokar opens on Performance (no revenue workflow); this spec is about the Overview's day and its period controls.
    await page.goto("/command-centre?cc=overview");
    await expect(page.getByTestId("workspace-welcome")).toHaveCount(0);
    await expect(page.getByTestId("kpi-strip")).toBeVisible();
    const num = async (key: string) => Number((await page.getByTestId(`kpi-${key}`).innerText()).split("\n")[0]);
    expect(await num("newEnquiries")).toBeGreaterThanOrEqual(8);
    expect(await num("appointmentsToday")).toBe(10);
    expect(await num("waitingNow")).toBe(2);
    expect(await num("consultationsCompleted")).toBe(4);
    await shot(page, "08-namokar-command-centre");

    // The period menu is a PulseOS popover, not the browser's list.
    expect(await page.getByTestId("cc-range").evaluate((el) => el.tagName)).toBe("BUTTON");
    expect(await page.locator(`[data-testid="cc-range"] ${NATIVE_LISTBOX}`).count()).toBe(0);
    await page.getByTestId("cc-range").click();
    await expect(page.getByTestId("cc-range-menu")).toBeVisible();
    await expect(page.getByTestId("cc-range-option-30d")).toHaveAttribute("data-state", "checked");
    await page.waitForTimeout(300); // the menu glides into place; capture it settled
    await shot(page, "09-period-menu");
    await page.keyboard.press("Escape");
    expect(await periodOptionLabels(page, "cc")).toEqual(["Today", "Yesterday", "Last 7 days", "Last 9 days", "Last 30 days", "Last 90 days", "This month", "Previous month", "Custom range"]);

    // Keyboard: arrow + Enter chooses, Escape closes.
    await page.getByTestId("cc-range").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cc-range-menu")).toBeVisible();
    await expect(page.getByTestId("cc-range-option-30d")).toBeFocused(); // opens on the current choice
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("cc-range-option-9d")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cc-range-menu")).toHaveCount(0);
    await expect(page.getByTestId("cc-range")).not.toHaveAttribute("data-value", "30d");

    // Custom range -> PulseOS calendar popover, Apply.
    await pickPeriod(page, "cc", "custom");
    await page.getByTestId("cc-range-picker").click();
    await expect(page.getByTestId("cc-calendar")).toBeVisible();
    await expect(page.locator('[data-testid="cc-range-popover"] input[type="date"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, "10-calendar-popover");
    const today = await page.getByTestId("cc-calendar").locator('[aria-current="date"]').getAttribute("data-day");
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Future days are not selectable.
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (await page.getByTestId(`cc-day-${tomorrow}`).count()) await expect(page.getByTestId(`cc-day-${tomorrow}`)).toBeDisabled();
    await page.getByTestId("cc-today").click();
    await page.getByTestId("cc-apply").click();
    await expect(page.getByTestId("cc-period-caption")).toContainText("Custom range");
    await expect(page).toHaveURL(new RegExp(`from=${today}&to=${today}`));
  });

  test("Namokar Leads, My Work, Appointments and Analytics have the day's work", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "namokar", "PATIENT_COORDINATOR");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await expect(page.getByTestId("leads-range")).toHaveAttribute("data-value", "");
    await pickPeriod(page, "leads", "today");
    await expect(page.getByTestId("leads-range")).toHaveAttribute("data-value", "today");
    await shot(page, "11-namokar-leads");
    await page.goto("/my-work");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await shot(page, "12-namokar-my-work");
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await shot(page, "13-namokar-appointments");
  });

  test("Namokar Front Desk: today's queue first, then previous / next day and a calendar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "namokar", "FRONT_DESK");
    await expect(page).toHaveURL(/front-desk/);
    await expect(page.getByTestId("front-desk-day-label")).toContainText("Today");
    await shot(page, "14-namokar-front-desk");

    await page.getByTestId("front-desk-prev-day").click();
    await expect(page.getByTestId("front-desk-day-label")).toContainText("Yesterday");
    await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
    await page.getByTestId("front-desk-next-day").click();
    await page.getByTestId("front-desk-next-day").click();
    await expect(page.getByTestId("front-desk-day-label")).toContainText("Tomorrow");
    await page.getByTestId("front-desk-date-picker").click();
    await expect(page.getByTestId("front-desk-date-calendar")).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, "15-front-desk-calendar");
    await page.getByTestId("front-desk-date-today").click();
    await expect(page.getByTestId("front-desk-day-label")).toContainText("Today");
    await expect(page).not.toHaveURL(/date=/);
  });

  test("Doctor Home steps between days and says which day it shows", async ({ page }) => {
    await devLogin(page, "namokar", "DOCTOR");
    await expect(page.getByTestId("doctor-day-label")).toContainText("Today");
    await page.getByTestId("doctor-next-day").click();
    await expect(page.getByTestId("doctor-day-label")).toContainText("Tomorrow");
    await expect(page.getByText(/Patient queue · Tomorrow/)).toBeVisible();
    await page.getByTestId("doctor-back-to-today").click();
    await expect(page.getByTestId("doctor-day-label")).toContainText("Today");
  });

  test("Treatments: the date filter always names its dimension", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "namokar", "HOSPITAL_ADMIN");
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await expect(page.getByTestId("treatment-date-range")).toHaveCount(0);
    const chooseDimension = async (key: string) => {
      await page.getByTestId("treatment-date-dimension").click();
      await page.getByTestId(`treatment-date-dimension-option-${key}`).click();
    };
    await chooseDimension("completed");
    await expect(page).toHaveURL(/tdate=completed/);
    await expect(page.getByTestId("treatment-date-range")).toBeVisible();
    await chooseDimension("scheduled");
    await expect(page).toHaveURL(/tdate=scheduled/);
    await shot(page, "16-treatments-date");
    await chooseDimension("none");
    await expect(page.getByTestId("treatment-date-range")).toHaveCount(0);
  });

  test("on a phone the period menu, calendar and day navigation fit and are 44px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page, "namokar", "HOSPITAL_ADMIN");
    await page.goto("/command-centre?cc=overview");
    const fits = async (id: string) => {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    };
    await fits("cc-range");
    await pickPeriod(page, "cc", "custom");
    await page.getByTestId("cc-range-picker").click();
    const cal = (await page.getByTestId("cc-range-popover").boundingBox())!;
    expect(cal.x).toBeGreaterThanOrEqual(0);
    expect(cal.x + cal.width).toBeLessThanOrEqual(390.5);
    await page.waitForTimeout(300);
    await shot(page, "17-mobile-calendar");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
