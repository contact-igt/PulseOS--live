import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";
import { purgePatients, sql } from "./support/fixtures";

// M6.6 Leads: operational quick views, date + owner filters in hospital time, URL state, today strip, table columns.
// Fictional fixtures only ("E2E M66L …"), removed afterwards.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TZ = "Asia/Kolkata";
const RUN = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E M66L ${n} ${RUN}`;
const dayIST = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ api, method, path, body }) => {
      const res = await fetch(`${api}${path}`, { method, credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as never };
    },
    { api: API, method, path, body },
  );
}

const ids: Record<string, { journeyId: string; patientId: string }> = {};

test.describe("M6.6 — Leads operational views", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => purgePatients("E2E M66L "));

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, "eyev1.coordinator@pulseos.local");
    const lookups = (await api<{ branches: { id: string }[] }>(page, "GET", "/lookups")).body;
    const make = async (key: string, source: string) => {
      const res = await api<{ journeyId: string; patientId: string }>(page, "POST", "/leads", {
        name: NAME(key), phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0]!.id, sourceKey: source, journeyType: "Cataract",
      });
      expect(res.status).toBe(201);
      ids[key] = res.body;
    };
    await make("Fresh", "instagram");
    await make("Overdue", "google");
    await make("Visit", "walk_in");
    await make("Old", "google");
    await make("Next", "phone");
    // Age the older leads (hospital days), make one overdue, one visit today, one follow-up tomorrow.
    const at = (daysAgo: number, hh: number) => `(date '${dayIST(-daysAgo)}' + time '${String(hh).padStart(2, "0")}:00') AT TIME ZONE '${TZ}'`;
    const J = (k: string) => `'${ids[k]!.journeyId}'`;
    sql(`UPDATE journeys SET created_at = ${at(10, 11)}, stage = 'contacted', contacted_at = ${at(9, 10)} WHERE id = ${J("Overdue")}`);
    sql(`UPDATE journeys SET created_at = ${at(3, 11)}, stage = 'booked', contacted_at = ${at(2, 10)} WHERE id = ${J("Visit")}`);
    sql(`UPDATE journeys SET created_at = ${at(40, 11)} WHERE id = ${J("Old")}`);
    sql(`UPDATE journeys SET created_at = ${at(2, 11)}, stage = 'contacted', contacted_at = ${at(1, 10)} WHERE id = ${J("Next")}`);
    const task = (k: string, dueExpr: string) =>
      sql(`INSERT INTO tasks (tenant_id, patient_id, journey_id, type, due_at, status) SELECT tenant_id, id, ${J(k)}, 'CALLBACK', ${dueExpr}, 'pending' FROM patients WHERE id = '${ids[k]!.patientId}'`);
    task("Overdue", at(1, 12));
    task("Next", `(date '${dayIST(1)}' + time '11:00') AT TIME ZONE '${TZ}'`);
    sql(`INSERT INTO appointments (tenant_id, patient_id, journey_id, branch_id, doctor_user_id, status, scheduled_at, reason) SELECT p.tenant_id, p.id, ${J("Visit")}, '${lookups.branches[0]!.id}', (SELECT id FROM users WHERE tenant_id = p.tenant_id AND role = 'DOCTOR' LIMIT 1), 'scheduled', (date '${dayIST(0)}' + time '23:30') AT TIME ZONE '${TZ}', 'Consultation' FROM patients p WHERE p.id = '${ids["Visit"]!.patientId}'`);
    await page.close();
  });

  const mine = (page: Page) => page.locator('[data-testid^="lead-row-"]').filter({ hasText: `E2E M66L` });
  const visible = async (page: Page) => (await mine(page).allTextContents()).map((t) => /E2E M66L (\w+)/.exec(t)![1]!).sort();

  test("the views are filters over real data, each tab's count equals its rows, and the URL holds the view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();

    for (const [tab, expected] of [
      ["new_today", ["Fresh"]],
      ["uncontacted", ["Fresh", "Old"]],
      ["follow_up_due", ["Overdue"]],
      ["appointments_today", ["Visit"]],
      ["appointment_booked", ["Visit"]],
    ] as const) {
      await page.getByTestId(`leads-tab-${tab}`).click();
      await expect(page).toHaveURL(new RegExp(`view=${tab}`));
      await expect(page.getByTestId(`leads-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => visible(page), { message: tab }).toEqual(expect.arrayContaining(expected as unknown as string[]));
      // Count beside the tab == rows in the table (this hospital's whole list, not just my fixtures).
      const label = (await page.getByTestId(`leads-tab-${tab}`).textContent())!;
      const count = Number(/(\d+)\s*$/.exec(label)![1]);
      await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(count);
    }
    // "All" drops the param.
    await page.getByTestId("leads-tab-all").click();
    await expect(page).not.toHaveURL(/view=/);
  });

  test("date presets measure the enquiry date in hospital days and are stated on screen; refresh and back/forward keep them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads");
    await pickPeriod(page, "leads", "7d");
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByTestId("leads-date-context")).toContainText("Enquiry date");
    await expect.poll(() => visible(page)).toEqual(["Fresh", "Next", "Visit"]); // Overdue is 10 days old, Old 40
    await pickPeriod(page, "leads", "30d");
    await expect.poll(() => visible(page)).toEqual(["Fresh", "Next", "Overdue", "Visit"]);
    await pickPeriod(page, "leads", "today");
    await expect.poll(() => visible(page)).toEqual(["Fresh"]);

    // Custom: from/to inputs, inclusive.
    await pickPeriod(page, "leads", "custom");
    await setCustomRange(page, "leads", dayIST(-11), dayIST(-9));
    await expect(page).toHaveURL(new RegExp(`from=${dayIST(-11)}`));
    await expect.poll(() => visible(page)).toEqual(["Overdue"]);

    // Refresh keeps everything; navigating away and back restores it.
    await page.reload();
    await expectPeriod(page, "leads", "custom");
    await expect(page.getByTestId("leads-range-picker")).toHaveAttribute("data-from", dayIST(-11));
    await expect.poll(() => visible(page)).toEqual(["Overdue"]);
    await page.goto("/command-centre");
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`range=custom&from=${dayIST(-11)}|from=${dayIST(-11)}`));
    await expect.poll(() => visible(page)).toEqual(["Overdue"]);
    // An impossible custom range in the URL falls back to "any date" instead of breaking the page.
    await page.goto(`/leads?range=custom&from=${dayIST(0)}&to=${dayIST(-5)}`);
    await expectPeriod(page, "leads", "");
    await expect(page.getByTestId("leads-table-error")).toHaveCount(0);
  });

  test("Follow-up Due uses the follow-up's own date and can look ahead; today views fix their own date and say so", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads?view=follow_up_due&range=custom&from=" + dayIST(1) + "&to=" + dayIST(1));
    await expect(page.getByTestId("leads-date-context")).toContainText("Follow-up due date");
    await expect.poll(() => visible(page)).toEqual(["Next"]);
    for (const view of ["today", "new_today", "appointments_today"]) {
      await page.goto(`/leads?view=${view}&range=30d`);
      await expect(page.getByTestId("leads-date-context")).toContainText("Today");
      await expect(page.getByTestId("leads-range")).toBeDisabled();
    }
  });

  test("today strip: each value opens the matching list and equals what it shows", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-today-strip")).toBeVisible();
    for (const [cell, view, extra] of [
      ["today-appointments", "appointments_today", ""],
      ["today-follow-ups", "follow_up_due", ""],
      ["today-overdue", "follow_up_due", "overdue"],
      ["today-new", "new_today", ""],
    ] as const) {
      const n = Number(await page.getByTestId(`${cell}-count`).textContent());
      await page.getByTestId(cell).click();
      await expect(page).toHaveURL(new RegExp(`view=${view}`));
      if (extra) await expect(page).toHaveURL(/due=overdue/);
      if (n === 0) await expect(page.getByTestId("leads-empty")).toBeVisible();
      else await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(n);
    }
  });

  test("owner filter: All / Mine / Unassigned / a person, with counts that follow the other filters", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("owner-scope-all")).toHaveText(/All Team \(\d+\)/);
    const allLabel = (await page.getByTestId("owner-scope-all").textContent())!;
    await page.getByTestId("owner-scope-unassigned").click();
    await expect(page).toHaveURL(/owner=unassigned/);
    await expect(page.getByTestId("owner-scope-unassigned")).toHaveText(/Unassigned \(\d+\)/);
    const un = Number(/Unassigned \((\d+)\)/.exec((await page.getByTestId("owner-scope-unassigned").textContent())!)![1]);
    await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(un);
    await page.getByTestId("owner-scope-mine").click();
    await expect(page).toHaveURL(/owner=mine/);
    await expect(page.getByTestId("owner-scope-mine")).toHaveText(/Mine \(\d+\)/);
    const myCount = Number(/Mine \((\d+)\)/.exec((await page.getByTestId("owner-scope-mine").textContent())!)![1]);
    if (myCount > 0) await expect(page.locator('[data-testid^="lead-row-"]')).toHaveCount(myCount);
    // A source filter narrows the owner counts too, and shows as a removable chip.
    await page.getByTestId("owner-scope-all").click();
    await page.getByTestId("leads-source").selectOption("instagram");
    await expect(page).toHaveURL(/source=instagram/);
    await expect(page.getByTestId("leads-chips")).toContainText("Source: Instagram");
    await expect.poll(async () => Number(/All Team \((\d+)\)/.exec((await page.getByTestId("owner-scope-all").textContent())!)![1])).toBeLessThanOrEqual(Number(/(\d+)/.exec(allLabel)![1]));
    await page.getByTestId("leads-reset").click();
    await expect(page).not.toHaveURL(/source=/);
  });

  test("table: patient, enquiry, original source, status/outcome, owner, last interaction, next action, enquiry date + visit; the row opens the Journey", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads?range=30d");
    for (const h of ["Patient", "Enquiry", "Original source", "Journey status", "Outcome", "Team Member", "Created", "Appointment", "Last interaction", "Next action"]) await expect(page.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
    const overdue = page.getByTestId(`lead-row-${ids["Overdue"]!.journeyId}`);
    await expect(overdue.getByTestId(`lead-next-${ids["Overdue"]!.journeyId}`)).toContainText("Callback");
    await expect(overdue.getByTestId(`lead-next-${ids["Overdue"]!.journeyId}`)).toContainText(/overdue|ago/i);
    await expect(overdue).toContainText("Google");
    await expect(page.getByTestId(`lead-visit-${ids["Visit"]!.journeyId}`)).toBeVisible(); // Appointment column
    await overdue.click({ position: { x: 300, y: 10 } });
    await page.waitForURL(new RegExp(`/journeys/${ids["Overdue"]!.journeyId}`));
  });

  test("hospital time: a browser in Los Angeles still counts 'today' by the hospital's day", async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "eyev1.coordinator@pulseos.local");
    await page.goto("/leads?view=new_today");
    await expect.poll(() => visible(page)).toEqual(["Fresh"]);
    await expect(page.getByTestId("leads-date-context")).toContainText("Asia/Kolkata");
    await ctx.close();
  });

  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    test(`${vp.width}x${vp.height}: no page overflow; filters, tabs and today strip are reachable`, async ({ page }) => {
      await page.setViewportSize(vp);
      await login(page, "eyev1.coordinator@pulseos.local");
      await page.goto("/leads?range=30d");
      await expect(page.getByTestId("leads-filters")).toBeVisible();
      await expect(page.getByTestId("leads-today-strip")).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Lead views" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const strip = await page.getByRole("tablist", { name: "Lead views" }).evaluate((el) => el.scrollHeight <= el.clientHeight);
      expect(strip).toBe(true);
      if (vp.width < 768) for (const id of ["leads-range", "add-lead-button"]) expect((await page.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(40);
    });
  }
});
