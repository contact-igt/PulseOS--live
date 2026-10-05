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

test.describe("Final review screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("captures the required desktop + tablet screenshots", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "00-login-desktop.png"), fullPage: true });

    await login(page, "gyn.admin@pulseos.local");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "01-admin-command-centre.png"), fullPage: true });

    await page.goto("/patients?search=Priya");
    await page.getByText("Priya Sharma").first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    const patient360Url = page.url();

    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "05-patients.png"), fullPage: true });

    await page.goto(patient360Url);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "06-patient-360.png"), fullPage: true });

    await page.goto("/journeys");
    await expect(page.getByTestId("journeys-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "07-journeys.png"), fullPage: true });

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "11-admin-command-centre-tablet.png"), fullPage: true });

    await page.goto(patient360Url);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "12-patient-360-tablet.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await login(page, "gyn.frontdesk@pulseos.local");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "02-front-desk.png"), fullPage: true });

    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "08-appointments.png"), fullPage: true });

    await login(page, "gyn.coordinator@pulseos.local");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "03-coordinator-my-work.png"), fullPage: true });

    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "09-treatments.png"), fullPage: true });

    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "10-inbox.png"), fullPage: true });

    await login(page, "gyn.doctor@pulseos.local");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "04-doctor-home.png"), fullPage: true });

    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "13-integrations.png"), fullPage: true });

    // 1280 desktop: Admin must retain the primary 8/4 analytics row, not collapse early.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    // Both analytics cards must be visible in the same viewport without vertical stacking.
    await expect(page.getByText("Patient Journey Performance")).toBeVisible();
    // (2026-09-29 recomposition replaced the Journey Health radial with the Service Lines panel.)
    await expect(page.getByRole("heading", { name: "Service Lines" })).toBeVisible();
    const overflowX1280 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX1280).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "14-admin-command-centre-1280.png"), fullPage: true });

    // 1024 desktop breakpoint.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "15-admin-command-centre-1024.png"), fullPage: true });

    // Mobile 390x844.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "16-admin-command-centre-mobile.png"), fullPage: true });

    await page.goto(patient360Url);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "17-patient-360-mobile.png"), fullPage: true });
  });
});
