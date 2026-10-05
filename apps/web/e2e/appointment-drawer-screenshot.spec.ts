import { test } from "@playwright/test";
import path from "path";

const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts");
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

test("captures the Appointment Drawer open over the Appointments page", async ({ page }) => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  await page.goto("/login");
  await page.getByLabel("Email").fill("gyn.admin@pulseos.local");
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/command-centre/);

  await page.goto("/appointments");
  await page.getByTestId("appointments-tab-upcoming").click();
  await page.locator('[data-testid^="appointment-row-"]').first().click();
  await page.getByTestId("appointment-drawer").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, "17-appointment-drawer.png") });
});
