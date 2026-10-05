import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { purgePatients } from "./support/fixtures";
import fs from "node:fs";
import path from "node:path";

// Appointments views: List (default) + Day / Week / Month calendar + Doctor Schedule.
// Mutating tests create their own appointments (unique "P1 View" patient names)
// on future days via the API and never depend on global demo counts.
//   SHOT_PHASE=before|after pnpm exec playwright test e2e/views-appointments.spec.ts

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";
const PHASE = process.env.SHOT_PHASE ?? "after";
const OUT = path.resolve(__dirname, "../../../review-artifacts/views/appointments");
const RUN = Date.now().toString(36);

async function devLogin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
  await page.waitForURL(/\/command-centre/);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}-${PHASE}.png`) });
}

/** Adds n days to a YYYY-MM-DD key (UTC-noon math, no local zone involved). */
function addDays(key: string, n: number) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD + IST wall time -> ISO instant. */
function istInstant(key: string, hhmm: string) {
  return new Date(`${key}T${hhmm}:00+05:30`).toISOString();
}

async function calendarContext(page: Page): Promise<{ timezone: string; today: string }> {
  const res = await page.request.get(`${API}/appointments/calendar-context`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Test appointments are parked after each test (moved to 3 Jan 2000 and cancelled) so live demo views stay clean. */
const created: string[] = [];
async function parkCreated(request: APIRequestContext) {
  for (const id of created.splice(0)) {
    await request.patch(`${API}/appointments/${id}/reschedule`, { data: { scheduledAt: "2000-01-03T04:30:00.000Z" } });
    await request.patch(`${API}/appointments/${id}/action`, { data: { action: "cancel" } });
  }
}

async function createAppointment(page: Page, name: string, scheduledAt: string, doctorIndex = 0): Promise<{ id: string; doctorId: string }> {
  const lookups = (await (await page.request.get(`${API}/lookups`)).json()) as { branches: { id: string }[]; doctors: { id: string }[] };
  const lead = await page.request.post(`${API}/leads`, {
    data: { name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0].id, source: "walk_in", journeyType: "Cataract" },
  });
  expect(lead.ok(), await lead.text()).toBeTruthy();
  const { patientId, journeyId } = (await lead.json()) as { patientId: string; journeyId: string };
  const doctorId = lookups.doctors[Math.min(doctorIndex, lookups.doctors.length - 1)].id;
  const res = await page.request.post(`${API}/appointments`, { data: { patientId, journeyId, branchId: lookups.branches[0].id, doctorId, scheduledAt } });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  created.push(id);
  return { id, doctorId };
}

async function idsOf(page: Page, prefix: string) {
  return page.locator(`[data-testid^="${prefix}"]`).evaluateAll((els, p) => els.map((e) => e.getAttribute("data-testid")!.slice(p.length)), prefix);
}

async function expectNoPageOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function expectNoOverlay(page: Page) {
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
}

test.describe("Appointments views", () => {
  // Fictional "P1 …" patients (and their journeys, appointments, tasks) are removed after the run.
  test.afterAll(() => purgePatients("P1 "));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.afterEach(async ({ page }) => parkCreated(page.request));

  test("every view renders the same appointments for the selected day (List, Day, Doctor Schedule) and Week/Month match the API range", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const { today } = await calendarContext(page);
    const day = addDays(today, 11);
    const a = await createAppointment(page, `P1 View Same ${RUN} A`, istInstant(day, "10:00"), 0);
    const b = await createAppointment(page, `P1 View Same ${RUN} B`, istInstant(day, "11:30"), 1);

    await page.goto(`/appointments?date=${day}`);
    await expect(page.getByTestId(`appointment-row-${a.id}`)).toBeVisible();
    const list = (await idsOf(page, "appointment-row-")).sort();
    expect(list).toEqual(expect.arrayContaining([a.id, b.id]));

    await page.goto(`/appointments?view=day&date=${day}`);
    await expect(page.getByTestId(`calendar-event-${a.id}`)).toBeVisible();
    expect((await idsOf(page, "calendar-event-")).sort()).toEqual(list);

    await page.goto(`/appointments?view=doctors&date=${day}`);
    await expect(page.getByTestId(`doctor-schedule-item-${a.id}`)).toBeVisible();
    expect((await idsOf(page, "doctor-schedule-item-")).sort()).toEqual(list);
    if (a.doctorId !== b.doctorId) {
      await expect(page.getByTestId(`doctor-schedule-column-${a.doctorId}`).getByTestId(`doctor-schedule-item-${a.id}`)).toBeVisible();
      await expect(page.getByTestId(`doctor-schedule-column-${b.doctorId}`).getByTestId(`doctor-schedule-item-${b.id}`)).toBeVisible();
    }

    for (const view of ["week", "month"] as const) {
      await page.goto(`/appointments?view=${view}&date=${day}`);
      await expect(page.getByTestId("calendar-view")).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (view === "week") await expect(page.getByTestId(`calendar-event-${a.id}`)).toBeVisible();
      const [from, to] = await page.getByTestId("appointments-view-" + view).evaluate((el) => [el.getAttribute("data-from"), el.getAttribute("data-to")]);
      const apiRows = (await (await page.request.get(`${API}/appointments?from=${from}&to=${to}`)).json()) as { id: string }[];
      const apiIds = apiRows.map((r) => r.id).sort();
      if (view === "week") {
        expect((await idsOf(page, "calendar-event-")).sort()).toEqual(apiIds);
      } else {
        // Month cells show 3 events then "+k more"; every cell announces its full count.
        const shown = await idsOf(page, "calendar-event-");
        expect(apiIds).toEqual(expect.arrayContaining(shown));
        const counts = await page.locator('[data-testid^="calendar-cell-"]').evaluateAll((els) => els.map((e) => Number(/(\d+) events?$/.exec(e.getAttribute("aria-label") ?? "")?.[1] ?? 0)));
        expect(counts.reduce((a, b) => a + b, 0)).toBe(apiIds.length);
      }
    }
  });

  test("view, date and filters live in the URL: reload and back/forward restore them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const { today } = await calendarContext(page);
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-view-list")).toBeVisible();

    await page.getByTestId("view-switch-week").click();
    await expect(page).toHaveURL(/view=week/);
    await page.getByTestId("calendar-next").click();
    const nextWeek = addDays(today, 7);
    await expect(page).toHaveURL(new RegExp(`date=${nextWeek}`));
    const doctorSelect = page.getByLabel("Doctor", { exact: true });
    const doctorId = await doctorSelect.locator("option").nth(1).getAttribute("value");
    await doctorSelect.selectOption(doctorId!);
    await expect(page).toHaveURL(new RegExp(`doctor=${doctorId}`));
    const title = await page.getByTestId("calendar-view").locator("h2").innerText();

    await page.reload();
    await expect(page.getByTestId("appointments-view-week")).toBeVisible();
    await expect(page.getByTestId("view-switch-week")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("calendar-view").locator("h2")).toHaveText(title);
    await expect(page.getByLabel("Doctor", { exact: true })).toHaveValue(doctorId!);

    await page.goto("/front-desk");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/view=week/);
    await expect(page.getByTestId("appointments-view-week")).toBeVisible();
    await expect(page.getByTestId("calendar-view").locator("h2")).toHaveText(title);
    await page.goForward();
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
  });

  test("an event opens the appointment drawer; a real action updates the calendar, a stale one shows an inline error (no overlay)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const { today } = await calendarContext(page);
    const day = addDays(today, 12);
    const appt = await createAppointment(page, `P1 View Action ${RUN}`, istInstant(day, "09:30"));
    expect((await page.request.patch(`${API}/appointments/${appt.id}/action`, { data: { action: "confirm" } })).ok()).toBeTruthy();

    await page.goto(`/appointments?view=day&date=${day}`);
    const event = page.getByTestId(`calendar-event-${appt.id}`);
    await expect(event).toHaveAttribute("aria-label", /Confirmed/);
    await event.click();
    const drawer = page.getByTestId("appointment-drawer");
    await expect(drawer).toContainText(`P1 View Action ${RUN}`);
    await drawer.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(event).toHaveAttribute("aria-label", /Waiting/); // Check in = arrived AND waiting
    await expect(event).toContainText("Waiting");

    // Stale drawer: someone else finishes the visit; our "Send to doctor" is now refused server-side.
    await event.click();
    await expect(drawer.getByRole("button", { name: "Send to doctor", exact: true })).toBeVisible();
    expect((await page.request.patch(`${API}/appointments/${appt.id}/action`, { data: { action: "send_to_doctor" } })).ok()).toBeTruthy();
    expect((await page.request.patch(`${API}/appointments/${appt.id}/complete`, { data: { next: { kind: "none" } } })).ok()).toBeTruthy();
    await drawer.getByRole("button", { name: "Send to doctor", exact: true }).click();
    await expect(page.getByTestId("appointments-action-error")).toContainText(/changed|not allowed|closed/i);
    await expect(event).toHaveAttribute("aria-label", /Completed/);
    await expectNoOverlay(page);
    expect(errors).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test.describe("hospital timezone (browser in Los Angeles)", () => {
    test.use({ timezoneId: "America/Los_Angeles" });

    test("an IST 00:15 appointment appears on its IST day in Day, Week and Month views", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await devLogin(page);
      const { today, timezone } = await calendarContext(page);
      expect(timezone).toBe("Asia/Kolkata");
      const day = addDays(today, 13);
      const appt = await createAppointment(page, `P1 View Midnight ${RUN}`, istInstant(day, "00:15"));
      // Sanity: the instant is on the previous UTC (and LA) date.
      expect(istInstant(day, "00:15").slice(0, 10)).toBe(addDays(day, -1));

      await page.goto(`/appointments?view=day&date=${day}`);
      await expect(page.getByTestId(`calendar-event-${appt.id}`)).toBeVisible();
      await expect(page.getByTestId(`calendar-event-${appt.id}`)).toHaveAttribute("aria-label", /12:15 am/);
      await page.goto(`/appointments?view=day&date=${addDays(day, -1)}`);
      await expect(page.getByTestId("appointments-view-day")).toBeVisible();
      await expect(page.getByTestId(`calendar-event-${appt.id}`)).toHaveCount(0);

      await page.goto(`/appointments?view=week&date=${day}`);
      // ICU versions differ on punctuation ("Thursday, 15 October 2026" vs "Thursday 15 October, 2026") — match the words.
      const parts = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", ...opts }).format(new Date(`${day}T12:00:00Z`));
      const dayLabel = new RegExp(`^${parts({ weekday: "long" })},? ${parts({ day: "numeric" })} ${parts({ month: "long" })},? ${parts({ year: "numeric" })}`);
      await expect(page.getByRole("group", { name: dayLabel }).getByTestId(`calendar-event-${appt.id}`)).toBeVisible();

      // Other runs may fill that month cell past its 3 visible events; the (URL) search filter applies to every view.
      await page.goto(`/appointments?view=month&date=${day}&q=${encodeURIComponent(`P1 View Midnight ${RUN}`)}`);
      await expect(page.getByTestId(`calendar-cell-${day}`).getByTestId(`calendar-event-${appt.id}`)).toBeVisible();

      await page.goto(`/appointments?view=doctors&date=${day}`);
      await expect(page.getByTestId(`doctor-schedule-item-${appt.id}`)).toContainText("12:15 am");
    });
  });

  test("390px: calendar views fall back to Agenda, Doctor Schedule stacks per doctor, no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const { today } = await calendarContext(page);
    const day = addDays(today, 14);
    const a = await createAppointment(page, `P1 View Mobile ${RUN} A`, istInstant(day, "10:00"), 0);
    const b = await createAppointment(page, `P1 View Mobile ${RUN} B`, istInstant(day, "10:30"), 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/appointments?date=${day}`);
    await expect(page.getByTestId(`appointment-row-${a.id}`)).toBeVisible();
    await expectNoPageOverflow(page);

    for (const view of ["day", "week", "month"]) {
      await page.goto(`/appointments?view=${view}&date=${day}`);
      const cal = page.getByTestId("calendar-view");
      await expect(cal).toHaveAttribute("data-mode", "agenda");
      await expect(cal).toHaveAttribute("data-mobile-fallback", "true");
      await expect(page.getByTestId(`calendar-event-${a.id}`)).toBeVisible();
      await expectNoPageOverflow(page);
    }

    await page.goto(`/appointments?view=doctors&date=${day}`);
    await expect(page.getByTestId("doctor-schedule-view")).toHaveAttribute("data-layout", "stacked");
    await expect(page.getByTestId(`doctor-schedule-item-${a.id}`)).toBeVisible();
    await expect(page.getByTestId(`doctor-schedule-item-${b.id}`)).toBeVisible();
    if (a.doctorId !== b.doctorId) {
      const first = await page.getByTestId(`doctor-schedule-column-${a.doctorId}`).boundingBox();
      const second = await page.getByTestId(`doctor-schedule-column-${b.doctorId}`).boundingBox();
      expect(Math.abs(first!.x - second!.x)).toBeLessThan(2);
    }
    await expectNoPageOverflow(page);
  });

  test("screenshots", async ({ page }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 1440) await devLogin(page);
      await page.goto("/appointments");
      await expect(page.getByTestId("appointments-page")).toBeVisible();
      await shot(page, `appointments-list-${width}`);
      if (PHASE !== "before") {
        for (const view of ["day", "week", "month", "doctors"]) {
          await page.goto(`/appointments?view=${view}`);
          await expect(page.getByTestId(`appointments-view-${view}`)).toBeVisible();
          await shot(page, `appointments-${view}-${width}`);
        }
      }
    }
  });
});
