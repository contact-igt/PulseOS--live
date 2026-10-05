import { test, expect, type Page } from "@playwright/test";
import path from "path";

// Screenshot package for the UI/UX reconstruction pass (2026-09-16) — the
// exact required set from the "ENTERPRISE UI/UX RECONSTRUCTION MASTER LOOP"
// prompt §56. Supersedes apps/web/e2e/master-loop-screenshots.spec.ts (an
// earlier, now-stale pass predating Campaigns/Campaign Detail existing).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts/brain-review");

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: true });
}

test.describe("Brain review screenshot package", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("captures the required desktop + mobile set", async ({ page }) => {
    // 01 — Login (desktop)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await shot(page, "01-login.png");

    // 02 — Command Centre (Hospital Admin)
    await login(page, "gyn.admin@pulseos.local");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await shot(page, "02-command-centre.png");

    // 03 — Leads
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await shot(page, "03-leads.png");

    // 04 — Add Lead drawer
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("add-lead-drawer").waitFor({ state: "visible" });
    await shot(page, "04-add-lead.png");
    await page.getByTestId("add-lead-drawer-close").click();

    // 05 — Patients
    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await shot(page, "05-patients.png");

    // 06 — Patient 360
    await page.locator("table tbody tr").first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    const patient360Url = page.url();
    await shot(page, "06-patient360.png");

    // 07 — Journeys
    await page.goto("/journeys");
    await expect(page.getByTestId("journeys-page")).toBeVisible();
    await shot(page, "07-journeys.png");

    // 08 — Doctor Home
    await login(page, "gyn.doctor@pulseos.local");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await shot(page, "08-doctor.png");

    // 09 — Front Desk
    await login(page, "gyn.frontdesk@pulseos.local");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await shot(page, "09-front-desk.png");

    // 10 — My Work
    await login(page, "gyn.coordinator@pulseos.local");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await shot(page, "10-my-work.png");

    // Back to admin for the rest of the desktop set.
    await login(page, "gyn.admin@pulseos.local");

    // 11 — Appointments
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await shot(page, "11-appointments.png");

    // 12 — Appointment Drawer
    await page.getByTestId("appointments-tab-upcoming").click();
    await page.locator('[data-testid^="appointment-row-"]').first().click();
    await page.getByTestId("appointment-drawer").waitFor({ state: "visible" });
    await shot(page, "12-appointment-drawer.png");

    // 13 — Treatments
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await shot(page, "13-treatments.png");

    // 14/15/16 — Inbox at 1440 / 1280 / 1024
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await shot(page, "14-inbox-1440.png");

    await page.setViewportSize({ width: 1280, height: 800 });
    await shot(page, "15-inbox-1280.png");

    await page.setViewportSize({ width: 1024, height: 768 });
    await shot(page, "16-inbox-1024.png");

    await page.setViewportSize({ width: 1440, height: 900 });

    // 17 — Campaigns
    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await shot(page, "17-campaigns.png");

    // 18 — Campaign Detail
    await page.locator('[data-testid^="campaign-row-"] a').first().click();
    await expect(page.getByTestId("campaign-detail-page")).toBeVisible();
    await shot(page, "18-campaign-detail.png");

    // 19 — Integrations
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await shot(page, "19-integrations.png");

    // 20 — Settings
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await shot(page, "20-settings.png");

    // --- Mobile (390x844) ---
    await page.setViewportSize({ width: 390, height: 844 });

    // 21 — Leads (mobile)
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await shot(page, "21-leads-390.png");

    // 22 — Add Lead (mobile)
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("add-lead-drawer").waitFor({ state: "visible" });
    await shot(page, "22-add-lead-390.png");
    await page.getByTestId("add-lead-drawer-close").click();

    // 23 — Patient 360 (mobile)
    await page.goto(patient360Url);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await shot(page, "23-patient360-390.png");

    // 24 — Appointments (mobile)
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await shot(page, "24-appointments-390.png");

    // 25 — Inbox (mobile)
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await shot(page, "25-inbox-390.png");

    // 26 — Campaigns (mobile)
    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await shot(page, "26-campaigns-390.png");
  });
});
