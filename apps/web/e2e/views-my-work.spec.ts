import { test, expect, type Page } from "@playwright/test";
import type { SessionUser, TaskRow } from "@pulseos/types";
import { purgePatients, sql } from "./support/fixtures";

// My Work: List (default) | Board (due buckets) | Calendar (by due date).
// All three render the SAME tasks query. Buckets / calendar days are the
// hospital's (Asia/Kolkata). Tests create their own tasks (marked in notes)
// and never rely on global demo counts.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const TZ = "Asia/Kolkata";
const MARK = `p2e2e-${Date.now()}`;

const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shiftKey = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** An instant at local hospital wall time `hh:mm` on day `key` (IST is a fixed +05:30). */
const ist = (key: string, hhmm: string) => new Date(`${key}T${hhmm}:00+05:30`).toISOString();

async function devLogin(page: Page, role: "PATIENT_COORDINATOR" | "DOCTOR" = "PATIENT_COORDINATOR") {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(role === "DOCTOR" ? /\/doctor-home/ : /\/my-work/);
}

async function call<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ([base, m, p, b]) => {
      const res = await fetch(`${base}${p}`, { method: m, credentials: "include", headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    [API, method, path, body] as const,
  ) as Promise<{ status: number; json: T }>;
}

// Tasks hang off a fictional patient + journey made for this run (never a real demo
// patient), removed with everything attached in afterAll.
const FIXTURE_PREFIX = "E2E My Work ";
let fixture: { patientId: string; journeyId: string } | null = null;
function ensureFixture() {
  if (fixture) return fixture;
  const [journeyId, patientId] = sql(`
    WITH t AS (SELECT id FROM tenants WHERE name = 'PulseOS Ophthalmology Demo'),
    p AS (INSERT INTO patients (tenant_id, name, phone, marketing_consent) SELECT t.id, '${FIXTURE_PREFIX}${MARK}', '97' || lpad((extract(epoch from now())::bigint % 100000000)::text, 8, '0'), false FROM t RETURNING id, tenant_id),
    j AS (INSERT INTO journeys (tenant_id, patient_id, journey_type, source, stage) SELECT p.tenant_id, p.id, 'Cataract', 'walk_in', 'contacted' FROM p RETURNING id, patient_id)
    SELECT j.id, j.patient_id FROM j;`).split("|");
  fixture = { patientId, journeyId };
  return fixture;
}

async function createTask(page: Page, dueAt: string, label: string): Promise<TaskRow> {
  const me = (await call<{ user: SessionUser }>(page, "GET", "/auth/session")).json.user;
  const { patientId, journeyId } = ensureFixture();
  const res = await call<TaskRow>(page, "POST", "/tasks", { patientId, journeyId, assignedTo: me.id, type: "CALLBACK", dueAt, notes: `${MARK} ${label}` });
  expect(res.status).toBe(200);
  return res.json;
}

const colOf = (page: Page, id: string) => page.locator('[data-testid^="kanban-col-"]', { has: page.getByTestId(`kanban-card-${id}`) });

async function noPageOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "page scrolls horizontally").toBeLessThanOrEqual(0);
}

test.describe("My Work views", () => {
  test.afterAll(() => purgePatients(FIXTURE_PREFIX));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });

  test("list, board and calendar render the same tasks; a task due at IST 00:15 lands on its hospital-local day", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const today = dayKey(new Date());
    const tomorrow = shiftKey(today, 1);
    const a = await createTask(page, ist(tomorrow, "00:15"), "tomorrow-0015"); // UTC date = today
    const b = await createTask(page, ist(today, "23:59"), "today-2359");
    const c = await createTask(page, ist(shiftKey(today, -1), "10:00"), "yesterday");

    await page.goto("/my-work");
    const rows = page.locator('[data-testid^="task-row-"]');
    await expect(rows.first()).toBeVisible();
    const listIds = (await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("task-row-", "")))).sort();
    for (const t of [a, b, c]) expect(listIds).toContain(t.id);

    await page.getByTestId("view-switch-board").click();
    await expect(page).toHaveURL(/view=board/);
    const cardIds = (await page.locator('[data-testid^="kanban-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("kanban-card-", "")))).sort();
    expect(cardIds).toEqual(listIds);
    await expect(colOf(page, a.id)).toHaveAttribute("data-testid", "kanban-col-upcoming");
    await expect(colOf(page, b.id)).toHaveAttribute("data-testid", "kanban-col-today");
    await expect(colOf(page, c.id)).toHaveAttribute("data-testid", "kanban-col-overdue");

    await page.getByTestId("view-switch-calendar").click();
    await expect(page).toHaveURL(/view=calendar/);
    // Day view lists every event of that hospital day: A is on tomorrow, not on today (its UTC date).
    await page.goto(`/my-work?view=calendar&range=day&date=${tomorrow}`);
    await expect(page.getByTestId(`calendar-event-${a.id}`)).toBeVisible();
    await page.goto(`/my-work?view=calendar&range=day&date=${today}`);
    await expect(page.getByTestId(`calendar-event-${b.id}`)).toBeVisible();
    await expect(page.getByTestId(`calendar-event-${a.id}`)).toHaveCount(0);

    await page.goto(`/my-work?view=calendar&range=month&date=${tomorrow}`);
    await expect(page.getByTestId("calendar-view")).toHaveAttribute("data-mode", "month");

    // Every listed task whose hospital day is in the visible grid is on the calendar (events + "+k more").
    const grid = await page.locator('[data-testid^="calendar-cell-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("calendar-cell-", "")));
    const tasks = (await call<TaskRow[]>(page, "GET", `/tasks?assignedTo=${(await call<{ user: SessionUser }>(page, "GET", "/auth/session")).json.user.id}`)).json;
    const expected = tasks.filter((t) => grid.includes(dayKey(new Date(t.dueAt)))).length;
    const shown = await page.locator('[data-testid^="calendar-event-"]').count();
    const more = (await page.locator('[data-testid^="calendar-more-"]').allTextContents()).reduce((n, s) => n + Number(s.replace(/[^0-9]/g, "")), 0);
    expect(shown + more).toBe(expected);
  });

  test("board: moving an overdue task to Today reschedules it through the real endpoint", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const today = dayKey(new Date());
    const t = await createTask(page, ist(shiftKey(today, -2), "09:00"), "move-me");
    await page.goto("/my-work?view=board");
    await expect(colOf(page, t.id)).toHaveAttribute("data-testid", "kanban-col-overdue");
    await page.getByTestId(`kanban-move-${t.id}`).click();
    await page.getByTestId(`kanban-move-${t.id}-today`).click();
    await expect(colOf(page, t.id)).toHaveAttribute("data-testid", "kanban-col-today");
    await expect(page.getByTestId(`kanban-card-${t.id}`).getByRole("alert")).toHaveCount(0);
    const after = (await call<TaskRow[]>(page, "GET", `/tasks?assignedTo=${t.assignedTo}`)).json.find((x) => x.id === t.id)!;
    expect(dayKey(new Date(after.dueAt))).toBe(today);
    expect(new Date(after.dueAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("board: a move the server rejects returns the card to its column with an inline error", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const t = await createTask(page, ist(shiftKey(dayKey(new Date()), -3), "09:00"), "reject-me");
    await page.route(`${API}/tasks/${t.id}/reschedule`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "conflict" }) }));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/my-work?view=board");
    await page.getByTestId(`kanban-move-${t.id}`).click();
    await page.getByTestId(`kanban-move-${t.id}-upcoming`).click();
    await expect(page.getByTestId(`kanban-card-${t.id}`).getByRole("alert")).toContainText("Not moved");
    await expect(colOf(page, t.id)).toHaveAttribute("data-testid", "kanban-col-overdue");
    expect(errors).toEqual([]);
  });

  test("list: completing a task the server already closed reverts with an inline error (no crash)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const t = await createTask(page, ist(shiftKey(dayKey(new Date()), 1), "11:00"), "stale-complete");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/my-work");
    await expect(page.getByTestId(`task-complete-${t.id}`)).toBeVisible();
    expect((await call(page, "PATCH", `/tasks/${t.id}/complete`, {})).status).toBe(200); // someone else closes it
    await page.getByTestId(`task-complete-${t.id}`).click();
    await expect(page.getByTestId(`task-error-${t.id}`)).toContainText(/already completed/i);
    expect(errors).toEqual([]);
  });

  test("calendar: event click opens the task drawer; Complete works; Escape closes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const today = dayKey(new Date());
    const t = await createTask(page, ist(shiftKey(today, 2), "12:00"), "drawer");
    await page.goto(`/my-work?view=calendar&range=week&date=${shiftKey(today, 2)}`);
    await page.getByTestId(`calendar-event-${t.id}`).click();
    const drawer = page.getByTestId("task-drawer");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await page.getByTestId(`calendar-event-${t.id}`).click();
    await drawer.getByTestId(`task-complete-${t.id}`).click();
    await expect(drawer).toContainText("Completed");
    const after = (await call<TaskRow[]>(page, "GET", `/tasks?assignedTo=${t.assignedTo}`)).json.find((x) => x.id === t.id)!;
    expect(after.status).toBe("completed");
  });

  test("view + date survive reload and back/forward", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    await page.goto("/my-work?view=calendar&range=month&date=2026-11-10");
    await page.reload();
    await expect(page.getByTestId("calendar-view")).toHaveAttribute("data-mode", "month");
    await expect(page.getByTestId("calendar-view")).toContainText("November 2026");
    await page.getByTestId("calendar-next").click();
    await expect(page).toHaveURL(/date=2026-12-10/);
    await page.goto("/patients");
    await page.goBack();
    await expect(page).toHaveURL(/view=calendar/);
    await expect(page.getByTestId("calendar-view")).toContainText("December 2026");
    await page.goForward();
    await expect(page).toHaveURL(/\/patients/);
  });

  test("a VIEW_TASKS-only Doctor gets a read-only board", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "DOCTOR");
    await page.goto("/my-work?view=board");
    await expect(page.getByTestId("kanban-board")).toHaveAttribute("data-readonly", "true");
    await expect(page.getByTestId("my-work-board-hint")).toBeVisible();
  });

  test("390px: calendar falls back to agenda, board scrolls inside its card, no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page);
    await page.goto("/my-work?view=calendar");
    await expect(page.getByTestId("calendar-view")).toHaveAttribute("data-mobile-fallback", "true");
    await expect(page.getByTestId("calendar-agenda")).toBeVisible();
    await noPageOverflow(page);
    await page.goto("/my-work?view=board");
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await noPageOverflow(page);
    await page.goto("/my-work");
    await noPageOverflow(page);
  });
});
