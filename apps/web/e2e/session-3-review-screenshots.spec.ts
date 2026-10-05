import { test, expect, type Page } from "@playwright/test";
import path from "path";

// Screenshot package for this session's own work (functional-hardening
// prompt §23-26/§30): My Work tab counts, Inbox's simplified ownership
// controls + More menu + AI scheduling panel, global search dropdown, and
// a destructive-action confirmation — extends review-artifacts/brain-review.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts/brain-review");

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Session 3 review screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("captures My Work counts, Inbox states, global search, and a confirmation dialog", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // My Work — compact quiet tab count badges.
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/my-work");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await expect(page.getByTestId("my-work-tab-count-mine")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "27-my-work-counts.png") });

    // Inbox — simplified ownership header (one primary action + More menu).
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "28-inbox-simplified-ownership.png") });

    // Inbox — More menu open, showing Assign/Schedule AI/Close.
    const moreButton = page.getByTestId("conversation-more-actions");
    if (await moreButton.isVisible()) {
      await moreButton.click();
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, "29-inbox-more-menu.png") });
      await page.keyboard.press("Escape");
    }

    // Inbox — AI scheduling panel, config-only, honestly labeled.
    const scheduleItem = page.getByRole("menuitem", { name: "Schedule AI…" });
    await moreButton.click();
    if (await scheduleItem.isVisible()) {
      await scheduleItem.click();
      await expect(page.getByTestId("ai-schedule-panel")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, "30-inbox-ai-schedule-panel.png") });
      await page.getByRole("button", { name: "Cancel" }).first().click();
    }

    // Global patient search — debounced dropdown with a live result.
    await page.goto("/command-centre");
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.getByTestId("global-patient-search").fill("pri");
    await expect(page.getByTestId("global-patient-search-results")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "31-global-search-dropdown.png") });
    await page.keyboard.press("Escape");

    // Confirmation dialog — Decline Treatment, consequence-specific copy.
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    const treatmentMore = page.locator('[data-testid$="-more"]').first();
    await treatmentMore.click();
    await page.getByRole("menuitem", { name: "Decline" }).click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
    await page.waitForTimeout(150); // let the dialog's entrance settle before capturing
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "32-confirm-dialog.png") });
    await page.getByTestId("confirm-dialog-cancel").click();
  });
});
