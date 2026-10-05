import { test, expect, type Page } from "@playwright/test";
import path from "path";

// "Before" screenshot package for the "UI REFINEMENT V2 + FUNCTIONAL
// COMPLETION MASTER LOOP" pass (2026-09-21), per prompt §05. Captured before
// any code changes in this pass, against the running convergence dev server.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts/enterprise-ui-refinement-v2/before");

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("UI refinement v2 — before screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("desktop 1440 set", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "01-login-1440.png") });

    await login(page, "gyn.admin@pulseos.local");

    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "02-command-centre-1440.png") });

    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "05-leads-1440.png") });

    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "06-add-lead-1440.png") });
    await page.keyboard.press("Escape");

    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "07-patients-1440.png") });

    await page.getByText("Priya Sharma", { exact: true }).first().click();
    await expect(page).toHaveURL(/\/patients\/[^/]+$/);
    await expect(page.getByText(/\d+ events?$/)).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "08-patient360-1440.png") });

    await page.goto("/front-desk");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "09-front-desk-1440.png") });

    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.getByTestId("appointments-tab-completed").click();
    const firstRow = page.locator('[data-testid^="appointment-row-"]').first();
    await expect(firstRow).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "12-appointments-1440.png") });
    await firstRow.click();
    await expect(page.getByTestId("appointment-drawer")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "13-appointment-drawer-1440.png") });
    await page.keyboard.press("Escape");

    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "14-treatments-1440.png") });

    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "15-inbox-1440.png") });

    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    const firstCampaignLink = page.locator("table tbody tr td a").first();
    await expect(firstCampaignLink).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "17-campaigns-1440.png") });
    await firstCampaignLink.click();
    await expect(page.getByText("Back to Campaigns")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "18-campaign-detail-1440.png") });

    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "19-integrations-1440.png") });

    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "20-settings-1440.png") });

    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/my-work");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await expect(page.getByTestId("my-work-task-list")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "11-my-work-1440.png") });

    await login(page, "gyn.doctor@pulseos.local");
    await page.goto("/doctor-home");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await expect(page.getByText("Today's Patient Queue")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "10-doctor-home-1440.png") });
  });

  test("command centre responsive: 1280 / 1024", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    for (const vp of [
      { name: "1280", width: 1280, height: 800 },
      { name: "1024", width: 1024, height: 768 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/command-centre");
      await expect(page.getByTestId("command-centre")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `0${vp.name === "1280" ? "3" : "4"}-command-centre-${vp.name}.png`) });
    }
  });

  test("mobile/tablet critical set", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "cc-768.png") });

    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "inbox-768.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "cc-390.png") });

    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "inbox-390.png") });

    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "appointments-390.png") });

    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "campaigns-390.png") });

    const firstLink = page.locator("table tbody tr td a").first();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await page.getByText("Priya Sharma", { exact: true }).first().click();
    await expect(page).toHaveURL(/\/patients\/[^/]+$/);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(/\d+ events?$/)).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "patient360-390.png") });
    void firstLink;
  });
});
