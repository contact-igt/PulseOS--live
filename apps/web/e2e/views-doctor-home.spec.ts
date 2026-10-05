import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";
import fs from "node:fs";
import path from "node:path";

// Doctor Home views: default overview + Schedule (the doctor's own day, same data).
//   SHOT_PHASE=before|after pnpm exec playwright test e2e/views-doctor-home.spec.ts

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";
const PHASE = process.env.SHOT_PHASE ?? "after";
const OUT = path.resolve(__dirname, "../../../review-artifacts/views/doctor-home");
const RUN = Date.now().toString(36);

async function devLogin(page: Page, role: "DOCTOR" | "FRONT_DESK" = "DOCTOR") {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(role === "DOCTOR" ? /\/doctor-home/ : /\/front-desk/);
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

/**
 * Books an appointment for `doctorId` today at an IST wall time, as Front Desk (doctors cannot book).
 * The server refuses a time that has already passed, so a wall time earlier than now is booked for
 * tomorrow and then moved to today in the database — the doctor's own view of "this morning".
 */
async function bookForDoctor(browser: Browser, doctorId: string, name: string, hhmm: string): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await devLogin(page, "FRONT_DESK");
  const { today } = (await (await page.request.get(`${API}/appointments/calendar-context`)).json()) as { today: string };
  const lookups = (await (await page.request.get(`${API}/lookups`)).json()) as { branches: { id: string }[] };
  const lead = await page.request.post(`${API}/leads`, {
    data: { name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0].id, source: "walk_in", journeyType: "Cataract" },
  });
  expect(lead.ok(), await lead.text()).toBeTruthy();
  const { patientId, journeyId } = (await lead.json()) as { patientId: string; journeyId: string };
  const todayAt = new Date(`${today}T${hhmm}:00+05:30`);
  const inPast = todayAt.getTime() < Date.now();
  const bookedAt = inPast ? new Date(todayAt.getTime() + 86_400_000) : todayAt;
  const res = await page.request.post(`${API}/appointments`, {
    data: { patientId, journeyId, branchId: lookups.branches[0].id, doctorId, scheduledAt: bookedAt.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  if (inPast) sql(`UPDATE appointments SET scheduled_at = '${todayAt.toISOString()}' WHERE id = '${id}'`);
  created.push(id);
  await ctx.close();
  return id;
}

async function expectNoPageOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe("Doctor Home views", () => {
  // Fictional "P1 …" patients (and their journeys, appointments, tasks) are removed after the run.
  test.afterAll(() => purgePatients("P1 "));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  // Doctors cannot manage appointments, so parking goes through a Front Desk session.
  test.afterEach(async ({ browser }) => {
    if (created.length === 0) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await devLogin(page, "FRONT_DESK");
    await parkCreated(page.request);
    await ctx.close();
  });

  test.describe("browser in Los Angeles", () => {
    test.use({ timezoneId: "America/Los_Angeles" });

    test("Schedule shows exactly the doctor's own today queue, in hospital time (IST 00:15 is this morning)", async ({ page, browser }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await devLogin(page);
      const me = ((await (await page.request.get(`${API}/auth/session`)).json()) as { user: { id: string } }).user.id;
      const early = await bookForDoctor(browser, me, `P1 Schedule Early ${RUN}`, "00:15");

      await page.goto("/doctor-home");
      await expect(page.getByTestId("doctor-queue")).toContainText(`P1 Schedule Early ${RUN}`);
      const queueCount = await page.getByTestId("doctor-queue").locator("li").count();

      await page.getByTestId("view-switch-schedule").click();
      await expect(page).toHaveURL(/view=schedule/);
      const schedule = page.getByTestId("doctor-schedule");
      await expect(schedule).toBeVisible();
      await expect(schedule.locator('[data-testid^="doctor-schedule-item-"]')).toHaveCount(queueCount);
      const item = page.getByTestId(`doctor-schedule-item-${early}`);
      await expect(page.getByTestId("doctor-schedule-part-morning").getByTestId(`doctor-schedule-item-${early}`)).toBeVisible();
      await expect(item).toContainText("12:15 am");
      await expect(item).toContainText("Booked");
      // Row -> Patient 360, same as the queue.
      await expect(item.getByRole("link")).toHaveAttribute("href", /\/patients\/[0-9a-f-]{36}/);
    });
  });

  test("view lives in the URL: reload and back/forward restore it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    await page.goto("/doctor-home?view=schedule");
    await expect(page.getByTestId("doctor-schedule")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("doctor-schedule")).toBeVisible();
    await expect(page.getByTestId("view-switch-schedule")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("view-switch-overview").click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByTestId("doctor-queue")).toBeVisible();
    await page.getByTestId("view-switch-schedule").click();
    await expect(page).toHaveURL(/view=schedule/);
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("doctor-schedule")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("appointments-page")).toBeVisible();
  });

  test("390px: overview and Schedule have no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page);
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto("/doctor-home?view=schedule");
    await expect(page.getByTestId("doctor-schedule")).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test("screenshots", async ({ page }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 1440) await devLogin(page);
      await page.goto("/doctor-home");
      await expect(page.getByTestId("doctor-home")).toBeVisible();
      await shot(page, `doctor-home-overview-${width}`);
      if (PHASE !== "before") {
        await page.goto("/doctor-home?view=schedule");
        await expect(page.getByTestId("doctor-schedule")).toBeVisible();
        await shot(page, `doctor-home-schedule-${width}`);
      }
    }
  });
});
