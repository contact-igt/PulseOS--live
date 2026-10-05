import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Campaigns: Table (default) | Calendar | Timeline — one /campaigns/performance query, three views.
// Seeded demo campaigns are all ongoing (end_date NULL). This spec adds two fictional,
// zero-spend campaigns with a unique marker (one ended, one starting at 00:30 IST on
// 1 Oct = 30 Sep 19:00 UTC) and removes them in afterAll.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://localhost:5432/pulseos_dev";
const MARKER = `E2E-P3 Campaign ${Date.now()}`;

function sql(statement: string): string {
  return execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-F", "|", "-c", statement], { encoding: "utf8" }).trim();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
  await page.waitForURL(/command-centre/);
}

async function noPageOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function idsOf(page: Page, prefix: string, scope = page.locator("body")) {
  return (await scope.locator(`[data-testid^="${prefix}"]`).evaluateAll((els, p) => els.map((e) => e.getAttribute("data-testid")!.slice(p.length)), prefix)).sort();
}

let endedId = "";
let lateId = "";

test.describe("Campaigns views", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test.beforeAll(() => {
    const tenant = "(SELECT id FROM tenants WHERE name = 'PulseOS Ophthalmology Demo')";
    endedId = sql(`INSERT INTO marketing_campaigns (tenant_id, source, name, spend_amount, start_date, end_date, status)
      VALUES (${tenant}, 'google', '${MARKER} ended', 0, '2026-09-01T04:30:00Z', '2026-09-20T12:30:00Z', 'ended') RETURNING id;`);
    lateId = sql(`INSERT INTO marketing_campaigns (tenant_id, source, name, spend_amount, start_date, end_date, status)
      VALUES (${tenant}, 'google', '${MARKER} late night', 0, '2026-09-30T19:00:00Z', NULL, 'active') RETURNING id;`);
  });

  test.afterAll(() => {
    const ids = [endedId, lateId].filter(Boolean).map((id) => `'${id}'`).join(",");
    if (ids) sql(`DELETE FROM marketing_campaigns WHERE id IN (${ids});`);
  });

  test("the same campaigns appear in Table, Calendar and Timeline for the same filters", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/campaigns?source=google&date=2026-09-15");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await expect(page.locator('[data-testid^="campaign-row-"]').first()).toBeVisible();
    const tableIds = await idsOf(page, "campaign-row-");
    expect(tableIds).toContain(endedId);
    expect(tableIds).toContain(lateId);

    await page.getByTestId("view-switch-timeline").click();
    await expect(page).toHaveURL(/view=timeline/);
    await expect(page.getByTestId("gantt-grid")).toBeVisible();
    expect(await idsOf(page, "gantt-item-")).toEqual(tableIds);

    await page.getByTestId("view-switch-calendar").click();
    await expect(page).toHaveURL(/view=calendar/);
    await expect(page.getByTestId("calendar-view")).toBeVisible();
    // Every campaign in the table runs at some point between Aug and Oct: the calendar's
    // "running this month" list for Sep + Oct together covers exactly the same set.
    const sep = await idsOf(page, "campaign-running-");
    await page.getByTestId("calendar-next").click();
    await expect(page).toHaveURL(/date=2026-10/);
    const oct = await idsOf(page, "campaign-running-");
    expect([...new Set([...sep, ...oct])].sort()).toEqual(tableIds);
    expect(sep).toContain(endedId);
    expect(sep).not.toContain(lateId);
    expect(oct).toContain(lateId);
    expect(oct).not.toContain(endedId);
  });

  test("an ongoing campaign is open-ended and labelled Ongoing; an ended one keeps its real end", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/campaigns?view=timeline&date=2026-09-15&source=google");
    const late = page.getByTestId(`gantt-item-${lateId}`);
    await expect(late).toHaveAttribute("data-open-ended", "true");
    await expect(late).toContainText("Ongoing");
    await expect(late).toHaveAttribute("aria-label", /1 Oct 2026 – Ongoing/);
    const ended = page.getByTestId(`gantt-item-${endedId}`);
    await expect(ended).toHaveAttribute("data-open-ended", "false");
    await expect(ended).toHaveAttribute("aria-label", /1 Sept? 2026 – 20 Sept? 2026/);

    await page.goto("/campaigns?view=calendar&date=2026-10-01&source=google");
    const running = page.getByTestId(`campaign-running-${lateId}`);
    await expect(running).toContainText("Ongoing");
    await expect(running).not.toContainText(/– \d/); // no end date printed
    const event = page.getByTestId(`calendar-event-${lateId}`);
    await expect(event).toHaveAttribute("aria-label", /Ongoing/);
  });

  test("calendar buckets by hospital day: 30 Sep 19:00 UTC shows on 1 Oct", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/campaigns?view=calendar&date=2026-10-01&source=google");
    await expect(page.getByTestId("calendar-cell-2026-10-01").getByTestId(`calendar-event-${lateId}`)).toBeVisible();
    await expect(page.getByTestId("calendar-cell-2026-09-30").getByTestId(`calendar-event-${lateId}`)).toHaveCount(0);
  });

  test("clicking a campaign in Calendar or Timeline opens its detail page; back restores the view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/campaigns?view=timeline&date=2026-09-15&source=google");
    await page.getByTestId(`gantt-item-${endedId}`).click();
    await page.waitForURL(new RegExp(`/campaigns/${endedId}`));
    await expect(page.getByTestId("campaign-detail-page")).toBeVisible();
    await expect(page.getByTestId("campaign-run-window")).toContainText(/20 Sept? 2026/);
    await page.goBack();
    await expect(page).toHaveURL(/view=timeline/);
    await expect(page).toHaveURL(/source=google/);
    await expect(page.getByTestId("gantt-grid")).toBeVisible();

    await page.goto("/campaigns?view=calendar&date=2026-10-01&source=google");
    await page.getByTestId(`calendar-event-${lateId}`).click();
    await page.waitForURL(new RegExp(`/campaigns/${lateId}`));
    await expect(page.getByTestId("campaign-run-window")).toContainText("Ongoing");
  });

  test("view, date and filters survive reload and back/forward", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/campaigns");
    await page.getByTestId("campaigns-source-filter").selectOption("google");
    await expect(page).toHaveURL(/source=google/);
    await page.getByTestId("view-switch-timeline").click();
    await expect(page).toHaveURL(/view=timeline/);
    await page.getByRole("button", { name: "Later" }).click();
    await expect(page).toHaveURL(/date=/);
    const url = page.url();
    await page.reload();
    expect(page.url()).toBe(url);
    await expect(page.getByTestId("gantt-timeline")).toBeVisible();
    await expect(page.getByTestId("campaigns-source-filter")).toHaveValue("google");
  });

  test("390px: timeline becomes a list, calendar becomes Agenda, no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto("/campaigns?view=timeline&date=2026-09-15&source=google");
    await expect(page.getByTestId("gantt-timeline")).toHaveAttribute("data-mobile-fallback", "true");
    await expect(page.getByTestId("gantt-list")).toBeVisible();
    await expect(page.getByTestId(`gantt-item-${lateId}`)).toContainText("Ongoing");
    await noPageOverflow(page);
    await page.goto("/campaigns?view=calendar&date=2026-10-01&source=google");
    await expect(page.getByTestId("calendar-view")).toHaveAttribute("data-mode", "agenda");
    await noPageOverflow(page);
    await page.goto("/campaigns");
    await noPageOverflow(page);
  });
});
