import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";

// M6.6 Analytics (operations): one URL filter state → one request → every KPI, chart and table. V1 has no spend / ROAS.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async ({ api, path }) => (await (await fetch(`${api}${path}`, { credentials: "include" })).json()) as never, { api: API, path });
}

const num = async (page: Page, id: string) => Number((await page.getByTestId(id).textContent())!.replace(/[^\d]/g, "").slice(0, 6) || 0);
const kpi = (page: Page, key: string) => num(page, `analytics-kpi-${key}-value`);

type Op = { kpis: Record<string, number>; daily: Record<string, number | string>[] };

test.describe("M6.6 — Analytics (operations)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("V1 admin: Analytics is in the sidebar, shows the eight operational KPIs, and has no spend, ROAS or campaign anything", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.locator('nav a[href="/analytics"]').first().click();
    await page.waitForURL(/\/analytics/);
    await expect(page.getByTestId("operations-analytics")).toBeVisible();
    for (const [key, label] of [
      ["enquiries", "Enquiries"], ["follow-ups", "Follow-ups"], ["appointments", "Appointments"], ["checked-in", "Checked In"],
      ["consultations", "Consultations Completed"], ["no-shows", "No-shows"], ["surgeries-scheduled", "Surgeries Scheduled"], ["procedures-completed", "Procedures Completed"],
    ]) await expect(page.getByTestId(`analytics-kpi-${key}`)).toContainText(label);
    await expect(page.getByTestId("analytics-area-marketing")).toHaveCount(0); // growth edition only
    const text = (await page.getByTestId("analytics-page").innerText()).toLowerCase();
    for (const banned of ["roas", "ad spend", "marketing spend", "campaign", "cost per"]) expect(text, banned).not.toContain(banned);
    // Every requested panel is there.
    for (const id of ["analytics-daily", "analytics-funnel", "analytics-sources", "analytics-services", "analytics-team"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("analytics-period")).toContainText("Asia/Kolkata");
    // The API refuses marketing analytics to a V1 hospital, while the operational data is allowed.
    expect((await page.evaluate(async (api) => (await fetch(`${api}/analytics/summary`, { credentials: "include" })).status, API))).toBe(403);
    expect((await page.evaluate(async (api) => (await fetch(`${api}/reports/operations`, { credentials: "include" })).status, API))).toBe(200);
  });

  test("filters live in the URL (survive refresh and back/forward), and every KPI equals the API for the same filters", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/analytics");
    await expectPeriod(page, "report", "30d"); // the default is not written to the URL
    expect(page.url()).not.toContain("aRange");

    await pickPeriod(page, "report", "7d");
    await expect(page).toHaveURL(/aRange=7d/);
    const first = await apiJson<Op>(page, "/reports/operations?range=7d");
    await expect.poll(() => kpi(page, "enquiries")).toBe(first.kpis.newEnquiries);
    expect(await kpi(page, "appointments")).toBe(first.kpis.appointmentsScheduled);
    expect(await kpi(page, "checked-in")).toBe(first.kpis.appointmentsAttended);
    expect(await kpi(page, "consultations")).toBe(first.kpis.consultationsCompleted);
    expect(await kpi(page, "no-shows")).toBe(first.kpis.appointmentsNoShow);
    expect(await kpi(page, "surgeries-scheduled")).toBe(first.kpis.proceduresScheduled);
    expect(await kpi(page, "procedures-completed")).toBe(first.kpis.proceduresCompleted);

    // Add a service filter: still one state, every number follows.
    const services = await page.getByTestId("report-filter-service").locator("option").allTextContents();
    const svc = services.find((s) => s !== "All services")!;
    await page.getByTestId("report-filter-service").selectOption(svc);
    await expect(page).toHaveURL(/aService=/);
    await expect(page.getByTestId("report-chips")).toContainText(`Service: ${svc}`);
    const filtered = await apiJson<Op>(page, `/reports/operations?range=7d&service=${encodeURIComponent(svc)}`);
    await expect.poll(() => kpi(page, "enquiries")).toBe(filtered.kpis.newEnquiries);

    await page.reload();
    await expectPeriod(page, "report", "7d");
    await expect(page.getByTestId("report-filter-service")).toHaveValue(svc);
    await expect.poll(() => kpi(page, "enquiries")).toBe(filtered.kpis.newEnquiries);
    await page.goto("/command-centre");
    await page.goBack();
    await expect(page.getByTestId("report-filter-service")).toHaveValue(svc);

    // Reset clears the analytics keys only and the filters return to the default.
    await page.getByTestId("report-reset").click();
    await expect(page).not.toHaveURL(/aService|aRange/);
    await expectPeriod(page, "report", "30d");
  });

  test("Date range offers Today, Yesterday, 7, 30, This month, Previous month and Custom; custom is validated", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/analytics");
    await expect(page.getByTestId("report-range")).toBeVisible();
    expect(await periodOptionLabels(page, "report")).toEqual(["Today", "Yesterday", "Last 7 days", "Last 9 days", "Last 30 days", "Last 90 days", "This month", "Previous month", "Custom range"]);
    await pickPeriod(page, "report", "custom");
    await expect(page.getByTestId("report-custom-dates")).toBeVisible();
    await expect(page).toHaveURL(/aRange=custom&.*aFrom=\d{4}-\d\d-\d\d/);
    // A hand-made bad link falls back to the default instead of breaking.
    await page.goto("/analytics?aRange=custom&aFrom=2026-10-05&aTo=2026-09-01");
    await expectPeriod(page, "report", "30d");
    await page.goto("/analytics?aRange=forever&aBranch=not-a-uuid");
    await expectPeriod(page, "report", "30d");
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  });

  test("every day-by-day column sums to its KPI, and the table is sortable with aria-sort", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/analytics?aRange=30d");
    await page.getByTestId("analytics-daily-table-tab").click();
    const table = page.getByTestId("analytics-daily-table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: /Date/ })).toHaveAttribute("aria-sort", "descending");
    const col = async (name: RegExp) => {
      const idx = (await table.getByRole("columnheader").allTextContents()).findIndex((h) => name.test(h));
      return (await table.locator("tbody tr").evaluateAll((trs, i) => trs.map((tr) => Number((tr.children[i as number] as HTMLElement).textContent)), idx)).reduce((a, b) => a + b, 0);
    };
    expect(await col(/New leads/)).toBe(await kpi(page, "enquiries"));
    expect(await col(/^Appointments/)).toBe(await kpi(page, "appointments"));
    expect(await col(/Checked in/)).toBe(await kpi(page, "checked-in"));
    expect(await col(/Completed/)).toBe(await kpi(page, "consultations"));
    expect(await col(/No-shows/)).toBe(await kpi(page, "no-shows"));

    // Sorting: first click ascending, second descending; numbers sort numerically.
    await page.getByTestId("analytics-daily-table-sort-enquiries").click();
    await expect(table.getByRole("columnheader", { name: /New leads/ })).toHaveAttribute("aria-sort", "ascending");
    const vals = async () => table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => Number((tr.children[1] as HTMLElement).textContent)));
    const asc = await vals();
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    await page.getByTestId("analytics-daily-table-sort-enquiries").click();
    await expect(table.getByRole("columnheader", { name: /New leads/ })).toHaveAttribute("aria-sort", "descending");
    // Keyboard: Enter on a header button sorts too.
    await page.getByTestId("analytics-daily-table-sort-noShow").focus();
    await page.keyboard.press("Enter");
    await expect(table.getByRole("columnheader", { name: /No-shows/ })).toHaveAttribute("aria-sort", "ascending");
  });

  test("click-to-drill: a day, a source, a service and a team member each become a filter", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/analytics?aRange=30d");
    // A source bar.
    const sourceBar = page.locator('[data-testid="analytics-source-bars"] button').first();
    await sourceBar.click();
    await expect(page).toHaveURL(/aSource=/);
    await expect(page.getByTestId("report-chips")).toContainText("Source:");
    await sourceBar.click(); // selecting the same mark again clears it
    await expect(page).not.toHaveURL(/aSource=/);
    // A service row.
    await page.getByTestId("analytics-by-service").locator("tbody button").first().click();
    await expect(page).toHaveURL(/aService=/);
    // "Unassigned" in Team workload is plain text, not a button that does nothing.
    const unassigned = page.getByTestId("analytics-by-owner").getByRole("row", { name: /^Unassigned/ });
    if ((await unassigned.count()) > 0) await expect(unassigned.getByRole("button")).toHaveCount(0);
    await page.getByTestId("report-reset").click();
    // A day from the table.
    await page.getByTestId("analytics-daily-table-tab").click();
    await page.getByTestId("analytics-daily-table").locator("tbody button").first().click();
    await expect(page).toHaveURL(/aRange=custom&aFrom=(\d{4}-\d\d-\d\d)&aTo=\1/);
    await expect(page.getByTestId("analytics-period")).toContainText(/\d{4}\s*·/);
  });

  test("V2 (growth) admin keeps Marketing & revenue next to Operations; the marketing keys never leak into the operations filters", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/analytics");
    await expect(page.getByTestId("analytics-area-marketing")).toBeVisible();
    await page.getByTestId("analytics-area-marketing").click();
    await expect(page.getByTestId("marketing-analytics")).toBeVisible();
    await expect(page.getByTestId("panel-campaigns")).toBeVisible();
    await page.getByTestId("analytics-area-operations").click();
    await expect(page.getByTestId("operations-analytics")).toBeVisible();
    await expectPeriod(page, "report", "30d");
  });

  test("Staff cannot open Analytics: no sidebar entry, the page redirects home, and the data API is 403", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.frontdesk@pulseos.local");
    await expect(page.locator('nav a[href="/analytics"]')).toHaveCount(0);
    await page.goto("/analytics");
    await page.waitForURL(/\/front-desk/);
    expect((await page.evaluate(async (api) => (await fetch(`${api}/reports/operations`, { credentials: "include" })).status, API))).toBe(403);
  });

  test("hospital time: a browser in Los Angeles shows the hospital's days", async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/analytics?aRange=today");
    await expect(page.getByTestId("analytics-period")).toContainText("Asia/Kolkata");
    const op = await apiJson<{ period: { today: string } }>(page, "/reports/operations?range=today");
    const [y, m, d] = op.period.today.split("-").map(Number);
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m! - 1];
    await expect(page.getByTestId("analytics-period")).toContainText(`${d} ${month} ${y}`);
    await ctx.close();
  });

  test("390px: filters open in a side sheet with an active-filter count, Reset shows only when needed, nothing overflows", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/analytics");
    const opener = page.getByTestId("report-filters-open");
    await expect(opener).toBeVisible();
    expect((await opener.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    await opener.click();
    const sheet = page.getByTestId("report-filters-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("report-filters-reset")).toHaveCount(0); // nothing to reset yet
    for (const id of ["report-filter-branch", "report-filter-department", "report-filter-service", "report-filter-source", "report-filter-owner", "report-filter-doctor"]) await expect(sheet.getByTestId(id)).toBeVisible();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    const services = await sheet.getByTestId("report-filter-service").locator("option").allTextContents();
    await sheet.getByTestId("report-filter-service").selectOption(services[1]!);
    await expect(page.getByTestId("report-filters-reset")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(opener).toContainText("1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    test(`${vp.width}x${vp.height}: overview, filters, daily chart and daily table fit without page overflow`, async ({ page }) => {
      await page.setViewportSize(vp);
      await login(page, "eyev1.admin@pulseos.local");
      await page.goto("/analytics");
      await expect(page.getByTestId("analytics-kpis")).toBeVisible();
      await expect(page.getByTestId("analytics-daily-chart")).toBeVisible();
      const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await over()).toBeLessThanOrEqual(0);
      await page.getByTestId("analytics-daily-table-tab").click();
      await expect(page.getByTestId("analytics-daily-table")).toBeVisible();
      expect(await over()).toBeLessThanOrEqual(0);
      if (vp.width < 768) expect((await page.getByTestId("analytics-daily-table-sort-enquiries").boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    });
  }
});
