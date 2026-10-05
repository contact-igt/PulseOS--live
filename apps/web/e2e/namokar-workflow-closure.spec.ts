import { expect, test, type Browser, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// Configurable workflow, closed end to end - on the shared product, in BOTH Namokar workspaces:
//   1. Settings → CRM Fields decides what Add Lead asks (tenant-scoped; V1 and V2 never leak into each other).
//   2. One Log Call save: feedback + next action "Book appointment" + date/time + "confirmed with patient".
//      The Journey, Front Desk and Doctor Planner all show the visit; the timeline keeps call / booked / confirmed as separate events.
//   3. Clinic Hours (Settings) are the single source: booking, the Log Call form and the Doctor Planner follow a change at once.
// Everything this spec writes is marker-named and removed afterwards; V2 returns to zero rows and its configuration is restored.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const TZ = "Asia/Kolkata";
const MARKER = "QA V2 ";
const V1 = "namokar-v1";
const V2 = "namokar-v2";

type Workspace = { slug: string; prefix: string };
const WS: Record<"v1" | "v2", Workspace> = { v1: { slug: V1, prefix: "namokar" }, v2: { slug: V2, prefix: "namokarv2" } };

async function login(page: Page, ws: Workspace, who: string) {
  await page.goto(`/login/${ws.slug}`);
  await page.getByLabel("Email address").fill(`${ws.prefix}.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
async function as(browser: Browser, ws: Workspace, who: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, ws, who);
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

const dayAhead = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return { ymd: d.toLocaleDateString("en-CA", { timeZone: TZ }), wd: d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" }) };
};
const openDay = () => [3, 4, 5, 6, 7, 8, 9].map(dayAhead).find((d) => d.wd !== "Sun")!;
const nextSaturday = () => [2, 3, 4, 5, 6, 7, 8, 9].map(dayAhead).find((d) => d.wd === "Sat")!;
const v2Count = (table: string) => Number(sql(`SELECT count(*) FROM ${table} WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2}')`));
const DIABETES_PLACEMENTS = (slug: string) => sql(`SELECT d.placements::text FROM custom_field_definitions d JOIN tenants t ON t.id = d.tenant_id WHERE t.login_slug = '${slug}' AND d.label = 'Diabetes' AND d.specialty_key = 'CATARACT' AND d.archived = false LIMIT 1`);

async function openAddLeadFor(page: Page, service: string) {
  await page.goto("/leads");
  await page.getByRole("button", { name: /add lead/i }).first().click();
  // The configured questions are fetched when the service is chosen: wait for them before looking.
  const loaded = page.waitForResponse((r) => /\/specialties\/[^/]+\/fields$/.test(r.url()) && r.status() === 200);
  await page.getByLabel("Service / enquiry").selectOption({ label: service });
  await loaded;
  await expect(page.getByTestId("lead-phone-input")).toBeVisible();
}
const diabetesQuestion = (page: Page) => page.locator("label", { hasText: /^\s*Diabetes\s*\*?\s*$/ });

test.describe("Namokar workflow: configurable fields, one-save call + appointment, clinic hours", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.beforeAll(() => purgePatients(MARKER));
  // V2 is configuration only: the configuration changes this spec makes are logged by the product; remove those log lines too.
  const cleanV2 = () => {
    purgePatients(MARKER);
    sql(`DELETE FROM activity_log WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2}')`);
  };
  test.afterAll(cleanV2);

  test("1. Settings → CRM Fields: 'On Add Lead' adds and removes a question at once, per workspace; history is untouched", async ({ browser }) => {
    expect(DIABETES_PLACEMENTS(V2)).not.toContain("add_lead"); // Namokar's first entry stays short
    expect(DIABETES_PLACEMENTS(V1)).not.toContain("add_lead");

    const admin = await as(browser, WS.v2, "superadmin");
    try {
      // Not asked on Add Lead to begin with.
      await openAddLeadFor(admin.page, "Cataract");
      await expect(diabetesQuestion(admin.page)).toHaveCount(0);

      // Switch it on in Settings.
      await admin.page.goto("/settings?section=fields");
      const toggle = admin.page.getByRole("checkbox", { name: 'Show "Diabetes" on Add Lead' });
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      await expect.poll(() => DIABETES_PLACEMENTS(V2)).toContain("add_lead");
      await expect(admin.page.getByText(/Diabetes/).first()).toBeVisible();

      // The very next Add Lead asks it - no redeploy, no new login, no seed.
      await openAddLeadFor(admin.page, "Cataract");
      await expect(diabetesQuestion(admin.page)).toHaveCount(1);

      // ...and the other workspace is untouched.
      const v1 = await as(browser, WS.v1, "admin");
      await openAddLeadFor(v1.page, "Cataract");
      await expect(diabetesQuestion(v1.page)).toHaveCount(0);
      expect(DIABETES_PLACEMENTS(V1)).not.toContain("add_lead");
      await v1.context.close();

      // Switch it off again: gone from Add Lead at once. Nothing recorded is deleted.
      await admin.page.goto("/settings?section=fields");
      await admin.page.getByRole("checkbox", { name: 'Show "Diabetes" on Add Lead' }).uncheck();
      await expect.poll(() => DIABETES_PLACEMENTS(V2)).not.toContain("add_lead");
      expect(DIABETES_PLACEMENTS(V2)).toContain("journey_detail"); // still on the journey and the patient record
      await openAddLeadFor(admin.page, "Cataract");
      await expect(diabetesQuestion(admin.page)).toHaveCount(0);
    } finally {
      sql(`UPDATE custom_field_definitions SET placements = (SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(placements) p WHERE p <> '"add_lead"'::jsonb) WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2}')`);
      await admin.context.close();
    }
  });

  test("2. one Log Call save: feedback, Book appointment, date, time, confirmed → Journey, Front Desk and Doctor Planner all show it", async ({ browser }) => {
    const fd = await as(browser, WS.v2, "frontdesk");
    try {
      const lk = (await api<{ branches: { id: string }[]; doctors: { id: string; name: string }[] }>(fd.page, "GET", "/lookups")).body;
      const lead = await api<{ journeyId: string; patientId: string }>(fd.page, "POST", "/leads", { name: `${MARKER}Call Book`, phone: "+919000000051", specialtyKey: "CATARACT", branchId: lk.branches[0]!.id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: {} });
      expect(lead.status).toBe(201);
      const day = openDay();

      await fd.page.goto(`/journeys/${lead.body.journeyId}`);
      await fd.page.getByRole("button", { name: "Log call" }).first().click();
      const sheet = fd.page.getByTestId("log-call");
      await sheet.getByTestId("log-call-feedback").fill("Patient wants a cataract consultation.");
      await sheet.getByTestId("log-call-next-appointment").click();
      // Namokar has one doctor and one branch: nothing to choose, so neither is asked.
      await expect(sheet.getByTestId("log-call-appt-doctor")).toHaveCount(0);
      await expect(sheet.getByTestId("log-call-appt-branch")).toHaveCount(0);
      await expect(sheet.getByTestId("log-call-appt-hours")).toContainText("Clinic hours");

      // A time outside the clinic hours is refused on the spot, and nothing the person typed is lost.
      await sheet.getByTestId("log-call-appt-date").fill(day.ymd);
      await sheet.getByTestId("log-call-appt-time").fill("18:00");
      await sheet.getByTestId("log-call-save").click();
      await expect(sheet.getByTestId("log-call-error")).toContainText(/09:00 and 16:00|clinic hours/i);
      await expect(sheet.getByTestId("log-call-feedback")).toHaveValue("Patient wants a cataract consultation.");
      expect(v2Count("appointments")).toBe(0);
      expect(v2Count("calls")).toBe(0);

      // Fix the time and save once: confirmed with the patient (on by default).
      await sheet.getByTestId("log-call-appt-time").fill("10:30");
      await expect(sheet.getByTestId("log-call-appt-confirmed")).toBeChecked();
      await expect(sheet.getByTestId("log-call-save")).toHaveText("Save call & confirm appointment");
      await sheet.getByTestId("log-call-save").dblclick(); // a double tap must not book twice
      await expect(sheet).toHaveCount(0);

      // The Journey updates without a reload.
      await expect(fd.page.getByTestId("journey-timeline")).toContainText("Incoming call");
      await expect(fd.page.getByTestId("journey-timeline")).toContainText("Appointment booked");
      await expect(fd.page.getByTestId("journey-timeline")).toContainText("Appointment confirmed");
      await expect(fd.page.getByTestId("next-action-visit")).toContainText("Patient visit");
      await expect(fd.page.getByText("Appointment confirmed").first()).toBeVisible();

      expect(v2Count("calls")).toBe(1);
      expect(v2Count("appointments")).toBe(1);
      expect(sql(`SELECT status FROM appointments WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2}')`)).toBe("confirmed");
      expect(v2Count("tasks")).toBe(0); // the visit is the follow-up: nothing extra lands in My Work

      // Front Desk, on that day.
      await fd.page.goto(`/front-desk?date=${day.ymd}`);
      await expect(fd.page.getByText(`${MARKER}Call Book`).first()).toBeVisible();
      // Doctor Planner, same day, same visit, same status.
      await fd.page.goto(`/appointments?view=doctors&date=${day.ymd}`);
      const planner = fd.page.getByTestId("doctor-schedule-view");
      await expect(planner).toContainText(`${MARKER}Call Book`);
      await expect(planner).toContainText("Dr. Poonam Jain");
      await expect(planner).toContainText("Confirmed");
      await expect(planner.getByTestId("doctor-schedule-hours")).toContainText("Clinic hours");

      // The confirmation message is planned; with no provider it is Blocked, never Sent.
      await expect.poll(() => Number(sql(`SELECT count(*) FROM notifications WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2}')`)), { timeout: 20_000 }).toBeGreaterThan(0);
      expect(sql(`SELECT count(*) FROM notifications WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2}') AND status IN ('SENT','DELIVERED','READ')`)).toBe("0");

      // Planner date controls.
      await planner.getByTestId("doctor-schedule-next").click();
      await expect(planner).not.toContainText(`${MARKER}Call Book`);
      await planner.getByRole("button", { name: "Go to today" }).click();
      await planner.getByTestId("doctor-schedule-date").fill(day.ymd);
      await expect(planner).toContainText(`${MARKER}Call Book`);
    } finally {
      purgePatients(MARKER);
      await fd.context.close();
    }
    for (const table of ["patients", "journeys", "calls", "tasks", "appointments", "notifications", "timeline_events"]) expect(v2Count(table), table).toBe(0);
  });

  test("3. Clinic Hours is the single source: a change in Settings reaches booking, the Log Call form and the Doctor Planner; the other workspace is unaffected", async ({ browser }) => {
    const sat = nextSaturday();
    const owner = await as(browser, WS.v2, "superadmin");
    const original = (await api<{ clinicHours: Record<string, [string, string] | null> }>(owner.page, "GET", "/lookups")).body.clinicHours;
    try {
      expect(original.sat).toEqual(["09:00", "16:00"]);
      await owner.page.goto("/settings?section=hours");
      await owner.page.getByTestId("hours-to-sat").fill("13:00");
      await owner.page.getByTestId("clinic-hours-save").click();
      await expect(owner.page.getByTestId("clinic-hours-saved")).toBeVisible();

      // Doctor Planner reads the new hours.
      await owner.page.goto(`/appointments?view=doctors&date=${sat.ymd}`);
      await expect(owner.page.getByTestId("doctor-schedule-hours")).toHaveText("Clinic hours 09:00–13:00");

      // Booking enforces them, even for a direct call.
      const lk = (await api<{ branches: { id: string }[]; doctors: { id: string }[] }>(owner.page, "GET", "/lookups")).body;
      const lead = await api<{ journeyId: string; patientId: string }>(owner.page, "POST", "/leads", { name: `${MARKER}Hours`, phone: "+919000000052", specialtyKey: "CATARACT", branchId: lk.branches[0]!.id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: {} });
      const refused = await api<{ error: string }>(owner.page, "POST", "/appointments", { patientId: lead.body.patientId, journeyId: lead.body.journeyId, branchId: lk.branches[0]!.id, doctorId: lk.doctors[0]!.id, scheduledAt: `${sat.ymd}T14:00:00+05:30`, reason: "QA hours" });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe("outside_clinic_hours");
      const slot = await api<{ outsideHours: boolean; available: boolean }>(owner.page, "GET", `/appointments/slot-check?doctorId=${lk.doctors[0]!.id}&scheduledAt=${encodeURIComponent(`${sat.ymd}T14:00`)}`);
      expect(slot.body).toMatchObject({ outsideHours: true, available: false });

      // The Log Call form says so too (same configuration, no copy).
      await owner.page.goto(`/journeys/${lead.body.journeyId}`);
      await owner.page.getByRole("button", { name: "Log call" }).first().click();
      const sheet = owner.page.getByTestId("log-call");
      await sheet.getByTestId("log-call-next-appointment").click();
      await sheet.getByTestId("log-call-appt-date").fill(sat.ymd);
      await sheet.getByTestId("log-call-appt-time").fill("14:00");
      await sheet.getByTestId("log-call-save").click();
      await expect(sheet.getByTestId("log-call-error")).toContainText("09:00 and 13:00");
      await sheet.getByTestId("log-call-appt-time").fill("12:30");
      await sheet.getByTestId("log-call-save").click();
      await expect(sheet).toHaveCount(0);
      expect(v2Count("appointments")).toBe(1);

      // V1 keeps its own Saturday.
      const v1 = await as(browser, WS.v1, "admin");
      await v1.page.goto(`/appointments?view=doctors&date=${sat.ymd}`);
      await expect(v1.page.getByTestId("doctor-schedule-hours")).toHaveText("Clinic hours 09:00–16:00");
      await v1.context.close();
    } finally {
      await api(owner.page, "PUT", "/clinic-hours", { clinicHours: original });
      purgePatients(MARKER);
      await owner.context.close();
    }
    expect(sql(`SELECT clinic_hours->'sat'::text FROM tenants WHERE login_slug = '${V2}'`)).toBe('["09:00", "16:00"]');
    for (const table of ["patients", "journeys", "calls", "tasks", "appointments", "notifications", "timeline_events"]) expect(v2Count(table), table).toBe(0);
  });
});
