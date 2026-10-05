import { test, expect, type Page } from "@playwright/test";

// Functional-hardening prompt §10/§27 — real global Patient search: debounced
// typeahead over /patients/search (never a full-directory fetch), 2-char
// trigger, keyboard nav, selecting a row opens Patient 360 directly.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Global patient search", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("debounces below 2 chars, shows a dropdown at 2+, and Enter opens Patient 360", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");

    const search = page.getByTestId("global-patient-search");
    await search.fill("p");
    await page.waitForTimeout(400);
    await expect(page.getByTestId("global-patient-search-results")).toBeHidden();

    await search.fill("pri");
    const results = page.getByTestId("global-patient-search-results");
    await expect(results).toBeVisible();
    await expect(results.getByText("Priya Sharma")).toBeVisible();

    await page.keyboard.press("ArrowDown");
    await expect(results.locator('[role="option"]').first()).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/patients\/[0-9a-f-]+/);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Priya Sharma" })).toBeVisible(); // (the breadcrumb names her too)

    // The box clears after a selection — no stale query left behind.
    await expect(page.getByTestId("global-patient-search")).toHaveValue("");
  });

  test("Escape closes the dropdown without navigating", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");

    const search = page.getByTestId("global-patient-search");
    await search.fill("pri");
    await expect(page.getByTestId("global-patient-search-results")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("global-patient-search-results")).toBeHidden();
    await expect(page).toHaveURL(/command-centre/);
  });
});
