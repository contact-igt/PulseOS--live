import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";

// The Appointments history tabs (No-shows, Completed) cover a chosen period, not every appointment ever; Upcoming is
// bounded by the server from the hospital's today. Today/Day/Week/Month keep their calendar navigation untouched.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|doctor-home|front-desk|appointments/);
}

const panel = (page: Page) => page.getByTestId("appointments-view-list");

test.describe("Appointments list periods", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/appointments");
  });

  test("Today has no period control", async ({ page }) => {
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId("appointments-period-range")).toHaveCount(0);
  });

  test("No-shows defaults to the last 30 days and asks the API for exactly that window", async ({ page }) => {
    await page.getByTestId("appointments-tab-no_show").click();
    await expectPeriod(page, "appointments-period", "30d");
    const from = await panel(page).getAttribute("data-from");
    const to = await panel(page).getAttribute("data-to");
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(30);
  });

  test("a chosen period is kept in the URL, narrows the query and survives a refresh", async ({ page }) => {
    await page.getByTestId("appointments-tab-completed").click();
    await pickPeriod(page, "appointments-period", "7d");
    await expect(page).toHaveURL(/prange=7d/);
    const from = await panel(page).getAttribute("data-from");
    const to = await panel(page).getAttribute("data-to");
    expect((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1).toBe(7);
    await page.reload();
    await expectPeriod(page, "appointments-period", "7d");
  });

  test("the 90-day preset is not offered (the API serves at most 62 days)", async ({ page }) => {
    await page.getByTestId("appointments-tab-no_show").click();
    const options = await periodOptionLabels(page, "appointments-period");
    expect(options.join("|")).not.toContain("90");
  });

  test("Upcoming asks for today onward, one API window ahead", async ({ page }) => {
    await page.getByTestId("appointments-tab-upcoming").click();
    const from = await panel(page).getAttribute("data-from");
    const to = await panel(page).getAttribute("data-to");
    expect((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1).toBe(62);
  });
});
