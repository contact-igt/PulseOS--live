import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";
import { sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const V1_TENANT = `(SELECT id FROM tenants WHERE name = 'PulseOS Ophthalmology V1 Demo')`;

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

/** Put the V1 demo hospital back exactly as it was seeded: no overrides, no ads connectors, no ads data. */
function resetDemo() {
  sql(`
    DELETE FROM ads_daily_facts WHERE tenant_id = ${V1_TENANT};
    DELETE FROM ads_sync_runs WHERE tenant_id = ${V1_TENANT};
    DELETE FROM connector_secrets WHERE connector_id IN (SELECT id FROM connectors WHERE tenant_id = ${V1_TENANT} AND provider IN ('google_ads','meta_ads'));
    DELETE FROM connector_events WHERE connector_id IN (SELECT id FROM connectors WHERE tenant_id = ${V1_TENANT} AND provider IN ('google_ads','meta_ads'));
    DELETE FROM connectors WHERE tenant_id = ${V1_TENANT} AND provider IN ('google_ads','meta_ads');
    DELETE FROM tenant_capabilities WHERE tenant_id = ${V1_TENANT};
  `);
}

test.describe("M7 Google + Meta Ads reporting and shared date presets (fixtures only)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD not set");
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDemo);
  test.afterAll(resetDemo);

  test("V1 default: marketing analytics is not offered; Super Admin override turns it on", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    expect((await api(page, "GET", "/analytics/ads")).status).toBe(403);
    await page.goto("/analytics?section=marketing");
    await expect(page.getByTestId("marketing-analytics")).toHaveCount(0);
    for (const k of ["MARKETING_ANALYTICS", "GOOGLE_ADS", "META_ADS"]) expect((await api(page, "PUT", `/capabilities/${k}`, { enabled: true })).status).toBe(200);
    await page.goto("/analytics?section=marketing&tab=ads");
    await expect(page.getByTestId("ads-tab")).toBeVisible();
    // Switched on but nothing configured/synced: a setup state, not zeros.
    await expect(page.getByTestId("ads-unavailable-NO_DATA_YET")).toBeVisible();
    await expect(page.getByTestId("ads-provider-google_ads")).toContainText("Not configured");
  });

  test("G. Google Ads: configure → Sync now → numbers appear with Last synced; platform conversions stay separate and unlinked campaigns show no costs", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    await page.goto("/integrations?open=google_ads");
    const sheet = page.getByTestId("integration-detail");
    await sheet.getByTestId("detail-tab-configuration").click();
    await sheet.getByTestId("config-customerId").fill("123-456-7890");
    await sheet.getByTestId("save-configuration").click();
    await expect(sheet.getByText("Saved.")).toBeVisible();
    await sheet.getByTestId("detail-tab-sync").click();
    await expect(sheet.getByTestId("ads-sync-now")).toBeEnabled();
    await sheet.getByTestId("ads-sync-now").click();
    await expect(sheet.getByTestId("ads-sync-message")).toContainText("Synced");
    await expect(sheet.getByTestId("ads-last-synced")).not.toHaveText("never");
    await expect(sheet.getByTestId("ads-sync-run").first()).toContainText("succeeded");
    await sheet.getByTestId("ads-sync-now").click(); // rate-limited: explained, not an error page
    await expect(sheet.getByTestId("ads-sync-message")).toContainText("wait a minute");

    await page.goto("/analytics?section=marketing&tab=ads&source=google");
    await expect(page.getByTestId("ads-kpi-spend")).toBeVisible();
    await expect(page.getByTestId("ads-last-synced-google_ads")).toContainText("Last synced");
    await expect(page.getByTestId("ads-provider-google_ads")).toContainText("Sample data");
    await expect(page.getByTestId("ads-row-9001001")).toContainText("Not linked");
    await expect(page.getByTestId("ads-kpi-cpl")).toContainText("—"); // no match to PulseOS journeys → no invented cost
    await expect(page.getByTestId("ads-coverage")).toContainText("None of these campaigns is linked");
    await expect(page.getByTestId("ads-kpi-conversions")).toContainText("not PulseOS outcomes");
    await expect(page.getByTestId("ads-spend-chart")).toBeVisible();
  });

  test("Meta Ads: leads are only the action types the hospital mapped", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    expect((await api(page, "PUT", "/integrations/hub/meta_ads/configuration", { configuration: { adAccountId: "act_555" } })).status).toBe(200);
    expect((await api(page, "POST", "/integrations/hub/meta_ads/sync", {})).status).toBe(200);
    await page.goto("/analytics?section=marketing&tab=ads&source=meta");
    const row = page.getByTestId("ads-row-6001001");
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("mapped"); // nothing mapped: no lead figure at all
    expect((await api(page, "PUT", "/integrations/hub/meta_ads/configuration", { configuration: { leadActionTypes: "onsite_conversion.lead_grouped" } })).status).toBe(200);
    await page.reload();
    await expect(page.getByTestId("ads-row-6001001")).toContainText("mapped");
  });

  test("B. shared date presets: one list everywhere, hospital-local, persisted in the URL", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    await page.goto("/analytics?section=marketing&tab=ads");
    const PRESETS = ["Today", "Yesterday", "Last 7 days", "Last 9 days", "Last 30 days", "Last 90 days", "This month", "Previous month", "Custom range"];
    await expect(page.getByTestId("analytics-range")).toBeVisible();
    expect(await periodOptionLabels(page, "analytics")).toEqual(PRESETS);
    await pickPeriod(page, "analytics", "yesterday");
    await expect(page).toHaveURL(/range=yesterday/);
    await expect(page.getByTestId("analytics-period")).toContainText("1 day");
    await page.reload();
    await expectPeriod(page, "analytics", "yesterday");
    await pickPeriod(page, "analytics", "prev_month");
    await expect(page).toHaveURL(/range=prev_month/);
    await pickPeriod(page, "analytics", "custom");
    await expect(page.getByTestId("analytics-custom-dates")).toBeVisible();
    // The same list on the operations report and Leads (one component, one set of presets).
    await page.goto("/analytics");
    await expect(page.getByTestId("report-range")).toBeVisible();
    expect(await periodOptionLabels(page, "report")).toEqual(PRESETS);
    await page.goto("/leads");
    await expect(page.getByTestId("leads-range")).toBeVisible();
    expect((await periodOptionLabels(page, "leads")).slice(1)).toEqual(PRESETS);
  });

  test("Doctor and front desk never get hospital-wide marketing; V1 default returns after reset", async ({ page }) => {
    await login(page, "eyev1.doctor@pulseos.local");
    expect((await api(page, "GET", "/analytics/ads")).status).toBe(403);
    await login(page, "eyev1.frontdesk@pulseos.local");
    expect((await api(page, "GET", "/analytics/ads")).status).toBe(403);
    expect((await api(page, "POST", "/integrations/hub/google_ads/sync", {})).status).toBe(403);
  });
});
