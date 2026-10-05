import { test, expect, type Page } from "@playwright/test";
import type { LeadRow } from "@pulseos/types";

// Leads: Table (default) | Board (READ-ONLY, by journey stage). One query, one
// filter state in the URL; the board's column counts equal the table's
// per-stage counts. Read-only suite: nothing here mutates data.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";

async function devLogin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
  await page.waitForURL(/\/command-centre/);
}

async function apiLeads(page: Page, query: string): Promise<LeadRow[]> {
  return page.evaluate(async ([base, q]) => (await fetch(`${base}/leads${q}`, { credentials: "include" })).json(), [API, query] as const);
}

/** Per-stage counts from the TABLE's own rows (each row carries data-stage). */
async function tableStageCounts(page: Page): Promise<Record<string, number>> {
  const stages = await page.locator('[data-testid^="lead-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-stage") ?? "?"));
  return stages.reduce<Record<string, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

async function boardStageCounts(page: Page): Promise<Record<string, number>> {
  const cols = page.locator('[data-testid^="kanban-col-"]');
  const out: Record<string, number> = {};
  for (const col of await cols.all()) {
    const key = ((await col.getAttribute("data-testid")) ?? "").replace("kanban-col-", "");
    const n = await col.locator('[data-testid^="kanban-card-"]').count();
    if (n > 0) out[key] = n;
  }
  return out;
}

async function noPageOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "page scrolls horizontally").toBeLessThanOrEqual(0);
}

test.describe("Leads views", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("board shows the same records as the table; column counts equal the table's per-stage counts for the same filters", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    for (const qs of ["", "?status=follow_up_due", "?owner=unassigned"]) {
      await page.goto(`/leads${qs}`);
      await expect(page.getByTestId("leads-page")).toBeVisible();
      const api = await apiLeads(page, qs);
      if (api.length > 0) await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(api.length);
      const table = await tableStageCounts(page);

      await page.getByTestId("view-switch-board").click();
      await expect(page).toHaveURL(/layout=board/);
      if (api.length === 0) {
        // Nothing matches (e.g. no unassigned leads in this seed): both views show the same empty state.
        await expect(page.getByText("No leads match these filters.")).toBeVisible();
        await page.getByTestId("view-switch-table").click();
        await expect(page.getByText("No leads match these filters.")).toBeVisible();
        continue;
      }
      await expect(page.getByTestId("leads-board")).toBeVisible();
      const board = await boardStageCounts(page);
      expect(board, `stage counts for filter "${qs || "all"}"`).toEqual(table);
      const apiCounts = api.reduce<Record<string, number>>((acc, r) => ((acc[r.stage] = (acc[r.stage] ?? 0) + 1), acc), {});
      expect(board).toEqual(apiCounts);

      // Column header counts (aria-label "Title, N cards") agree with the cards rendered.
      for (const [stage, n] of Object.entries(board)) {
        await expect(page.getByTestId(`kanban-col-${stage}`)).toHaveAttribute("aria-label", new RegExp(`, ${n} cards?$`));
      }
      await page.getByTestId("view-switch-table").click();
      await expect(page).not.toHaveURL(/layout=board/);
    }
  });

  test("board is read-only: no drag, no move menu, a quiet hint; card click opens the journey", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    await page.goto("/leads?layout=board");
    const board = page.getByTestId("kanban-board");
    await expect(board).toHaveAttribute("data-readonly", "true");
    await expect(page.locator("[draggable=true]")).toHaveCount(0);
    await expect(page.locator('[data-testid^="kanban-move-"]')).toHaveCount(0);
    await expect(page.getByTestId("leads-board-hint")).toContainText("Stages change from the journey page");

    const card = page.locator('[data-testid^="kanban-card-"]').first();
    const id = ((await card.getAttribute("data-testid")) ?? "").replace("kanban-card-", "");
    await card.getByRole("button").click();
    await page.waitForURL(new RegExp(`/journeys/${id}`));
    // Back restores the board view (URL state).
    await page.goBack();
    await expect(page).toHaveURL(/layout=board/);
    await expect(page.getByTestId("leads-board")).toBeVisible();
  });

  test("view and status filter survive reload and back/forward", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    await page.goto("/leads?view=uncontacted&layout=board");
    await page.reload();
    await expect(page.getByTestId("leads-board")).toBeVisible();
    await expect(page.getByTestId("leads-tab-uncontacted")).toHaveAttribute("aria-selected", "true");
    await page.goto("/command-centre");
    await page.goBack();
    await expect(page).toHaveURL(/view=uncontacted/);
    await expect(page.getByTestId("leads-board")).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/command-centre/);
  });

  test("390px: the board scrolls inside its card; the page never overflows", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page);
    await page.goto("/leads?layout=board");
    await expect(page.getByTestId("leads-board")).toBeVisible();
    await noPageOverflow(page);
    const scrolls = await page.getByTestId("kanban-board").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls, "columns scroll horizontally inside the board").toBe(true);
    await page.goto("/leads");
    await noPageOverflow(page);
  });
});
