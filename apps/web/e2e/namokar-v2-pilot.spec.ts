import { expect, test, type Browser, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// Namokar V2 = the CLEAN pilot workspace. It must start with zero transactional rows, look ready (not broken) when empty,
// accept only appointments inside the clinic hours (server-side), and return to zero after the one QA record this spec makes.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const TZ = "Asia/Kolkata";
const MARKER = "QA V2 ";
const QA_NAME = `${MARKER}TEST - delete me`;
const QA_PHONE = "+919000000042"; // a reserved-looking fictional number

type Who = "frontdesk" | "shivani" | "sushil" | "doctor" | "admin";

async function login(page: Page, who: Who) {
  await page.goto("/login/namokar-v2");
  await page.getByLabel("Email address").fill(`namokarv2.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
async function as(browser: Browser, who: Who) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, who);
  return { page, context };
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

const v2Count = (table: string) => Number(sql(`SELECT count(*) FROM ${table} WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = 'namokar-v2')`));
/** The hospital-clock calendar day `days` from now, as YYYY-MM-DD and a short weekday. */
const dayAhead = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return { ymd: d.toLocaleDateString("en-CA", { timeZone: TZ }), wd: d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" }) };
};
const at = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`).toISOString();
const firstDay = (open: boolean) => [2, 3, 4, 5, 6, 7, 8, 9].map(dayAhead).find((d) => (d.wd !== "Sun") === open)!;

test.describe("Namokar V2 Pilot (clean workspace)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.beforeAll(() => purgePatients(MARKER));
  test.afterAll(() => purgePatients(MARKER));

  test("1. starts with zero transactional rows, no provider and no revenue", async () => {
    for (const table of ["patients", "journeys", "calls", "tasks", "appointments", "treatment_opportunities", "notifications", "timeline_events", "revenue_events", "connectors"]) {
      expect(v2Count(table), table).toBe(0);
    }
    expect(Number(sql(`SELECT count(*) FROM tenant_capabilities WHERE capability = 'REVENUE_TRACKING' AND enabled = false AND tenant_id = (SELECT id FROM tenants WHERE login_slug = 'namokar-v2')`))).toBe(1);
  });

  test("2. the empty Command Centre says the workspace is ready (no fake numbers, no demo patients)", async ({ browser }) => {
    const a = await as(browser, "admin");
    await a.page.goto("/command-centre");
    await expect(a.page.getByText("Your workspace is ready")).toBeVisible();
    await expect(a.page.getByText(/Rohan|Suresh Kulkarni|Rajan Pillai/)).toHaveCount(0);
    expect(await a.page.getByText("₹").count()).toBe(0);
    await a.context.close();
  });

  test("3. integrations read Not configured and nothing is falsely live", async ({ browser }) => {
    const a = await as(browser, "admin");
    await a.page.goto("/integrations");
    await expect(a.page.getByText(/not configured/i).first()).toBeVisible();
    await expect(a.page.getByText(/fixture/i)).toHaveCount(0);
    await expect(a.page.getByText(/^live$/i)).toHaveCount(0);
    await a.context.close();
  });

  test("4. first real lead: Front Desk creates a QA lead for Shivani, logs a call with feedback and a callback; Shivani sees it; cleanup returns V2 to zero", async ({ browser }) => {
    const fd = await as(browser, "frontdesk");
    const lk = (await api<{ branches: { id: string }[]; doctors: { id: string; name: string }[]; owners: { id: string; name: string }[] }>(fd.page, "GET", "/lookups")).body;
    expect(lk.branches).toHaveLength(1); // the one clinic
    expect(lk.doctors.map((d) => d.name)).toEqual(["Dr. Poonam Jain"]); // the one doctor
    expect(lk.owners.map((o) => o.name).sort()).toEqual(["Front Desk", "Shivani", "Sushil"]);
    const shivani = lk.owners.find((o) => o.name === "Shivani")!;

    const lead = await api<{ journeyId: string; patientId: string }>(fd.page, "POST", "/leads", { name: QA_NAME, phone: QA_PHONE, specialtyKey: "GENERAL_EYE_CONSULTATION", branchId: lk.branches[0]!.id, journeyType: "General Eye Consultation", source: "phone", sourceKey: "phone", ownerId: shivani.id, customFieldValues: {} });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    const callbackDue = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const call = await api(fd.page, "POST", `/journeys/${lead.body.journeyId}/calls`, { direction: "inbound", connected: true, staffFeedback: "QA: patient asked about a check-up and wants a call back tomorrow.", callback: { dueAt: callbackDue, note: "QA callback", assignedTo: shivani.id } });
    expect(call.status, JSON.stringify(call.body)).toBe(201);
    await fd.context.close();

    const sh = await as(browser, "shivani");
    await sh.page.goto("/my-work");
    await expect(sh.page.getByText(QA_NAME).first()).toBeVisible();
    // Leads -> the patient: the trail reads Leads > Patient > Service, and the record shows where they came from and who has them.
    await sh.page.goto("/leads?view=all");
    const row = sh.page.locator('[data-testid^="lead-row-"]').filter({ hasText: QA_NAME });
    await expect(row).toBeVisible();
    await row.click({ position: { x: 300, y: 10 } });
    await expect(sh.page.getByTestId("journey-detail")).toBeVisible();
    const crumbs = sh.page.getByTestId("breadcrumb");
    await expect(crumbs).toContainText("Leads");
    await expect(crumbs.getByTestId("breadcrumb-1")).toHaveText(QA_NAME);
    await expect(crumbs.getByTestId("breadcrumb-2")).toHaveText("General Eye Consultation");
    await expect(sh.page.getByTestId("journey-original-source")).toContainText("Phone");
    await expect(sh.page.getByTestId("journey-owner")).toContainText("Shivani");
    await expect(sh.page.getByText("Assigned Team Member").first()).toBeVisible();
    await expect(sh.page.getByTestId("journey-stage")).toBeVisible();
    await expect(sh.page.getByTestId("next-action-type")).toBeVisible(); // the callback just logged
    await expect(sh.page.getByTestId("journey-timeline")).toContainText(/call/i);
    await expect(sh.page.getByText(/revenue|₹/i)).toHaveCount(0);
    await sh.context.close();

    const su = await as(browser, "sushil");
    await su.page.goto("/my-work");
    await expect(su.page.getByText(QA_NAME)).toHaveCount(0); // Sushil has nothing assigned
    await su.context.close();

    purgePatients(MARKER);
    for (const table of ["patients", "journeys", "tasks", "calls", "timeline_events"]) expect(v2Count(table), table).toBe(0);
  });

  test("5. appointments: inside the clinic hours accepted, Sunday / 08:59 / 16:00 refused by the server even for a direct API call", async ({ browser }) => {
    const fd = await as(browser, "frontdesk");
    const lk = (await api<{ branches: { id: string }[]; doctors: { id: string }[]; clinicHours: Record<string, [string, string] | null> }>(fd.page, "GET", "/lookups")).body;
    expect(lk.clinicHours).toMatchObject({ mon: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null });
    const lead = await api<{ journeyId: string; patientId: string }>(fd.page, "POST", "/leads", { name: `${MARKER}hours`, phone: "+919000000043", specialtyKey: "GENERAL_EYE_CONSULTATION", branchId: lk.branches[0]!.id, journeyType: "General Eye Consultation", source: "phone", sourceKey: "phone", customFieldValues: {} });
    expect(lead.status).toBe(201);
    const book = (iso: string) => api<{ id?: string; error?: string }>(fd.page, "POST", "/appointments", { patientId: lead.body.patientId, journeyId: lead.body.journeyId, branchId: lk.branches[0]!.id, doctorId: lk.doctors[0]!.id, scheduledAt: iso, reason: "QA hours" });
    const open = firstDay(true);
    const closed = firstDay(false);
    for (const bad of [at(closed.ymd, "11:00"), at(open.ymd, "08:59"), at(open.ymd, "16:00"), at(open.ymd, "18:30")]) {
      const r = await book(bad);
      expect(r.status, bad).toBe(422);
      expect(r.body.error, bad).toBe("outside_clinic_hours");
    }
    expect(v2Count("appointments")).toBe(0);
    const ok = await book(at(open.ymd, "10:00"));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const first = await api(fd.page, "PATCH", `/appointments/${ok.body.id}/action`, { action: "confirm" });
    expect(first.status).toBe(200);
    // No WhatsApp is configured in V2: the visit stays confirmed, and nothing is ever recorded as sent.
    await expect.poll(() => Number(sql(`SELECT count(*) FROM notifications WHERE subject_id = '${ok.body.id}'`)), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => sql(`SELECT string_agg(DISTINCT status::text, ',') FROM notifications WHERE subject_id = '${ok.body.id}'`), { timeout: 60_000 }).toMatch(/BLOCKED/);
    expect(sql(`SELECT count(*) FROM notifications WHERE subject_id = '${ok.body.id}' AND status IN ('SENT','DELIVERED','READ')`)).toBe("0");
    expect(sql(`SELECT status FROM appointments WHERE id = '${ok.body.id}'`)).toBe("confirmed");
    await fd.context.close();
    purgePatients(MARKER);
    expect(v2Count("appointments")).toBe(0);
    expect(v2Count("patients")).toBe(0);
  });

  test("6. role smoke: the doctor lands on Doctor Home; the admin reaches Settings; front desk cannot change settings", async ({ browser }) => {
    const doc = await as(browser, "doctor");
    await expect(doc.page).toHaveURL(/doctor-home/);
    await expect(doc.page.getByText(/something went wrong|error/i)).toHaveCount(0);
    await doc.context.close();

    const ad = await as(browser, "admin");
    await ad.page.goto("/settings");
    await expect(ad.page.getByRole("heading", { name: /settings/i }).first()).toBeVisible();
    await ad.context.close();

    const fd = await as(browser, "frontdesk");
    expect((await api(fd.page, "PUT", "/clinic-hours", { clinicHours: null })).status).toBe(403);
    await fd.context.close();
  });
});
