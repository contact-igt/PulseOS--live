import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Treatments: Table (default) | Pipeline board | Procedure Calendar — one query, three views.
// Fixtures: a fictional patient + journey whose service (journey type) is a unique
// marker, so `?service=<marker>` scopes every view to exactly our own treatments.
// Everything is created straight in the dev DB (same DB the dev API uses) and
// removed in afterAll, pass or fail.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://localhost:5432/pulseos_dev";
const MARKER = `E2E-P3 Views ${Date.now()}`;

type RoleKey = "HOSPITAL_ADMIN" | "DOCTOR";
const HOME: Record<RoleKey, RegExp> = { HOSPITAL_ADMIN: /\/command-centre/, DOCTOR: /\/doctor-home/ };

function sql(statement: string): string {
  return execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-F", "|", "-c", statement], { encoding: "utf8" }).trim();
}

async function devLogin(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(HOME[role]);
}

async function noPageOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

const ids: Record<"move" | "stale" | "tz" | "undated" | "done", string> = { move: "", stale: "", tz: "", undated: "", done: "" };
let journeyId = "";
let patientId = "";
const svc = encodeURIComponent(MARKER);

test.describe("Treatments views", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test.beforeAll(() => {
    const out = sql(`
      WITH t AS (SELECT id FROM tenants WHERE name = 'PulseOS Ophthalmology Demo'),
      p AS (INSERT INTO patients (tenant_id, name, phone, marketing_consent) SELECT t.id, 'E2E Views Patient', '96' || lpad((extract(epoch from now())::bigint % 100000000)::text, 8, '0'), false FROM t RETURNING id, tenant_id),
      j AS (INSERT INTO journeys (tenant_id, patient_id, journey_type, source, stage) SELECT p.tenant_id, p.id, '${MARKER}', 'walk_in', 'treatment_advised' FROM p RETURNING id, tenant_id, patient_id)
      SELECT j.id, j.patient_id FROM j;`);
    [journeyId, patientId] = out.split("|");
    const insert = (label: string, status: string, planned: string | null) =>
      sql(`INSERT INTO treatment_opportunities (tenant_id, patient_id, journey_id, treatment_label, status, estimated_value, planned_date)
           SELECT tenant_id, patient_id, id, '${label}', '${status}', 10000, ${planned ? `'${planned}'` : "NULL"} FROM journeys WHERE id = '${journeyId}' RETURNING id;`);
    ids.move = insert("E2E Move Card", "ADVISED", null);
    ids.stale = insert("E2E Stale Card", "ADVISED", null);
    // 19:00 UTC on 4 Oct is 00:30 on 5 Oct in Asia/Kolkata: must land on 5 Oct.
    ids.tz = insert("E2E Late Night Procedure", "SCHEDULED", "2026-10-04T19:00:00Z");
    ids.undated = insert("E2E Undated Procedure", "SCHEDULED", null);
    ids.done = insert("E2E Completed", "COMPLETED", "2026-10-06T04:30:00Z");
  });

  test.afterAll(() => {
    if (!journeyId) return;
    sql(`
      DELETE FROM timeline_events WHERE journey_id = '${journeyId}';
      DELETE FROM tasks WHERE journey_id = '${journeyId}';
      DELETE FROM revenue_events WHERE journey_id = '${journeyId}';
      DELETE FROM conversion_feedback_events WHERE journey_id = '${journeyId}';
      DELETE FROM treatment_opportunities WHERE journey_id = '${journeyId}';
      DELETE FROM journeys WHERE id = '${journeyId}';
      DELETE FROM patients WHERE id = '${patientId}';`);
  });

  test("same records in Table, Pipeline and Calendar for the same filters; board counts equal table counts", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");

    await page.goto(`/treatments?service=${svc}`);
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await expect(page.locator('[data-testid^="treatment-row-"]')).toHaveCount(5);
    const tableIds = (await page.locator('[data-testid^="treatment-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("treatment-row-", "")))).sort();

    await page.getByTestId("view-switch-pipeline").click();
    await expect(page).toHaveURL(/view=pipeline/);
    expect(new URL(page.url()).searchParams.get("service")).toBe(MARKER);
    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible();
    const boardIds = (await board.locator('[data-testid^="kanban-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("kanban-card-", "")))).sort();
    expect(boardIds).toEqual(tableIds);
    await expect(page.getByTestId("kanban-col-ADVISED").locator('[data-testid^="kanban-card-"]')).toHaveCount(2);
    await expect(page.getByTestId("kanban-col-SCHEDULED").locator('[data-testid^="kanban-card-"]')).toHaveCount(2);
    await expect(page.getByTestId("kanban-col-COMPLETED").locator('[data-testid^="kanban-card-"]')).toHaveCount(1);

    // Unfiltered: every column's count sums to the table's summary count.
    await page.goto("/treatments?view=pipeline");
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    const summary = await page.getByTestId("treatments-summary").innerText();
    const total = Number(summary.match(/^(\d+)/)![1]);
    await expect(page.locator('[data-testid^="kanban-card-"]')).toHaveCount(total);
    await page.getByTestId("view-switch-table").click();
    await expect(page.locator('[data-testid^="treatment-row-"]')).toHaveCount(total);
  });

  test("Move to... lists only valid targets; a valid move persists across reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto(`/treatments?view=pipeline&service=${svc}`);
    await expect(page.getByTestId(`kanban-card-${ids.move}`)).toBeVisible();

    // Keyboard path (no drag): focus the Move control, open with Enter.
    await page.getByTestId(`kanban-move-${ids.move}`).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Decision Pending", "Accepted"]);
    // Completed card offers no move at all.
    await expect(page.getByTestId(`kanban-move-${ids.done}`)).toHaveCount(0);

    // Opening the menu puts focus on its first item; Enter selects it.
    await expect(page.getByTestId(`kanban-move-${ids.move}-DECISION_PENDING`)).toBeFocused();
    await page.keyboard.press("Enter"); // Decision Pending
    await expect(page.getByTestId("kanban-col-DECISION_PENDING").getByTestId(`kanban-card-${ids.move}`)).toBeVisible();
    await expect.poll(() => sql(`SELECT status FROM treatment_opportunities WHERE id = '${ids.move}'`)).toBe("DECISION_PENDING");

    await page.reload();
    await expect(page.getByTestId("kanban-col-DECISION_PENDING").getByTestId(`kanban-card-${ids.move}`)).toBeVisible();
  });

  test("a move the server rejects is reverted with a clear inline error", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto(`/treatments?view=pipeline&service=${svc}`);
    await expect(page.getByTestId("kanban-col-ADVISED").getByTestId(`kanban-card-${ids.stale}`)).toBeVisible();

    // Someone else declines it after this board loaded: ADVISED -> ACCEPTED is now invalid server-side.
    sql(`UPDATE treatment_opportunities SET status = 'DECLINED' WHERE id = '${ids.stale}'`);

    await page.getByTestId(`kanban-move-${ids.stale}`).click();
    await page.getByTestId(`kanban-move-${ids.stale}-ACCEPTED`).click();
    const card = page.getByTestId(`kanban-card-${ids.stale}`);
    await expect(card.getByRole("alert")).toContainText("changed elsewhere");
    await expect(page.getByTestId("kanban-col-ACCEPTED").getByTestId(`kanban-card-${ids.stale}`)).toHaveCount(0);
    // Board now shows the server's truth.
    await expect(page.getByTestId("kanban-col-DECLINED").getByTestId(`kanban-card-${ids.stale}`)).toBeVisible();
    expect(sql(`SELECT status FROM treatment_opportunities WHERE id = '${ids.stale}'`)).toBe("DECLINED");
  });

  test("Doctor (VIEW_TREATMENT only) never reaches a movable board: routed to Doctor Home", async ({ page }) => {
    // The only role without MANAGE_TREATMENT is Doctor, and the shell routes Doctor away
    // from /treatments. The read-only board rendering itself is covered by
    // components/treatments/__tests__/TreatmentPipelineBoard.test.tsx; the server-side
    // 403 by apps/api/src/__tests__/treatment-views-board-moves.test.ts.
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "DOCTOR");
    await page.goto(`/treatments?view=pipeline&service=${svc}`);
    await page.waitForURL(/\/doctor-home/);
    await expect(page.locator('[data-testid^="kanban-move-"]')).toHaveCount(0);
  });

  test("Procedure Calendar shows only dated Scheduled treatments, on the hospital-local day", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto(`/treatments?view=calendar&date=2026-10-05&service=${svc}`);
    await expect(page.getByTestId("calendar-view")).toBeVisible();
    await expect(page.getByTestId("treatment-calendar-scope")).toContainText("Only Scheduled treatments with a planned date");
    await expect(page.getByTestId("treatment-calendar-scope")).toContainText("1 scheduled treatment has no planned date");
    await expect(page.getByTestId("calendar-cell-2026-10-05").getByTestId(`calendar-event-${ids.tz}`)).toBeVisible();
    await expect(page.getByTestId("calendar-cell-2026-10-04").getByTestId(`calendar-event-${ids.tz}`)).toHaveCount(0);
    await expect(page.getByTestId(`calendar-event-${ids.undated}`)).toHaveCount(0);
    await expect(page.getByTestId(`calendar-event-${ids.done}`)).toHaveCount(0);

    // Event click opens the journey (deep entity -> page); back restores view + date.
    await page.getByTestId(`calendar-event-${ids.tz}`).click();
    await page.waitForURL(new RegExp(`/journeys/${journeyId}`));
    await page.goBack();
    await expect(page).toHaveURL(/view=calendar/);
    await expect(page).toHaveURL(/date=2026-10-05/);
    await expect(page.getByTestId("calendar-cell-2026-10-05").getByTestId(`calendar-event-${ids.tz}`)).toBeVisible();
  });

  test("view, date and filters survive reload and back/forward", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto(`/treatments?service=${svc}`);
    await page.getByTestId("view-switch-calendar").click();
    await expect(page).toHaveURL(/view=calendar/);
    await page.getByTestId("calendar-next").click();
    await expect(page).toHaveURL(/date=/);
    const url = page.url();
    await page.reload();
    expect(page.url()).toBe(url);
    await expect(page.getByTestId("calendar-view")).toBeVisible();
    await expect(page.getByTestId("treatment-filter-service")).toHaveValue(MARKER);

    await page.getByTestId("view-switch-pipeline").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await page.getByTestId(`kanban-card-${ids.tz}`).getByRole("button").first().click();
    await page.waitForURL(new RegExp(`/journeys/${journeyId}`));
    await page.goBack();
    await expect(page).toHaveURL(/view=pipeline/);
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await page.goForward();
    await page.waitForURL(new RegExp(`/journeys/${journeyId}`));
  });

  test("390px: board scrolls inside its card, calendar falls back to Agenda, no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto("/treatments?view=pipeline");
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await noPageOverflow(page);
    await page.goto(`/treatments?view=calendar&date=2026-10-05&service=${svc}`);
    await expect(page.getByTestId("calendar-view")).toHaveAttribute("data-mode", "agenda");
    await expect(page.getByTestId(`calendar-event-${ids.tz}`)).toBeVisible();
    await noPageOverflow(page);
    await page.goto("/treatments");
    await noPageOverflow(page);
  });
});
