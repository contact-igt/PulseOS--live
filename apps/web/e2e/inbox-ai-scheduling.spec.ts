import { test, expect, type Page } from "@playwright/test";

// Functional-hardening prompt §8/§9/§27 — per-conversation AI scheduling
// preference: configuration/scheduling state only (no agent runtime exists),
// reachable from the simplified ownership "More" menu, honestly labeled.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Inbox — AI scheduling preference (config only)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("one primary action + More menu, and Schedule AI saves a config-only preference", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();

    // Pick any non-closed conversation from the list.
    const row = page.locator('button:has-text("You\'re handling this"), button:has-text("Assigned"), button:has-text("Needs attention"), button:has-text("AI active")').first();
    await row.click();

    // Exactly one primary ownership button, plus the More menu — never a wall of buttons.
    const header = page.locator("section").filter({ has: page.getByTestId("conversation-more-actions") });
    await expect(header.getByTestId("open-patient-context")).toBeVisible();

    await page.getByTestId("conversation-more-actions").click();
    await expect(page.getByRole("menuitem", { name: "Schedule AI…" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Schedule AI…" }).click();

    const panel = page.getByTestId("ai-schedule-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("no live AI agent yet");

    await page.getByTestId("automation-mode-ai_scheduled").click();
    await expect(page.getByTestId("automation-start-input")).toBeVisible();

    // Save without a window — must show a validation error, not silently succeed.
    await page.getByTestId("save-automation").click();
    await expect(panel).toContainText("Choose a start and end time");

    const start = new Date(Date.now() + 3600_000);
    const end = new Date(Date.now() + 7200_000);
    const toLocal = (d: Date) => d.toISOString().slice(0, 16);
    await page.getByTestId("automation-start-input").fill(toLocal(start));
    await page.getByTestId("automation-end-input").fill(toLocal(end));
    await page.getByTestId("save-automation").click();

    await expect(panel).toBeHidden();
    await expect(page.getByTestId("automation-mode-indicator")).toHaveText("AI scheduled");

    // Revert so the seed conversation isn't left in a scheduled state for other specs.
    await page.getByTestId("conversation-more-actions").click();
    await page.getByRole("menuitem", { name: "Schedule AI…" }).click();
    await page.getByTestId("automation-mode-manual").click();
    await page.getByTestId("save-automation").click();
    await expect(page.getByTestId("automation-mode-indicator")).toBeHidden();
  });
});
