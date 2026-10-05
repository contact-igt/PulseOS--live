import { test, expect } from "@playwright/test";
import path from "path";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts");

async function login(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function shot(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: true });
}

test.describe("CRM + specialty + marketing-efficiency checkpoint screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("captures the required checkpoint screenshot set", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");

    // 01 — Leads page
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await shot(page, "01-leads-page.png");

    // 02 — Add Lead drawer
    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await shot(page, "02-add-lead-drawer.png");

    // 03 — Add Lead specialty fields
    await page.getByTestId("lead-specialty-select").selectOption("GYNECOLOGY");
    await page.getByTestId("lead-additional-toggle").click();
    await expect(page.getByTestId("lead-custom-fields")).toBeVisible();
    await page.getByTestId("lead-custom-fields").scrollIntoViewIfNeeded();
    await shot(page, "03-add-lead-specialty-fields.png");
    await page.getByTestId("add-lead-drawer-close").click();
    await expect(page.getByTestId("add-lead-drawer")).not.toBeVisible();

    // 04 — Quick Create
    await page.getByTestId("quick-create-button").click();
    await expect(page.getByTestId("quick-create-menu")).toBeVisible();
    await shot(page, "04-quick-create.png");
    await page.keyboard.press("Escape");

    // 05/06/07 — Campaigns page + specialty filter + marketing efficiency
    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await shot(page, "05-campaigns-page.png");
    await shot(page, "07-marketing-efficiency.png");

    await page.getByTestId("campaigns-specialty-filter").selectOption("GYNECOLOGY");
    await expect(page.getByText("Meta – Antenatal Care Awareness")).toBeVisible();
    await shot(page, "06-campaign-specialty-filter.png");

    // 08/09 — Specialties settings + fields expanded
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await shot(page, "08-specialties-settings.png");

    await page.getByTestId("specialty-toggle-FERTILITY").waitFor();
    // A service's fields live in Settings → CRM Fields.
    await page.goto("/settings?section=fields&service=FERTILITY");
    await expect(page.getByTestId("field-row-trying_duration")).toBeVisible();
    await shot(page, "09-specialty-fields.png");

    // 10 — Add Patient
    await page.getByTestId("quick-create-button").click();
    await page.getByTestId("quick-create-patient").click();
    await expect(page.getByTestId("add-patient-drawer")).toBeVisible();
    await shot(page, "10-add-patient.png");
    await page.keyboard.press("Escape");

    // 11 — New Appointment
    await page.getByTestId("quick-create-button").click();
    await page.getByTestId("quick-create-appointment").click();
    await expect(page.getByTestId("new-appointment-drawer")).toBeVisible();
    await shot(page, "11-new-appointment.png");
    await page.keyboard.press("Escape");

    // 12 — Add Task
    await page.getByTestId("quick-create-button").click();
    await page.getByTestId("quick-create-task").click();
    await expect(page.getByTestId("add-task-drawer")).toBeVisible();
    await shot(page, "12-add-task.png");
    await page.keyboard.press("Escape");

    // 13/14/15 — mobile: Leads, Add Lead, Campaigns
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await shot(page, "13-leads-mobile.png");

    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await shot(page, "14-add-lead-mobile.png");
    await page.keyboard.press("Escape");

    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await shot(page, "15-campaigns-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });

    // 16-20 — updated flagship screenshots
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await shot(page, "16-admin.png");

    await login(page, "gyn.frontdesk@pulseos.local");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await shot(page, "17-front-desk.png");

    await login(page, "gyn.coordinator@pulseos.local");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await shot(page, "18-my-work.png");

    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await shot(page, "19-patients.png");

    await page.goto("/patients?search=Priya");
    await page.getByText("Priya Sharma").first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await shot(page, "20-patient-360.png");
  });
});
