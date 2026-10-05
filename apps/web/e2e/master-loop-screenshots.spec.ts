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

test.describe("Master visual reconstruction loop — required screenshot set", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("captures the 25-name required set (campaigns page not yet built, skipped)", async ({ page }) => {
    // 01 / 02 — Login desktop + mobile
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await shot(page, "01-login-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await shot(page, "02-login-mobile.png");

    // 03-06 — Admin at 1440 / 1280 / tablet / mobile
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await shot(page, "03-admin-1440.png");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await shot(page, "04-admin-1280.png");

    await page.setViewportSize({ width: 768, height: 1024 });
    await shot(page, "05-admin-tablet.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await shot(page, "06-admin-mobile.png");

    // 24 / 25 — Service Lines panel (replaced the Journey Health radial in the 2026-09-29 recomposition) + Journey Performance chart crops (admin, desktop)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.getByTestId("journey-funnel").screenshot({ path: path.join(ARTIFACTS_DIR, "25-journey-performance.png") });
    await page.getByRole("heading", { name: "Service Lines" }).locator("xpath=ancestor::section[1] | ancestor::div[contains(@class,'rounded')][1]").first().screenshot({ path: path.join(ARTIFACTS_DIR, "24-service-lines.png") });

    // 07 — Doctor Home
    await login(page, "gyn.doctor@pulseos.local");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await shot(page, "07-doctor-home.png");

    // 08 — Front Desk
    await login(page, "gyn.frontdesk@pulseos.local");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await shot(page, "08-front-desk.png");

    // 09 — My Work
    await login(page, "gyn.coordinator@pulseos.local");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await shot(page, "09-my-work.png");

    // 10 — Patients
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();
    await shot(page, "10-patients.png");

    // 11-14 — Patient 360 at 1440 / 1280 / tablet / mobile
    await page.goto("/patients?search=Priya");
    await page.getByText("Priya Sharma").first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    const patient360Url = page.url();
    await shot(page, "11-patient-360-1440.png");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(patient360Url);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await shot(page, "12-patient-360-1280.png");

    await page.setViewportSize({ width: 768, height: 1024 });
    await shot(page, "13-patient-360-tablet.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(patient360Url);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await shot(page, "14-patient-360-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });

    // 15 — Journeys
    await page.goto("/journeys");
    await expect(page.getByTestId("journeys-page")).toBeVisible();
    await shot(page, "15-journeys.png");

    // 16 — Appointments
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await shot(page, "16-appointments.png");

    // 17 — Appointment Drawer: captured by e2e/appointment-drawer-screenshot.spec.ts,
    // which opens a real appointment row via its stable [data-testid^="appointment-row-"]
    // selector. Not duplicated here to avoid clobbering that correct capture with a
    // less precise one.

    // 18 — Treatments
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await shot(page, "18-treatments.png");

    // 19-21 — Inbox desktop / tablet / mobile
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await shot(page, "19-inbox-desktop.png");

    await page.setViewportSize({ width: 768, height: 1024 });
    await shot(page, "20-inbox-tablet.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await shot(page, "21-inbox-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });

    // 22 — Integrations
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await shot(page, "22-integrations.png");

    // 23 — Campaigns / Sources: not built yet (sidebar shows it disabled). Documented gap, not captured.
  });
});
