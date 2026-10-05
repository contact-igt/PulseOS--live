import { test, expect, type Page } from "@playwright/test";
import { purgeCrmFields, purgePatients } from "./support/fixtures";

// Settings → CRM Fields, end to end: an admin adds a required single-choice field, Add Lead enforces it,
// the value shows on the Journey under its section, archiving hides it from new entry but keeps the
// history, and restoring brings it back. Fictional fixtures only, removed afterwards.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const RUN = Date.now().toString().slice(-8);
const LABEL = `E2E Budget ${RUN}`;
const KEY = `e2e_budget_${RUN}`;
const PATIENT = `E2E CRM Field Patient ${RUN}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function openAddLeadFor(page: Page, phone: string) {
  await page.goto("/leads");
  await page.getByTestId("add-lead-button").click();
  await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
  await page.getByTestId("lead-phone-input").fill(phone);
  await page.locator("#lead-name").fill(PATIENT);
  await page.getByTestId("lead-specialty-select").selectOption("CATARACT");
  const branch = page.locator("#lead-branch");
  await branch.selectOption((await branch.locator("option").nth(1).getAttribute("value"))!);
  await page.locator("#lead-source").selectOption("walk_in");
}

test.describe("CRM fields (Settings → CRM Fields → Add Lead → Journey)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => {
    purgePatients("E2E CRM Field Patient");
    purgeCrmFields("e2e_budget_");
  });

  test("an admin adds a required choice field; Add Lead enforces it; the Journey shows the value in its section", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.admin@pulseos.local");

    await page.goto("/settings?section=fields&service=CATARACT");
    await expect(page.getByTestId("crm-fields-section")).toBeVisible();
    await page.getByTestId("crm-fields-add").click();
    const sheet = page.getByTestId("field-editor");
    await expect(sheet).toBeVisible();

    // A bad save keeps what was typed and says why; the key is generated, never typed.
    await page.getByTestId("field-save").click();
    await expect(page.getByTestId("field-editor-error")).toContainText("label");
    await page.getByTestId("field-label").fill(LABEL);
    await page.getByTestId("field-type").selectOption("SELECT");
    await page.getByTestId("field-save").click();
    await expect(page.getByTestId("field-editor-error")).toContainText("option");
    await page.getByTestId("field-add-option").click();
    await page.getByTestId("field-add-option").click();
    await page.getByTestId("field-option-0").fill("Under 50k");
    await page.getByTestId("field-option-1").fill("Above 50k");
    await page.getByTestId("field-required").check();
    await page.getByTestId("field-group").selectOption("qualification");
    await page.getByTestId("field-save").click();
    await expect(sheet).toBeHidden();

    const row = page.getByTestId(`field-row-${KEY}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Required");
    await expect(row).toContainText("Single choice");
    await expect(page.getByTestId("field-group-qualification")).toBeVisible();

    // Add Lead shows it, marked required, and refuses to submit without it.
    const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    await openAddLeadFor(page, phone);
    const field = page.getByTestId("lead-custom-field-inputs");
    await expect(field.getByText(LABEL)).toBeVisible();
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible(); // the browser's required check keeps it open
    await field.getByLabel(new RegExp(LABEL)).selectOption("Above 50k");
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();

    // The value shows on the Journey under its section, and survives a refresh.
    await page.getByText(PATIENT).first().click();
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("journey-custom-fields")).toContainText("Above 50k");
    await page.reload();
    await expect(page.getByTestId("journey-custom-fields")).toContainText(LABEL);
  });

  test("archiving hides the field from new entry but keeps history; restoring brings it back", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/settings?section=fields&service=CATARACT");
    await page.getByTestId(`field-archive-${KEY}`).click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toContainText("keep that value on their record");
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByTestId(`field-row-${KEY}`)).toBeHidden();

    // Not offered to new entries...
    await openAddLeadFor(page, `9${Math.floor(100000000 + Math.random() * 899999999)}`);
    await page.getByTestId("lead-additional-toggle").click();
    await expect(page.getByTestId("lead-custom-fields")).toBeVisible();
    await expect(page.getByTestId("lead-custom-field-inputs").getByText(LABEL)).toHaveCount(0);
    await page.getByTestId("add-lead-drawer-close").click();

    // ...but the earlier Journey still shows its value.
    await page.goto("/leads");
    await page.getByText(PATIENT).first().click();
    await expect(page.getByTestId("journey-custom-fields")).toContainText("Above 50k");

    // Restore from the archived list.
    await page.goto("/settings?section=fields&service=CATARACT");
    await page.getByTestId("crm-fields-show-archived").check();
    await expect(page.getByTestId(`field-row-${KEY}`)).toContainText("Archived");
    await page.getByTestId(`field-restore-${KEY}`).click();
    await expect(page.getByTestId(`field-row-${KEY}`)).not.toContainText("Archived");
  });

  test("on a phone the editor is a full-width sheet, options stay editable, and nothing overflows", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/settings?section=fields&service=CATARACT");
    await expect(page.getByTestId("crm-fields-section")).toBeVisible();
    await page.getByTestId(`field-edit-${KEY}`).click();
    const sheet = page.getByTestId("field-editor");
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(385);
    await page.getByTestId("field-option-0").fill("Under 40k");
    await expect(page.getByTestId("field-option-0")).toHaveValue("Under 40k");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});
