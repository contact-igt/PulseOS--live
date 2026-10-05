import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { purgePatients } from "./support/fixtures";
import fs from "node:fs";
import path from "node:path";

// Front Desk views: Queue (default) + Today flow (time-ordered, grouped by arrival state).
// Mutating tests create their own appointments for today (unique "P1 Flow" names).
//   SHOT_PHASE=before|after pnpm exec playwright test e2e/views-front-desk.spec.ts

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";
const PHASE = process.env.SHOT_PHASE ?? "after";
const OUT = path.resolve(__dirname, "../../../review-artifacts/views/front-desk");
const RUN = Date.now().toString(36);

async function devLogin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId("dev-login-role-FRONT_DESK").click();
  await page.waitForURL(/\/front-desk/);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}-${PHASE}.png`) });
}

/** Test appointments are parked after each test (moved to 3 Jan 2000 and cancelled) so live demo views stay clean. */
const created: string[] = [];
async function parkCreated(request: APIRequestContext) {
  for (const id of created.splice(0)) {
    await request.patch(`${API}/appointments/${id}/reschedule`, { data: { scheduledAt: "2000-01-03T04:30:00.000Z" } });
    await request.patch(`${API}/appointments/${id}/action`, { data: { action: "cancel" } });
  }
}

let bookings = 0;
async function createTodayAppointment(page: Page, name: string, wanted: string): Promise<string> {
  // "Later today" must still be later when the suite runs in the evening: never book a time that has already passed.
  // Each booking gets its own minute (the same doctor cannot be in two places), so three specs never collide.
  const soon = new Date(Date.now() + (5 + 3 * bookings++) * 60_000).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const hhmm = wanted > soon ? wanted : soon;
  test.skip(hhmm > "23:55", "no time left in the hospital's day to book a visit for later today");
  const { today } = (await (await page.request.get(`${API}/appointments/calendar-context`)).json()) as { today: string };
  const lookups = (await (await page.request.get(`${API}/lookups`)).json()) as { branches: { id: string }[]; doctors: { id: string }[] };
  const lead = await page.request.post(`${API}/leads`, {
    data: { name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0].id, source: "walk_in", journeyType: "Cataract" },
  });
  expect(lead.ok(), await lead.text()).toBeTruthy();
  const { patientId, journeyId } = (await lead.json()) as { patientId: string; journeyId: string };
  const res = await page.request.post(`${API}/appointments`, {
    data: { patientId, journeyId, branchId: lookups.branches[0].id, doctorId: lookups.doctors[0].id, scheduledAt: new Date(`${today}T${hhmm}:00+05:30`).toISOString() },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  created.push(id);
  return id;
}

async function idsOf(page: Page, scope: string, prefix: string) {
  return page.getByTestId(scope).locator(`[data-testid^="${prefix}"]`).evaluateAll((els, p) => els.map((e) => e.getAttribute("data-testid")!.slice(p.length)), prefix);
}

async function expectNoPageOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe("Front Desk views", () => {
  // Fictional "P1 …" patients (and their journeys, appointments, tasks) are removed after the run.
  test.afterAll(() => purgePatients("P1 "));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.afterEach(async ({ page }) => parkCreated(page.request));

  test("Today flow shows exactly the queue's today appointments, grouped by arrival state", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const id = await createTodayAppointment(page, `P1 Flow Same ${RUN}`, "23:00");

    await page.goto("/front-desk");
    await expect(page.getByTestId(`appointment-row-${id}`).first()).toBeVisible();
    const queue = (await idsOf(page, "front-desk-today", "appointment-row-")).sort();
    expect(queue).toContain(id);

    await page.getByTestId("view-switch-flow").click();
    await expect(page).toHaveURL(/view=flow/);
    await expect(page.getByTestId("front-desk-flow")).toBeVisible();
    expect((await idsOf(page, "front-desk-flow", "front-desk-flow-item-")).sort()).toEqual(queue);
    await expect(page.getByTestId("front-desk-flow-group-expected").getByTestId(`front-desk-flow-item-${id}`)).toContainText("Booked");
  });

  test("view and search live in the URL: reload and back/forward restore them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const id = await createTodayAppointment(page, `P1 Flow Url ${RUN}`, "22:30");
    await page.goto("/front-desk?view=flow");
    await expect(page.getByTestId("front-desk-flow")).toBeVisible();
    await page.getByTestId("front-desk-search").fill(`P1 Flow Url ${RUN}`);
    await expect(page).toHaveURL(/q=P1/);
    await expect(page.locator('[data-testid^="front-desk-flow-item-"]')).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId("front-desk-flow")).toBeVisible();
    await expect(page.getByTestId("front-desk-search")).toHaveValue(`P1 Flow Url ${RUN}`);
    await expect(page.locator('[data-testid^="front-desk-flow-item-"]')).toHaveCount(1);
    await expect(page.getByTestId(`front-desk-flow-item-${id}`)).toBeVisible();

    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("front-desk-flow")).toBeVisible();
    await expect(page.getByTestId(`front-desk-flow-item-${id}`)).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("appointments-page")).toBeVisible();
  });

  test("check-in from the Today flow works as before; a stale action shows an inline error, no overlay", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const id = await createTodayAppointment(page, `P1 Flow Action ${RUN}`, "21:45");
    expect((await page.request.patch(`${API}/appointments/${id}/action`, { data: { action: "confirm" } })).ok()).toBeTruthy();

    await page.goto("/front-desk?view=flow");
    const item = page.getByTestId(`front-desk-flow-item-${id}`);
    await expect(page.getByTestId("front-desk-flow-group-expected").getByTestId(`front-desk-flow-item-${id}`)).toBeVisible();
    await item.click();
    const drawer = page.getByTestId("appointment-drawer");
    await drawer.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId("front-desk-flow-group-arrived").getByTestId(`front-desk-flow-item-${id}`)).toContainText("Waiting"); // Check in = arrived AND waiting

    // The Queue view shows the same new state (same data).
    await page.getByTestId("view-switch-queue").click();
    await expect(page.getByTestId("front-desk-today").getByTestId(`appointment-row-${id}`)).toContainText("Waiting");

    // Stale: the visit is finished elsewhere, then our Send to doctor is rejected by the server.
    await page.getByTestId("view-switch-flow").click();
    await item.click();
    await expect(drawer.getByRole("button", { name: "Send to doctor", exact: true })).toBeVisible();
    expect((await page.request.patch(`${API}/appointments/${id}/action`, { data: { action: "send_to_doctor" } })).ok()).toBeTruthy();
    expect((await page.request.patch(`${API}/appointments/${id}/complete`, { data: { next: { kind: "none" } } })).ok()).toBeTruthy();
    await drawer.getByRole("button", { name: "Send to doctor", exact: true }).click();
    await expect(page.getByTestId("front-desk-action-error")).toContainText(/changed|not allowed|closed/i);
    await expect(item).toContainText("Completed");
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("390px: queue and Today flow have no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page);
    await page.goto("/front-desk");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto("/front-desk?view=flow");
    await expect(page.getByTestId("front-desk-flow")).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test("screenshots", async ({ page }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 1440) await devLogin(page);
      await page.goto("/front-desk");
      await expect(page.getByTestId("front-desk-page")).toBeVisible();
      await shot(page, `front-desk-queue-${width}`);
      if (PHASE !== "before") {
        await page.goto("/front-desk?view=flow");
        await expect(page.getByTestId("front-desk-flow")).toBeVisible();
        await shot(page, `front-desk-flow-${width}`);
      }
    }
  });
});
