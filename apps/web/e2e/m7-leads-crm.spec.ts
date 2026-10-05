import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const run = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E M7 Leads ${n} ${run}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home|leads/);
}
async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ api, method, path, body }) => {
      const res = await fetch(`${api}${path}`, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { api: API, method, path, body },
  );
}

test.describe("M7 Leads refinements + CRM field behaviour", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD not set");
  test.describe.configure({ mode: "serial" });
  let fieldId = "";
  test.afterAll(async () => {
    purgePatients("E2E M7 Leads");
    // The field this spec made (shared "*" scope) and nothing else: its values went with the purged journeys.
    sql(`DELETE FROM custom_field_values WHERE field_definition_id IN (SELECT id FROM custom_field_definitions WHERE key LIKE 'm7_smoker_%'); DELETE FROM custom_field_definitions WHERE key LIKE 'm7_smoker_%'`);
  });

  test("seed: a filterable CRM field and three leads", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    const lookups = (await api<{ branches: { id: string }[] }>(page, "GET", "/lookups")).body;
    const field = await api<{ id: string }>(page, "POST", "/crm/fields", { specialtyKey: "*", key: `m7_smoker_${run}`, label: `Smoker ${run}`, fieldType: "SELECT", options: ["Yes", "No"], placements: ["add_lead"], filterable: true });
    expect(field.status).toBe(201);
    fieldId = field.body.id;
    for (const [n, v] of [["Asha", "Yes"], ["Vikram", "No"], ["Meera", "Yes"]] as const) {
      const r = await api(page, "POST", "/leads", { name: NAME(n), phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0]!.id, journeyType: "Cataract", sourceKey: "google", customFieldValues: { [`m7_smoker_${run}`]: v } });
      expect(r.status).toBe(201);
    }
  });

  test("desktop: search by name, filter by a CRM field, choose columns (saved), page through results", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/leads?range=30d");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    await page.getByTestId("leads-search").fill(`E2E M7 Leads Asha ${run}`);
    await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(1);
    await expect(page.getByTestId("leads-result-count")).toContainText("of 1");
    await page.getByTestId("leads-search").fill("");
    // The filterable field is offered; picking an answer narrows the list to those journeys.
    await page.getByTestId("leads-search").fill(`E2E M7 Leads`);
    await page.getByTestId("leads-field").selectOption(`m7_smoker_${run}`);
    await page.getByTestId("leads-field-value").selectOption("Yes");
    await expect(page).toHaveURL(/field=m7_smoker/);
    await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(2);
    await expect(page.getByTestId("leads-chips")).toContainText("Yes");
    // Columns: hide Owner and Last interaction; the choice survives a reload (a view preference only).
    await page.getByTestId("leads-columns-button").click();
    await page.getByTestId("leads-column-owner").uncheck();
    await page.getByTestId("leads-column-lastInteraction").uncheck();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader", { name: "Team Member", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("columnheader", { name: "Team Member", exact: true })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Journey status", exact: true })).toBeVisible();
    // The CRM field itself is unchanged by a view choice.
    expect((await api<{ filterable: boolean }[]>(page, "GET", "/crm/fields?specialtyKey=*")).body.find((f) => (f as unknown as { id: string }).id === fieldId)?.filterable).toBe(true);
    await page.getByTestId("leads-columns-button").click();
    await page.getByText("Show all columns").click();
    // Paging: rows per page and the visible range.
    await page.getByTestId("leads-reset").click();
    await page.getByTestId("leads-page-size").selectOption("25");
    await expect(page).toHaveURL(/size=25/);
    await expect(page.getByTestId("leads-result-count")).toContainText("Showing 1–");
  });

  test("row: Call link plus an overflow menu (no button wall); the row still opens the Journey", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/leads?range=30d");
    await page.getByTestId("leads-search").fill(`E2E M7 Leads Vikram ${run}`);
    const row = page.locator('[data-testid^="lead-row-"]').first();
    await expect(row.locator('a[href^="tel:"]')).toHaveCount(1);
    await row.locator('[data-testid^="lead-menu-"]').click().catch(async () => { await row.getByRole("button", { name: /more|actions/i }).click(); });
    await expect(page.getByRole("menuitem", { name: "Add follow-up" }).or(page.getByText("Add follow-up"))).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("phone: compact cards with Call and Open; filters live in a sheet; no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/leads?range=30d");
    await expect(page.getByTestId("lead-cards")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const card = page.locator('[data-testid^="lead-card-"]').first();
    await expect(card.getByText("Call")).toBeVisible();
    expect((await card.locator('a[href^="tel:"]').boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await page.getByTestId("leads-filters-open").click();
    const sheet = page.getByTestId("leads-filters-sheet");
    await expect(sheet.getByTestId("leads-source")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await card.getByText("Open", { exact: true }).click();
    await page.waitForURL(/\/journeys\//);
  });

  test("Settings → Activity lists who changed which CRM field, with no values", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=activity");
    await expect(page.getByTestId("activity-section")).toBeVisible();
    await expect(page.getByTestId("activity-row").first()).toBeVisible();
    await expect(page.getByTestId("activity-section")).toContainText("Added a CRM field");
    await login(page, "eyev1.frontdesk@pulseos.local");
    await page.goto("/settings");
    await expect(page.getByTestId("settings-tab-activity")).toHaveCount(0);
  });

  test("CRM field editor: behaviour switches, a rule, and a live preview", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=fields");
    await page.getByRole("button", { name: /add field/i }).first().click();
    const sheet = page.getByTestId("field-editor");
    await expect(sheet.getByTestId("field-behaviour")).toBeVisible();
    await expect(sheet.getByTestId("field-readonly")).not.toBeChecked();
    await sheet.getByTestId("field-label").fill(`Preview ${run}`);
    await sheet.getByTestId("field-type").selectOption("TEXT");
    await expect(sheet.getByTestId("field-filterable")).toBeDisabled(); // free text has nothing to pick from
    await sheet.getByTestId("field-add-rule").click();
    await expect(sheet.getByTestId("field-rule-0")).toBeVisible();
    await sheet.getByTestId("field-preview").getByLabel("Preview outcome").selectOption({ index: 0 });
    await expect(sheet.getByTestId("field-preview-hidden")).toBeVisible(); // the rule shows it only for chosen outcomes
    await page.keyboard.press("Escape");
  });
});
