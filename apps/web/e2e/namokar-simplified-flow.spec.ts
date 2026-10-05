import { expect, test, type Browser, type Page } from "@playwright/test";
import { purgeCrmFields, purgePatients, sql } from "./support/fixtures";

// Fewer clicks, same canonical states - in BOTH Namokar workspaces:
//   appointment day = Check in (arrived AND waiting) -> Send to doctor -> Consultation done;
//   Log outcome on a follow-up books the visit in the same save;
//   a new custom field reaches Add Lead (and leaves it) from Settings, per workspace;
//   Settings tabs can be scrolled with a plain mouse. Everything written here is removed afterwards.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const TZ = "Asia/Kolkata";
const MARKER = "QA V2 ";
const FIELD_PREFIX = "qa_pref_lang";
const V1 = { slug: "namokar-v1", prefix: "namokar" };
const V2 = { slug: "namokar-v2", prefix: "namokarv2" };

async function login(page: Page, ws: { slug: string; prefix: string }, who: string) {
  await page.goto(`/login/${ws.slug}`);
  await page.getByLabel("Email address").fill(`${ws.prefix}.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
async function as(browser: Browser, ws: { slug: string; prefix: string }, who: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
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
const openDay = (from = 3) => [from, from + 1, from + 2, from + 3, from + 4, from + 5, from + 6].map(dayAhead).find((d) => d.wd !== "Sun")!;
const at = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`).toISOString();
const v2Count = (table: string) => Number(sql(`SELECT count(*) FROM ${table} WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}')`));
const cleanV2 = () => {
  purgePatients(MARKER);
  purgeCrmFields(FIELD_PREFIX);
  sql(`DELETE FROM activity_log WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}')`);
};

type Lookups = { branches: { id: string }[]; doctors: { id: string }[] };
async function newLead(page: Page, name: string, phone: string) {
  const lk = (await api<Lookups>(page, "GET", "/lookups")).body;
  const lead = await api<{ journeyId: string; patientId: string }>(page, "POST", "/leads", { name: `${MARKER}${name}`, phone, specialtyKey: "CATARACT", branchId: lk.branches[0]!.id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: {} });
  expect(lead.status).toBe(201);
  return { ...lead.body, lk };
}

test.describe("Namokar simplified workflow", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.beforeAll(cleanV2);
  test.afterAll(cleanV2);

  test("1. the journey starts with ONE clear 'Lead created' line: source, service and who looks after it", async ({ browser }) => {
    const fd = await as(browser, V2, "frontdesk");
    try {
      const lead = await newLead(fd.page, "Creation", "+919000000061");
      await fd.page.goto(`/journeys/${lead.journeyId}`);
      const timeline = fd.page.getByTestId("journey-timeline");
      await expect(timeline).toContainText("Lead created — Cataract");
      await expect(timeline).toContainText("Source: Phone");
      expect(Number(sql(`SELECT count(*) FROM timeline_events WHERE journey_id = '${lead.journeyId}' AND event_type = 'lead_created'`))).toBe(1);
      await expect(timeline.getByText(/Lead created/)).toHaveCount(1); // no second "Journey created / Enquiry created" copy
    } finally {
      await fd.context.close();
    }
  });

  test("2. appointment day is three steps: Check in (-> Waiting with the time waited) -> Send to doctor -> Consultation done", async ({ browser }) => {
    const fd = await as(browser, V2, "frontdesk");
    try {
      const lead = await newLead(fd.page, "Queue", "+919000000062");
      const day = openDay();
      const booked = await api<{ id: string }>(fd.page, "POST", "/appointments", { patientId: lead.patientId, journeyId: lead.journeyId, branchId: lead.lk.branches[0]!.id, doctorId: lead.lk.doctors[0]!.id, scheduledAt: at(day.ymd, "10:00"), reason: "Consultation" });
      expect(booked.status).toBe(201);
      expect((await api(fd.page, "PATCH", `/appointments/${booked.body.id}/action`, { action: "confirm" })).status).toBe(200);

      await fd.page.goto(`/journeys/${lead.journeyId}`);
      const primary = fd.page.getByTestId("appointment-context-primary");
      await expect(primary).toHaveText("Check in");
      await primary.click(); // ONE click: arrived and waiting
      await expect(primary).toHaveText("Send to doctor");
      expect(sql(`SELECT status FROM appointments WHERE id = '${booked.body.id}'`)).toBe("waiting");
      expect(sql(`SELECT checked_in_at = waiting_started_at FROM appointments WHERE id = '${booked.body.id}'`)).toBe("t");
      await expect(fd.page.getByTestId("journey-timeline")).toContainText(/checked in · waiting/i);

      // The Doctor Planner shows Waiting with how long.
      await fd.page.goto(`/appointments?view=doctors&date=${day.ymd}`);
      await expect(fd.page.getByTestId("doctor-schedule-view")).toContainText(/Waiting · \d+ min/);

      await fd.page.goto(`/journeys/${lead.journeyId}`);
      await fd.page.getByTestId("appointment-context-primary").click(); // Send to doctor
      await expect(fd.page.getByTestId("appointment-context-primary")).toHaveText("Consultation done");
      expect(sql(`SELECT status FROM appointments WHERE id = '${booked.body.id}'`)).toBe("with_doctor");

      await fd.page.getByTestId("appointment-context-primary").click(); // Consultation done
      const sheet = fd.page.getByTestId("complete-consultation");
      await expect(sheet).toBeVisible();
      await sheet.getByTestId("complete-next-none").check();
      await sheet.getByTestId("complete-consultation-save").click();
      await expect(sheet).toHaveCount(0);
      expect(sql(`SELECT status FROM appointments WHERE id = '${booked.body.id}'`)).toBe("completed");
      // The timeline has the meaningful steps, not the internal ones.
      const lines = sql(`SELECT string_agg(event_type, ',' ORDER BY occurred_at) FROM timeline_events WHERE journey_id = '${lead.journeyId}'`);
      expect(lines).toContain("appointment_checked_in");
      expect(lines).not.toContain("appointment_waiting");
    } finally {
      await fd.context.close();
    }
  });

  test("3. Log outcome on a follow-up books the visit in the same save (confirmed): no second form, no extra follow-up task", async ({ browser }) => {
    const fd = await as(browser, V2, "frontdesk");
    try {
      const lead = await newLead(fd.page, "Outcome Book", "+919000000063");
      const day = openDay(4);
      await fd.page.goto(`/journeys/${lead.journeyId}`);
      await fd.page.getByTestId("journey-log-outcome").click();
      const sheet = fd.page.getByTestId("log-outcome");
      await sheet.getByTestId("log-outcome-choice-interested").click();
      await sheet.getByTestId("log-outcome-note").fill("Patient called back and confirmed consultation.");
      await sheet.getByTestId("log-outcome-book").check();
      await expect(sheet.getByTestId("log-outcome-appt-doctor")).toHaveCount(0); // one doctor, one branch: not asked
      // Outside the clinic hours: refused on the spot, nothing lost.
      await sheet.getByTestId("log-outcome-appt-date").fill(day.ymd);
      await sheet.getByTestId("log-outcome-appt-time").fill("18:00");
      await sheet.getByTestId("log-outcome-save").click();
      await expect(sheet.getByTestId("log-outcome-error")).toContainText(/clinic hours|between/i);
      await expect(sheet.getByTestId("log-outcome-note")).toHaveValue("Patient called back and confirmed consultation.");
      expect(sql(`SELECT count(*) FROM appointments WHERE journey_id = '${lead.journeyId}'`)).toBe("0");

      await sheet.getByTestId("log-outcome-appt-time").fill("11:30");
      await expect(sheet.getByTestId("log-outcome-save")).toHaveText("Save outcome & confirm appointment");
      await sheet.getByTestId("log-outcome-save").dblclick(); // a double tap must not book twice
      await expect(sheet).toHaveCount(0);

      await expect(fd.page.getByTestId("journey-timeline")).toContainText("Appointment confirmed");
      await expect(fd.page.getByTestId("next-action-visit")).toContainText("Patient visit");
      expect(sql(`SELECT count(*) FROM appointments WHERE journey_id = '${lead.journeyId}'`)).toBe("1");
      expect(sql(`SELECT status FROM appointments WHERE journey_id = '${lead.journeyId}'`)).toBe("confirmed");
      expect(sql(`SELECT count(*) FROM tasks WHERE journey_id = '${lead.journeyId}'`)).toBe("0");
      await expect.poll(() => Number(sql(`SELECT count(*) FROM notifications WHERE journey_id = '${lead.journeyId}'`)), { timeout: 20_000 }).toBeGreaterThan(0);
      expect(sql(`SELECT count(*) FROM notifications WHERE journey_id = '${lead.journeyId}' AND status IN ('SENT','DELIVERED','READ')`)).toBe("0");
    } finally {
      await fd.context.close();
    }
  });

  test("4. a new custom field reaches Add Lead from Settings, leaves it again, keeps its history, and never touches the other workspace", async ({ browser }) => {
    test.setTimeout(90_000); // many page loads and settings round-trips
    const admin = await as(browser, V2, "superadmin");
    try {
      const created = await api<{ id: string }>(admin.page, "POST", "/crm/fields", { specialtyKey: "CATARACT", key: `${FIELD_PREFIX}`, label: "Language at home", fieldType: "SELECT", options: ["English", "Hindi", "Tamil"], placements: ["journey_detail", "patient_360"] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const asks = async (page: Page) => {
        await page.goto("/leads");
        await page.getByRole("button", { name: /add lead/i }).first().click();
        const loaded = page.waitForResponse((r) => /\/specialties\/[^/]+\/fields$/.test(r.url()) && r.status() === 200);
        await page.getByLabel("Service / enquiry").selectOption({ label: "Cataract" });
        await loaded;
        await expect(page.getByTestId("lead-phone-input")).toBeVisible();
        return page.locator("label", { hasText: /^\s*Language at home\s*\*?\s*$/ }).count();
      };
      expect(await asks(admin.page)).toBe(0);

      await admin.page.goto("/settings?section=fields");
      await admin.page.getByTestId(`field-add-lead-${FIELD_PREFIX}`).check();
      await expect.poll(() => sql(`SELECT placements::text FROM custom_field_definitions WHERE key = '${FIELD_PREFIX}' AND tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}')`)).toContain("add_lead");
      expect(await asks(admin.page)).toBe(1); // immediately - no restart, seed or new login

      // Record a value through a real lead, then switch the question off: it leaves Add Lead, the value stays.
      const lk = (await api<Lookups>(admin.page, "GET", "/lookups")).body;
      const lead = await api<{ journeyId: string }>(admin.page, "POST", "/leads", { name: `${MARKER}Language`, phone: "+919000000064", specialtyKey: "CATARACT", branchId: lk.branches[0]!.id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: { [FIELD_PREFIX]: "Tamil" } });
      expect(lead.status, JSON.stringify(lead.body)).toBe(201);
      await admin.page.goto("/settings?section=fields");
      await admin.page.getByTestId(`field-add-lead-${FIELD_PREFIX}`).uncheck();
      await expect.poll(() => sql(`SELECT placements::text FROM custom_field_definitions WHERE key = '${FIELD_PREFIX}' AND tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}')`)).not.toContain("add_lead");
      expect(await asks(admin.page)).toBe(0);
      expect(sql(`SELECT v.value::text FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.field_definition_id WHERE d.key = '${FIELD_PREFIX}'`)).toBe('"Tamil"');

      // Order: it follows the configured order; archive removes it from new entry but keeps the stored value.
      expect((await api(admin.page, "PATCH", `/crm/fields/${created.body.id}`, { placements: ["add_lead", "journey_detail"] })).status).toBe(200);
      expect(await asks(admin.page)).toBe(1);
      expect((await api(admin.page, "PATCH", `/crm/fields/${created.body.id}`, { archived: true })).status).toBe(200);
      expect(await asks(admin.page)).toBe(0);
      expect(sql(`SELECT count(*) FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.field_definition_id WHERE d.key = '${FIELD_PREFIX}'`)).toBe("1");

      // The other workspace never had it.
      const v1 = await as(browser, V1, "admin");
      expect(sql(`SELECT count(*) FROM custom_field_definitions WHERE key = '${FIELD_PREFIX}' AND tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V1.slug}')`)).toBe("0");
      expect(await asks(v1.page)).toBe(0);
      await v1.context.close();
    } finally {
      await admin.context.close();
    }
  });

  test("5. Settings tabs: a plain mouse can reach every tab (‹ ›), the keyboard works, and the page never scrolls sideways", async ({ browser }) => {
    const admin = await as(browser, V2, "superadmin", { width: 700, height: 900 });
    try {
      await admin.page.goto("/settings");
      const tabs = admin.page.getByRole("tablist", { name: "Settings sections" });
      await expect(tabs).toBeVisible();
      await expect(admin.page.getByTestId("tabs-scroll-right").first()).toBeVisible(); // more tabs than fit
      await expect(admin.page.getByTestId("tabs-scroll-left")).toHaveCount(0); // at the start: nothing to the left
      const lastTab = tabs.getByRole("tab").last();
      const settle = () => admin.page.waitForTimeout(500); // smooth scrolling finishes
      for (let i = 0; i < 6 && (await admin.page.getByTestId("tabs-scroll-right").count()) > 0; i++) {
        await admin.page.getByTestId("tabs-scroll-right").first().click();
        await settle();
      }
      await expect(admin.page.getByTestId("tabs-scroll-right")).toHaveCount(0); // reached the end
      await expect(lastTab).toBeInViewport();
      await expect(admin.page.getByTestId("tabs-scroll-left").first()).toBeVisible();
      for (let i = 0; i < 6 && (await admin.page.getByTestId("tabs-scroll-left").count()) > 0; i++) {
        await admin.page.getByTestId("tabs-scroll-left").first().click();
        await settle();
      }
      await expect(admin.page.getByTestId("tabs-scroll-left")).toHaveCount(0); // back at the start
      await expect(tabs.getByRole("tab").first()).toBeInViewport();

      // Keyboard: End jumps to the last tab and brings it into view.
      await tabs.getByRole("tab").first().focus();
      await admin.page.keyboard.press("End");
      await expect(tabs.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
      await expect(tabs.getByRole("tab").last()).toBeInViewport();
      expect(await admin.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      // A deep link to a far tab opens with that tab visible.
      await admin.page.goto("/settings?section=activity");
      await expect(admin.page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab", { selected: true })).toBeInViewport();
    } finally {
      await admin.context.close();
    }
  });
});
