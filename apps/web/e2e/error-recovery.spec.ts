import { test, expect, type Page } from "@playwright/test";

// Functional-hardening prompt §16/§27 — forms/drawers must preserve entered
// data on API failure, show an inline error, and allow retry — never
// silently close or discard what the user typed.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Error recovery on API failure", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("Settings specialty editor: a failed save shows an inline error and keeps the typed value", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).first().click();

    await page.route("**/specialties/GYNECOLOGY", (route) => {
      if (route.request().method() === "PATCH") return route.abort("failed");
      return route.continue();
    });

    const input = page.getByTestId("specialty-display-label");
    await input.fill("Gynecology Edited");
    await input.blur();

    await expect(page.getByTestId("specialty-save-error")).toBeVisible();
    await expect(input).toHaveValue("Gynecology Edited");
  });

  test("Add Lead drawer: a failed submit shows an inline error, keeps the form open, and preserves entered fields", async ({ page }) => {
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();

    await page.getByTestId("add-lead-button").click();
    const drawer = page.getByTestId("add-lead-drawer");
    await expect(drawer).toBeVisible();

    await page.route("**/leads", (route) => {
      if (route.request().method() === "POST") return route.abort("failed");
      return route.continue();
    });

    await page.locator("#lead-phone").fill("9999900001");
    await page.locator("#lead-name").fill("Error Recovery Test Patient");
    await page.getByTestId("lead-specialty-select").selectOption({ index: 1 });
    await page.locator("#lead-branch").selectOption({ index: 1 });
    await page.getByTestId("add-lead-submit").click();

    // Never silently closes on failure — drawer stays open with the error and the typed data.
    await expect(drawer).toBeVisible();
    await expect(page.getByText(/could not/i)).toBeVisible();
    await expect(page.locator("#lead-name")).toHaveValue("Error Recovery Test Patient");
    await expect(page.locator("#lead-phone")).toHaveValue("9999900001");
  });
});
