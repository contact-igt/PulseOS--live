import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";

// The Command Centre period (shared Analytics presets, hospital timezone) is part of the URL together with branch
// and service, drives the period widgets, and survives refresh / back / forward.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|doctor-home/);
}

const caption = (page: Page) => page.getByTestId("cc-period-caption");
const spend = async (page: Page) => (await page.getByTestId("exec-marketingSpend").innerText()).replace(/\s+/g, " ");

test.describe("Command Centre period", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await expect(page.getByTestId("command-centre")).toBeVisible();
  });

  test("defaults to the last 30 days and names the dates it covers", async ({ page }) => {
    await expect(caption(page)).toContainText("Last 30 days");
    await expect(page).not.toHaveURL(/range=/);
  });

  test("a preset changes the period widgets, is kept in the URL and survives a refresh", async ({ page }) => {
    const before = await spend(page);
    await pickPeriod(page, "cc", "7d");
    await expect(page).toHaveURL(/range=7d/);
    await expect(caption(page)).toContainText("Last 7 days");
    await expect(page.getByText("Last 7 days — which sources brought patients in each day?")).toBeVisible();
    await expect.poll(() => spend(page)).not.toBe(before); // spend is prorated over the shorter period

    await page.reload();
    await expect(caption(page)).toContainText("Last 7 days");
    await expectPeriod(page, "cc", "7d");
  });

  test("a custom range takes from/to dates and is reflected in the caption", async ({ page }) => {
    await pickPeriod(page, "cc", "custom");
    await expect(page.getByTestId("cc-custom-dates")).toBeVisible();
    await expect(page).toHaveURL(/range=custom&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    await expect(caption(page)).toContainText("Custom range");
  });

  test("branch and service stay in the URL beside the period and survive back/forward", async ({ page }) => {
    await pickPeriod(page, "cc", "9d");
    const service = page.getByTestId("filter-service");
    const options = await service.locator("option").allTextContents();
    const pick = options.find((o) => o && !/^All /.test(o));
    test.skip(!pick, "tenant has a single service");
    await service.selectOption({ label: pick! });
    await expect(page).toHaveURL(/range=9d/);
    await expect(page).toHaveURL(/service=/);
    await page.goBack();
    await page.goForward();
    await expect(page).toHaveURL(/range=9d/);
    await expect(page).toHaveURL(/service=/);
    await page.reload();
    await expect(service).toHaveValue(pick!);
    await expect(caption(page)).toContainText("Last 9 days");
  });
});
