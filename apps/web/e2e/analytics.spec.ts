import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";

// Analytics workspace: one filter state (the URL) drives every panel, and the
// chart totals reconcile with the table and the API. Run twice without
// reseeding — nothing here mutates data.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
// Optional: send the web app's API traffic elsewhere (e.g. a second API on another database) without touching the running dev servers.
const API_REDIRECT = process.env.API_REDIRECT;

type RoleKey = "HOSPITAL_ADMIN" | "FRONT_DESK";

async function devLogin(page: Page, role: RoleKey, home: RegExp) {
  if (API_REDIRECT) {
    await page.context().route(`${API}/**`, (route) => route.continue({ url: route.request().url().replace(API, API_REDIRECT) }));
  }
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(home);
}

const num = (text: string | null) => Number((text ?? "").replace(/[^0-9]/g, ""));

async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    async ([base, p]) => {
      const res = await fetch(`${base}${p}`, { credentials: "include" });
      return res.json();
    },
    [API, path] as const,
  ) as Promise<T>;
}

/** Sum of the per-source totals printed in the daily chart's legend. */
async function legendTotal(page: Page) {
  const values = await page.locator('[data-testid="daily-source-chart"] ul[aria-label="Legend"] li').evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  return values.reduce((sum, text) => sum + Number((text.match(/(\d[\d,]*)$/) ?? [])[1]?.replace(/,/g, "") ?? 0), 0);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main");
    return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(overflow.doc, "document scrolls horizontally").toBeLessThanOrEqual(1);
  expect(overflow.main, "main scrolls horizontally").toBeLessThanOrEqual(1);
}

test.describe("Analytics workspace", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("admin sees Analytics in the sidebar and the page loads every Overview panel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN", /\/command-centre/);
    await page.locator('nav a[href="/analytics"]').first().click();
    await page.waitForURL(/\/analytics/);
    // Operations is the default area; Marketing & revenue (growth edition) sits beside it.
    await expect(page.getByTestId("operations-analytics")).toBeVisible();
    await page.getByTestId("analytics-area-marketing").click();
    await expect(page).toHaveURL(/section=marketing/);
    for (const id of ["analytics-kpis", "panel-daily-source", "panel-source-mix", "panel-funnel", "panel-revenue", "panel-campaigns"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId("daily-source-chart").locator("svg.recharts-surface").first()).toBeVisible();
    await expect(page.getByTestId("analytics-period")).toContainText("Asia/Kolkata");
  });

  test("filters live in the URL, drive every panel, and chart totals equal the KPI and the API", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN", /\/command-centre/);
    await page.goto("/analytics?section=marketing&range=90d");
    await expect(page.getByTestId("kpi-leads")).toBeVisible();

    // Unfiltered: KPI == chart legend == source-mix centre == funnel top == API.
    const totalLeads = num(await page.getByTestId("kpi-leads").textContent());
    expect(totalLeads).toBeGreaterThan(0);
    await expect.poll(() => legendTotal(page)).toBe(totalLeads);
    await expect(page.getByTestId("funnel-enquiry")).toContainText(String(totalLeads));
    await expect(page.getByTestId("source-mix")).toContainText(String(totalLeads));
    const api = await apiJson<{ total: number }>(page, "/analytics/leads?range=90d");
    expect(api.total).toBe(totalLeads);
    const campaignRowsBefore = await page.locator('[data-testid^="campaign-row-"]').count();

    // Change the source through the shared filter bar.
    await page.getByTestId("filter-source").selectOption("meta");
    await expect(page).toHaveURL(/source=meta/);
    await expect(page).toHaveURL(/range=90d/);
    await expect(page.getByTestId("active-filters")).toContainText("Source: Meta");

    await expect.poll(async () => num(await page.getByTestId("kpi-leads").textContent())).toBeLessThan(totalLeads);
    const metaLeads = num(await page.getByTestId("kpi-leads").textContent());
    expect(metaLeads).toBeGreaterThan(0);
    await expect.poll(() => legendTotal(page)).toBe(metaLeads);
    await expect(page.getByTestId("daily-source-chart").locator('ul[aria-label="Legend"] li')).toHaveCount(1);
    await expect(page.getByTestId("funnel-enquiry")).toContainText(String(metaLeads));
    await expect(page.getByTestId("source-mix")).toContainText(String(metaLeads));
    await expect.poll(() => page.locator('[data-testid^="campaign-row-"]').count()).toBeLessThan(campaignRowsBefore + 1);
    const apiMeta = await apiJson<{ total: number }>(page, "/analytics/leads?range=90d&source=meta");
    expect(apiMeta.total).toBe(metaLeads);

    // Back restores the unfiltered state everywhere.
    await page.goBack();
    await expect(page).not.toHaveURL(/source=meta/);
    await expect.poll(async () => num(await page.getByTestId("kpi-leads").textContent())).toBe(totalLeads);

    // Clicking a mark sets the same filter as the select; Reset clears it.
    await page.getByTestId("mix-google").click();
    await expect(page).toHaveURL(/source=google/);
    await page.getByTestId("filters-reset").click();
    await expect(page).not.toHaveURL(/source=/);
    await expect(page).not.toHaveURL(/range=/);
    await expect(page.getByTestId("filters-reset")).toHaveCount(0);
  });

  test("a shared link restores range, filters and tab; a bad link falls back safely", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN", /\/command-centre/);
    await page.goto("/analytics?section=marketing&tab=revenue&range=14d&service=Cataract");
    await expect(page.getByTestId("panel-revenue")).toBeVisible();
    await expectPeriod(page, "analytics", "14d"); // an older shared link still works
    await expect(page.getByTestId("filter-service")).toHaveValue("Cataract");
    await page.goto("/analytics?section=marketing&tab=bogus&range=5y&source=telepathy");
    await expect(page.getByTestId("panel-daily-source")).toBeVisible();
    await expectPeriod(page, "analytics", "30d");
  });

  test("every tab renders its panels and campaign rows link to the campaign", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN", /\/command-centre/);
    await page.goto("/analytics?section=marketing&tab=acquisition");
    for (const id of ["panel-lead-trend", "panel-source-conversion", "panel-campaigns"]) await expect(page.getByTestId(id)).toBeVisible();
    await page.getByTestId("conv-toTreatment").click();
    await expect(page.getByTestId("source-conversion")).toContainText("were advised treatment");
    const firstCampaign = page.locator('[data-testid^="campaign-row-"] a').first();
    await expect(firstCampaign).toHaveAttribute("href", /\/campaigns\/[0-9a-f-]{36}/);

    await page.getByTestId("analytics-tab-journey").click();
    await expect(page).toHaveURL(/tab=journey/);
    await expect(page.getByTestId("panel-flow")).toBeVisible();
    await expect(page.getByTestId("journey-outcomes")).toBeVisible();
    await expect(page.getByTestId("service-lines-table")).toBeVisible();
    await page.locator('[data-testid^="service-row-"]').first().click();
    await expect(page).toHaveURL(/service=/);

    await page.getByTestId("analytics-tab-revenue").click();
    for (const id of ["panel-revenue", "panel-roas", "panel-revenue-service", "panel-payments"]) await expect(page.getByTestId(id)).toBeVisible();

    await page.getByTestId("analytics-tab-team").click();
    await expect(page.getByTestId("team-analytics")).toBeVisible();
  });

  test("Command Centre shows one compact daily-source panel and links to Analytics", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN", /\/command-centre/);
    await expect(page.getByTestId("cc-daily-source")).toBeVisible();
    await expect(page.getByTestId("cc-daily-source").locator("svg.recharts-surface").first()).toBeVisible();
    await page.getByTestId("view-analytics-link").click();
    await page.waitForURL(/\/analytics/);
  });

  test("mobile: no horizontal overflow on any tab, and the Filters sheet traps focus and returns it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page, "HOSPITAL_ADMIN", /\/command-centre/);
    for (const tab of ["overview", "acquisition", "journey", "revenue", "team"]) {
      await page.goto(`/analytics?section=marketing&tab=${tab}`);
      await expect(page.getByTestId("analytics-page")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noHorizontalOverflow(page);
    }

    await page.goto("/analytics?section=marketing");
    await expect(page.getByTestId("filter-selects-desktop")).toBeHidden();
    const opener = page.getByTestId("filters-open");
    await opener.click();
    const sheet = page.getByTestId("filters-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("select").first()).toBeVisible();
    // Focus starts inside the sheet and stays there on Tab.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await sheet.getByLabel("Source").selectOption("google");
    await expect(page).toHaveURL(/source=google/);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(opener).toContainText("1");
    await noHorizontalOverflow(page);
  });

  test("front desk has no Analytics entry and is routed home", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "FRONT_DESK", /\/front-desk/);
    await expect(page.locator('nav a[href="/analytics"]')).toHaveCount(0);
    await page.goto("/analytics");
    await page.waitForURL(/\/front-desk/);
  });
});
