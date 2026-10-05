import { test, expect, type Page } from "@playwright/test";
import path from "path";

// Screenshot package for the "PROFESSIONAL FUTURISTIC ENTERPRISE UI/UX
// MASTER LOOP" pass (2026-09-21) — extends review-artifacts with a fresh,
// dedicated set under review-artifacts/enterprise-ui-review/. Desktop
// (1440) coverage of the full §61 review order, plus tablet/mobile spot
// checks on the three explicit flagship screens.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts/enterprise-ui-review");

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Enterprise UI loop screenshot package", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("captures the full §61 review order at 1440, plus flagship responsive checks", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // 01 Login
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "01-login.png") });

    await login(page, "gyn.admin@pulseos.local");

    // 02 Shell / 03 Command Centre
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "03-command-centre.png") });

    // 04 Leads
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "04-leads.png") });

    // 05 Add Lead
    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "05-add-lead.png") });
    await page.keyboard.press("Escape");

    // 06 Patients
    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "06-patients.png") });

    // 07 Patient 360
    await page.getByText("Priya Sharma", { exact: true }).first().click();
    await expect(page).toHaveURL(/\/patients\/[^/]+$/);
    await expect(page.getByText(/\d+ events?$/)).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "07-patient-360.png") });

    // 08 Journeys
    await page.goto("/journeys");
    await expect(page.getByTestId("journeys-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "08-journeys.png") });

    // 09 Front Desk
    await page.goto("/front-desk");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "09-front-desk.png") });

    // 12 Appointments + 13 Appointment Drawer
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.getByTestId("appointments-tab-completed").click();
    const firstRow = page.locator('[data-testid^="appointment-row-"]').first();
    await expect(firstRow).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "12-appointments.png") });
    await firstRow.click();
    await expect(page.getByTestId("appointment-drawer")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "13-appointment-drawer.png") });
    await page.keyboard.press("Escape");

    // 14 Treatments
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "14-treatments.png") });

    // 15 Inbox
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "15-inbox.png") });

    // 16 Campaigns + 17 Campaign Detail
    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    const firstCampaignLink = page.locator("table tbody tr td a").first();
    await expect(firstCampaignLink).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "16-campaigns.png") });
    await firstCampaignLink.click();
    await expect(page.getByText("Back to Campaigns")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "17-campaign-detail.png") });

    // 18 Integrations
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "18-integrations.png") });

    // 19 Settings
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "19-settings.png") });

    // 20 Global Search
    await page.goto("/command-centre");
    await page.getByTestId("global-patient-search").fill("pri");
    await expect(page.getByTestId("global-patient-search-results")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "20-global-search.png") });
    await page.keyboard.press("Escape");

    // 10/11 My Work (coordinator — has assigned tasks, shows overdue emphasis)
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/my-work");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await page.getByTestId("my-work-tab-overdue").click();
    await expect(page.getByTestId("my-work-task-list")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "10-my-work-overdue.png") });

    // Doctor Home
    await login(page, "gyn.doctor@pulseos.local");
    await page.goto("/doctor-home");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await expect(page.getByText("Today's Patient Queue")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "11-doctor-home.png") });
  });

  test("flagship responsive checks — Command Centre / Patient 360 / Inbox at 1280/1024/768/390", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    const viewports = [
      { name: "1280", width: 1280, height: 800 },
      { name: "1024", width: 1024, height: 768 },
      { name: "768", width: 768, height: 1024 },
      { name: "390", width: 390, height: 844 },
    ];
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/command-centre");
      await expect(page.getByTestId("command-centre")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `responsive-command-centre-${vp.name}.png`) });

      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-page")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `responsive-inbox-${vp.name}.png`) });
    }
  });
});
