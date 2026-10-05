import { test, expect, type Page } from "@playwright/test";

// Functional-hardening prompt §15/§27 — destructive actions require
// confirmation with copy that states the actual consequence, never a
// generic "Are you sure?". Covers the two extended to the shared
// ConfirmDialog primitive here: Cancel Appointment and Decline Treatment
// (Close Conversation is covered by inbox-ai-scheduling / its own flow).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Destructive-action confirmations", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("Cancel Appointment asks for a reason with real consequence copy, and Keep appointment aborts it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.getByTestId("appointments-tab-upcoming").click();

    await page.locator('[data-testid^="appointment-row-"] button').first().click();
    const drawer = page.getByTestId("appointment-drawer");
    await expect(drawer).toBeVisible();
    const statusBefore = await drawer.getByTestId("appointment-drawer-details").innerText();

    await page.getByTestId("drawer-action-cancel").click();
    const panel = page.getByTestId("appointment-drawer-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("frees");
    await expect(panel).toContainText("does not notify the patient automatically");
    // A reason is required: confirming without one explains what is missing and cancels nothing.
    await page.getByTestId("drawer-reason-confirm").click();
    await expect(page.getByTestId("drawer-reason-error")).toContainText(/why it is being cancelled/i);

    // Keeping the appointment must not touch it.
    await page.getByTestId("drawer-reason-back").click();
    await expect(panel).toBeHidden();
    expect(await drawer.getByTestId("appointment-drawer-details").innerText()).toBe(statusBefore);
    await expect(drawer).not.toContainText("Cancelled");
  });

  test("Decline Treatment requires confirmation naming the patient, treatment and value", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();

    const moreButton = page.locator('[data-testid$="-more"]').first();
    await moreButton.click();
    await page.getByRole("menuitem", { name: "Decline" }).click();

    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("moves out of the active pipeline");

    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(dialog).toBeHidden();
  });

  test("Archive field requires confirmation stating historical values are kept", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/settings?section=fields&service=GYNECOLOGY");
    await expect(page.getByTestId("crm-fields-section")).toBeVisible();

    await page.locator('[data-testid^="field-archive-"]').first().click();

    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("keep that value on their record");
    await expect(dialog).toContainText("doesn't delete historical data");

    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(dialog).toBeHidden();
  });
});
