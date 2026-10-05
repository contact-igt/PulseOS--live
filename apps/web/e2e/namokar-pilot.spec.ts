import { test, expect, type Browser, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// NAMOKAR PILOT: the day-to-day path of the pilot hospital, through the screens, with the pilot's own roles and its own sign-in
// page. Every spec makes its own fictional patients (marker "E2E NPILOT") and removes them afterwards, so it can run twice in a
// row against the same seeded database without touching, or depending on, the seeded stories.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TZ = "Asia/Kolkata";
const RUN = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E NPILOT ${n} ${RUN}`;
const MARKER = "E2E NPILOT ";
const dayInHospital = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function loginNamokar(page: Page, who: "superadmin" | "admin" | "frontdesk" | "coordinator" | "doctor") {
  await page.goto("/login/namokar-v1");
  await page.getByLabel("Email address").fill(`namokar.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function as(browser: Browser, who: Parameters<typeof loginNamokar>[1]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await loginNamokar(page, who);
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

interface Lookups { branches: { id: string }[]; doctors: { id: string; name: string }[]; owners: { id: string; name: string }[] }
const lookups = async (page: Page) => (await api<Lookups>(page, "GET", "/lookups")).body;

async function createLead(page: Page, name: string, over: Record<string, unknown> = {}): Promise<{ journeyId: string; patientId: string }> {
  const lk = await lookups(page);
  const res = await api<{ journeyId: string; patientId: string }>(page, "POST", "/leads", { name, phone: phone(), specialtyKey: "CATARACT", branchId: lk.branches[0]!.id, journeyType: "Cataract", sourceKey: "google", customFieldValues: {}, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Books a visit today with Dr. Poonam Jain (so her Doctor Home shows it), moving to a later minute while the slot is taken. */
async function bookToday(page: Page, lead: { journeyId: string; patientId: string }, doctorName = "Dr. Poonam Jain"): Promise<string> {
  const lk = await lookups(page);
  const doctor = lk.doctors.find((d) => d.name === doctorName) ?? lk.doctors[0]!;
  for (let step = 0; step < 40; step++) {
    const at = new Date(Date.now() + (6 + step * 3) * 60_000);
    // "Today" must still be today at that minute: in the last minutes of the hospital's day there is nothing left to book (not a failure of the product).
    test.skip(dayInHospital(0) !== at.toLocaleDateString("en-CA", { timeZone: TZ }), "no time left in the hospital's day to book a visit for today");
    const res = await api<{ id: string }>(page, "POST", "/appointments", {
      patientId: lead.patientId, journeyId: lead.journeyId, branchId: lk.branches[0]!.id, doctorId: doctor.id,
      scheduledAt: at.toISOString(), reason: "Cataract consultation",
    });
    if (res.status === 201) return res.body.id;
    expect(res.status).toBe(409);
  }
  throw new Error("no free slot for the doctor today");
}

test.describe("Namokar pilot", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  // The server only accepts appointments inside the clinic hours (Mon-Sat 09:00-16:00). These flows book "now", at any hour of any day,
  // so the hours are lifted for this run (through the admin endpoint) and put back afterwards. The hours themselves are tested in
  // namokar-v2-pilot.spec.ts and appointment-hours.integration.test.ts.
  let savedHours: unknown = null;
  test.beforeAll(async ({ browser }) => {
    const admin = await as(browser, "admin");
    savedHours = ((await lookups(admin.page)) as Lookups & { clinicHours?: unknown }).clinicHours ?? null;
    expect((await api(admin.page, "PUT", "/clinic-hours", { clinicHours: null })).status).toBe(200);
    await admin.context.close();
  });
  test.afterAll(async ({ browser }) => {
    const admin = await as(browser, "admin");
    await api(admin.page, "PUT", "/clinic-hours", { clinicHours: savedHours });
    await admin.context.close();
  });
  test.afterAll(() => purgePatients(MARKER));

  test("9. /login/namokar-v1 is Namokar's workspace only: branded, no developer tools, no tenant choice, no foreign accounts", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login/namokar-v1");
    await expect(page.getByTestId("tenant-login")).toBeVisible();
    await expect(page.getByTestId("tenant-login-workspace")).toContainText(/You are signing into Namokar['’]s PulseOS workspace/);
    await expect(page.getByTestId("tenant-login-pilot")).toHaveText("V1 Demo");
    await expect(page.getByText("Namokar Eye & Oculoplasty Centre").first()).toBeVisible();
    // Nothing a developer or a stranger could use here: no Developer access, no create account, no hospital picker.
    for (const hidden of ["dev-login-block", "dev-login-toggle", "signup-link", "signup-prompt"]) await expect(page.getByTestId(hidden)).toHaveCount(0);
    await expect(page.getByText(/developer|create account|demo password/i)).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByTestId("remember-me")).toBeVisible();

    // Another hospital's account (same password) is refused here, with the same words as a wrong password.
    await page.getByLabel("Email address").fill("eyev1.admin@pulseos.local");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator('form [role="alert"]')).toHaveText("Incorrect email or password.");
    await expect(page).toHaveURL(/\/login\/namokar-v1$/);

    // An unknown address is a plain dead end, not a hospital list.
    await page.goto("/login/no-such-hospital");
    await expect(page.getByTestId("tenant-login-missing")).toBeVisible();
    await expect(page.getByTestId("dev-login-block")).toHaveCount(0);

    // A real sign-in lands in Namokar, and signing out returns to Namokar's own page.
    const { page: owner, context } = await as(browser, "superadmin");
    await expect(owner.getByText("Dr. Rajesh Shah").first()).toBeVisible();
    await expect(owner.getByText(/Namokar/).first()).toBeVisible();
    const session = await api<{ user: { tenantName: string; role: string; loginSlug: string } }>(owner, "GET", "/auth/session");
    expect(session.body.user).toMatchObject({ tenantName: "Namokar Eye & Oculoplasty Centre", role: "SUPER_ADMIN", loginSlug: "namokar-v1" });
    await owner.getByTestId("profile-menu-trigger").click();
    await owner.getByTestId("logout-button").click();
    await owner.waitForURL(/\/login\/namokar-v1$/);
    await context.close();
  });

  test("10. revenue is off for Namokar: no figure, no panel, no workflow, in the screens or the API", async ({ browser }) => {
    const { page, context } = await as(browser, "superadmin");
    const lead = await createLead(page, NAME("Money check"));
    // Command Centre (overview and performance), Journeys, Treatments, Journey, Patient 360, Analytics: not a rupee, not "revenue".
    for (const url of ["/command-centre?cc=overview", "/command-centre?cc=performance", "/journeys", "/treatments", `/journeys/${lead.journeyId}`, `/patients/${lead.patientId}`, "/analytics"]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const text = await page.locator("main").innerText();
      const hit = text.match(/.{0,40}(₹|revenue|\broas\b|attributed).{0,40}/is);
      expect(hit?.[0] ?? null, url).toBeNull();
    }
    await expect(page.getByTestId("kpi-attributedRevenue")).toHaveCount(0);
    // The API refuses it even for the owner, and the figure is absent (null), never a fake zero.
    for (const path of ["/analytics/revenue", "/analytics/summary", "/dashboard/executive"]) expect((await api(page, "GET", path)).status, path).toBe(403);
    const today = await api<{ attributedRevenue: number | null }>(page, "GET", "/dashboard/today");
    expect(today.body.attributedRevenue).toBeNull();
    const caps = await api<{ user: { capabilities: Record<string, boolean> } }>(page, "GET", "/auth/session");
    expect(caps.body.user.capabilities).toMatchObject({ REVENUE_TRACKING: false, WHATSAPP_INBOX: false, CONVERSATION_INTELLIGENCE: false, ANALYTICS_CORE: true });
    // An admin cannot bring it back; only the owner could, deliberately.
    await context.close();
    const admin = await as(browser, "admin");
    expect((await api(admin.page, "PUT", "/capabilities/REVENUE_TRACKING", { enabled: true })).status).toBe(403);
    await admin.context.close();
  });

  test("1. online lead -> journey -> contacted -> booked, with the status on Leads and on the Journey", async ({ browser }) => {
    const { page, context } = await as(browser, "frontdesk");
    const name = NAME("Online");

    // Add Lead (Google, Cataract) through the screen.
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("lead-phone-input").fill(phone());
    await page.getByTestId("lead-name-input").fill(name);
    await page.getByTestId("lead-specialty-select").selectOption({ label: "Cataract" });
    await expect(page.locator("#lead-branch")).toHaveCount(0); // one branch: chosen for the receptionist, not asked
    await page.getByTestId("lead-source-select").selectOption("google");
    const saved = page.waitForResponse((r) => r.url().endsWith("/leads") && r.request().method() === "POST");
    await page.getByTestId("add-lead-submit").click();
    expect((await saved).status()).toBe(201);
    await expect(page.getByTestId("add-lead-drawer")).toBeHidden();

    // It is a new enquiry with its ORIGINAL source; the derived status has nothing to say yet.
    await page.goto("/leads");
    const row = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(row).toContainText("Google");
    await expect(row).toContainText("New");
    await expect(row.locator('[data-testid^="lead-op-status-"]')).toHaveCount(0);
    await row.click({ position: { x: 300, y: 10 } });
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("journey-original-source")).toContainText("Google");
    await expect(page.getByTestId("journey-stage")).toContainText(/Enquiry/i);
    await expect(page.getByTestId("journey-operational-status")).toHaveCount(0);

    // A connected call is logged from the journey: the enquiry is now Contacted.
    await page.getByTestId("journey-log-call").click();
    await page.getByTestId("log-call-connected-true").click();
    await page.getByTestId("log-call-feedback").fill("Wants a consultation this week");
    await page.getByTestId("log-call-save").click();
    await expect(page.getByTestId("journey-stage")).toContainText(/Contacted/i);

    // Booked from the journey: the status says so, here and on the Leads list.
    await page.getByTestId("journey-book-appointment").click();
    const drawer = page.getByTestId("new-appointment-drawer");
    await expect(drawer.locator("#appt-branch")).toHaveCount(0); // one branch, one doctor: nothing to choose
    await expect(drawer.locator("#appt-doctor")).toHaveCount(0);
    const day = dayInHospital(20 + (Number(RUN) % 40));
    await drawer.locator("#appt-time").fill(`${day}T${String(9 + (Number(RUN) % 8)).padStart(2, "0")}:15`);
    await drawer.getByTestId("new-appointment-submit").click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByTestId("journey-operational-status")).toContainText("Appointment booked");
    await expect(page.getByTestId("journey-progress-appointment")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("journey-progress-enquiry")).toContainText("Google");
    await page.goto("/leads");
    const booked = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(booked.locator('[data-testid^="lead-op-status-"]')).toContainText("Appointment booked");
    await context.close();
  });

  test("2. arrival: Front Desk checks in, waits, sends to the doctor; the doctor completes their own consultation", async ({ browser }) => {
    const desk = await as(browser, "frontdesk");
    const name = NAME("Arrival");
    const lead = await createLead(desk.page, name);
    await bookToday(desk.page, lead);

    await desk.page.goto(`/journeys/${lead.journeyId}`);
    const ctx = desk.page.getByTestId("appointment-context");
    const primary = desk.page.getByTestId("appointment-context-primary");
    await expect(primary).toHaveText("Check in");
    await primary.click(); // one click: arrived AND waiting
    await expect(desk.page.getByTestId("journey-operational-status")).toContainText("Waiting");
    await desk.page.getByTestId("appointment-context-primary").click();
    await expect(desk.page.getByTestId("journey-operational-status")).toContainText("With doctor");
    // The front desk's next step is "Consultation done" too (authorised staff may), but THIS test completes it as the doctor.
    await expect(ctx).toContainText("With doctor");
    await expect(desk.page.getByTestId("journey-progress-attendance")).toHaveAttribute("data-state", "done");
    await expect(desk.page.getByTestId("journey-progress-consultation")).toHaveAttribute("data-state", "current");

    const doc = await as(browser, "doctor");
    await doc.page.goto("/doctor-home");
    // THIS patient's row (the seeded clinic day has its own patient with the doctor right now; never touch that one).
    const queueRow = doc.page.getByTestId("doctor-queue").locator("li").filter({ hasText: name });
    await expect(queueRow).toBeVisible();
    await queueRow.getByRole("button", { name: "Consultation done" }).click();
    const sheet = doc.page.getByTestId("complete-consultation");
    // A doctor is not offered surgery scheduling while completing.
    await expect(sheet.getByTestId("complete-next-surgery")).toHaveCount(0);
    await sheet.getByTestId("complete-next-none").check();
    await sheet.getByTestId("complete-consultation-save").click();
    await expect(sheet).not.toBeVisible();
    expect(sql(`SELECT status FROM appointments WHERE journey_id = '${lead.journeyId}'`)).toBe("completed");

    // The doctor records ONE operational outcome: surgery advised. It opens a treatment record for the journey.
    await desk.page.reload();
    await expect(desk.page.getByTestId("journey-operational-status")).toContainText("Consultation completed");
    await doc.page.goto("/doctor-home");
    const row = doc.page.getByTestId("outcome-action-list").locator('li').filter({ hasText: name });
    await row.getByRole("button", { name: "Surgery / procedure advised" }).click();
    await row.locator("select").selectOption({ index: 1 });
    await row.getByRole("button", { name: "Record" }).click();
    await expect(doc.page.getByTestId("outcome-notice")).toContainText("Surgery / procedure advised");
    expect(sql(`SELECT status FROM treatment_opportunities WHERE journey_id = '${lead.journeyId}'`)).toBe("ADVISED");
    await desk.page.reload();
    await expect(desk.page.getByTestId("journey-operational-status")).toContainText("Treatment follow-up");
    // Front Desk has no treatment access, so it is told so plainly (never a guess); the Treatments page shows the record.
    await expect(desk.page.getByTestId("journey-progress-treatment")).toContainText("Not available for your role");
    await desk.context.close();
    await doc.context.close();
  });

  test("3. treatment outcome -> treatment record -> procedure scheduled -> progress and status update", async ({ browser }) => {
    const { page, context } = await as(browser, "coordinator");
    const name = NAME("Surgery");
    const lead = await createLead(page, name, { ownerId: (await api<{ user: { id: string } }>(page, "GET", "/auth/session")).body.user.id });
    const apptId = await bookToday(page, lead);
    for (const action of ["check_in", "mark_waiting", "send_to_doctor"]) expect((await api(page, "PATCH", `/appointments/${apptId}/action`, { action })).status).toBe(200);

    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-primary").click(); // Consultation done
    const sheet = page.getByTestId("complete-consultation");
    await sheet.getByTestId("complete-next-surgery").check();
    const procedures = sheet.getByTestId("complete-surgery-procedure");
    await procedures.selectOption({ index: 1 });
    await sheet.getByTestId("complete-surgery-date").fill(dayInHospital(9));
    await sheet.getByTestId("complete-surgery-time").fill("09:30");
    await expect(sheet.getByTestId("complete-surgery-doctor")).toHaveCount(0); // the only doctor is chosen for the user
    await sheet.getByTestId("complete-consultation-save").click();
    await expect(sheet).not.toBeVisible();

    await expect(page.getByTestId("surgery-card")).toBeVisible();
    await expect(page.getByTestId("journey-operational-status")).toContainText("Procedure scheduled");
    await expect(page.getByTestId("journey-progress-treatment")).toContainText("Scheduled");
    expect(sql(`SELECT status FROM treatment_opportunities WHERE journey_id = '${lead.journeyId}'`)).toBe("SCHEDULED");
    // No revenue event, whatever happens to the treatment (Namokar runs no revenue workflow).
    expect(sql(`SELECT count(*) FROM revenue_events WHERE journey_id = '${lead.journeyId}'`)).toBe("0");

    await page.goto("/treatments");
    await expect(page.locator('[data-testid^="treatment-row-"]').filter({ hasText: name })).toContainText("Scheduled");
    await page.goto("/leads");
    await expect(page.locator('[data-testid^="lead-row-"]').filter({ hasText: name }).locator('[data-testid^="lead-op-status-"]')).toContainText("Procedure scheduled");
    await context.close();
  });

  test("4. follow-up outcome -> one follow-up task -> My Work, and a second request does not duplicate it", async ({ browser }) => {
    const desk = await as(browser, "frontdesk");
    const me = (await api<{ user: { id: string } }>(desk.page, "GET", "/auth/session")).body.user.id;
    const name = NAME("Follow-up");
    const lead = await createLead(desk.page, name, { ownerId: me });
    const apptId = await bookToday(desk.page, lead);
    for (const action of ["check_in", "mark_waiting", "send_to_doctor"]) expect((await api(desk.page, "PATCH", `/appointments/${apptId}/action`, { action })).status).toBe(200);
    expect((await api(desk.page, "PATCH", `/appointments/${apptId}/complete`, { next: { kind: "none" } })).status).toBe(200);

    const doc = await as(browser, "doctor");
    await doc.page.goto("/doctor-home");
    const row = doc.page.getByTestId("outcome-action-list").locator("li").filter({ hasText: name });
    await row.getByRole("button", { name: "Review / follow-up" }).click();
    await expect(doc.page.getByTestId("outcome-notice")).toContainText("Review / follow-up");
    expect(sql(`SELECT count(*) FROM tasks WHERE journey_id = '${lead.journeyId}' AND status = 'pending' AND type = 'FOLLOW_UP'`)).toBe("1");

    // It is in the owner's My Work, with this patient.
    await desk.page.goto("/my-work");
    await expect(desk.page.getByText(name).first()).toBeVisible();
    // Asking again (a second visit's outcome) reuses the open follow-up.
    const second = (await api<{ id: string }>(desk.page, "POST", "/appointments", { patientId: lead.patientId, journeyId: lead.journeyId, branchId: (await lookups(desk.page)).branches[0]!.id, doctorId: (await lookups(desk.page)).doctors[0]!.id, scheduledAt: new Date(Date.now() + 40 * 60_000).toISOString(), reason: "Review" })).body.id;
    for (const action of ["check_in", "mark_waiting", "send_to_doctor"]) await api(desk.page, "PATCH", `/appointments/${second}/action`, { action });
    await api(desk.page, "PATCH", `/appointments/${second}/complete`, { next: { kind: "none" } });
    sql(`UPDATE appointments SET doctor_user_id = (SELECT doctor_user_id FROM appointments WHERE id = '${apptId}') WHERE id = '${second}'`);
    await doc.page.reload();
    const again = doc.page.getByTestId("outcome-action-list").locator("li").filter({ hasText: name });
    if (await again.count()) await again.getByRole("button", { name: "Review / follow-up" }).click();
    await expect.poll(() => sql(`SELECT count(*) FROM tasks WHERE journey_id = '${lead.journeyId}' AND status = 'pending' AND type = 'FOLLOW_UP'`)).toBe("1");
    await desk.context.close();
    await doc.context.close();
  });

  test("5. no-show -> Appointment Risk -> My Work -> lead status, once", async ({ browser }) => {
    const { page, context } = await as(browser, "coordinator");
    const me = (await api<{ user: { id: string } }>(page, "GET", "/auth/session")).body.user.id;
    const name = NAME("No-show");
    const lead = await createLead(page, name, { ownerId: me });
    await bookToday(page, lead);

    await page.goto(`/journeys/${lead.journeyId}`);
    await page.getByTestId("appointment-context-open").click();
    const drawer = page.getByTestId("appointment-drawer");
    await drawer.getByTestId("drawer-action-no-show").click();
    await drawer.getByTestId("drawer-reason-note").fill("Phone switched off");
    await drawer.getByTestId("drawer-reason-confirm").dblclick(); // a double click raises one task
    await expect(page.getByTestId("next-action-type")).toHaveText("Appointment Risk");
    await expect(page.getByTestId("journey-operational-status")).toContainText("No-show");
    await expect(page.getByTestId("journey-progress-attendance")).toHaveAttribute("data-state", "problem");
    expect(sql(`SELECT count(*) FROM tasks t JOIN followup_types f ON f.id = t.followup_type_id WHERE t.journey_id = '${lead.journeyId}' AND t.status = 'pending' AND f.key = 'appointment_risk'`)).toBe("1");

    await page.goto("/my-work");
    await expect(page.getByText(name).first()).toBeVisible();
    await page.goto("/leads?view=missed_visit");
    const row = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-testid^="lead-op-status-"]')).toContainText("No-show");
    await expect(row).toContainText("Appointment Risk");
    await context.close();
  });

  test("6. walk-in: Walk-in source, a first-contact line, no invented callback, optional check-in", async ({ browser }) => {
    const { page, context } = await as(browser, "frontdesk");
    const name = NAME("Walk-in");
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("lead-phone-input").fill(phone());
    await page.getByTestId("lead-name-input").fill(name);
    await page.getByTestId("lead-specialty-select").selectOption({ label: "General Eye Consultation" });
    await expect(page.locator("#lead-branch")).toHaveCount(0); // one branch: chosen for the receptionist, not asked
    await page.getByTestId("lead-source-select").selectOption("walk_in");
    await page.getByTestId("lead-channel-select").selectOption("WALK_IN");
    const saved = page.waitForResponse((r) => r.url().endsWith("/leads") && r.request().method() === "POST");
    await page.getByTestId("add-lead-submit").click();
    expect((await saved).status()).toBe(201);
    await page.goto("/leads");
    const row = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(row).toContainText("Walk-in");
    await row.click({ position: { x: 300, y: 10 } });
    await expect(page.getByTestId("journey-original-source")).toContainText("Walk-in");
    await expect(page.getByText(/Walk-in recorded manually/)).toBeVisible();
    await expect(page.getByTestId("next-action-empty")).toBeVisible(); // nobody has been promised a callback
    await expect(page.getByTestId("journey-tasks")).toContainText("No open follow-ups");
    await context.close();
  });

  test("7. duplicates: the same phone is the same Patient; a new service is a new Journey on that Patient", async ({ browser }) => {
    const { page, context } = await as(browser, "frontdesk");
    const name = NAME("Dedupe");
    const number = phone();
    const first = await createLead(page, name, { phone: number });
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("lead-phone-input").fill(`+91 ${number.slice(0, 5)} ${number.slice(5)}`);
    await page.getByTestId("lead-phone-input").press("Tab"); // the duplicate check runs when the field is left
    await expect(page.getByTestId("existing-patient-banner")).toContainText("Existing patient found");
    await expect(page.getByTestId("existing-patient-banner")).toContainText("new journey, not a duplicate patient");
    await page.getByTestId("lead-specialty-select").selectOption({ label: "Oculoplasty" });
    await expect(page.locator("#lead-branch")).toHaveCount(0); // one branch: chosen for the receptionist, not asked
    await page.getByTestId("lead-source-select").selectOption("instagram");
    const saved = page.waitForResponse((r) => r.url().endsWith("/leads") && r.request().method() === "POST");
    await page.getByTestId("add-lead-submit").click();
    const res = await saved;
    expect(res.status()).toBe(201);
    const second = (await res.json()) as { patientId: string; journeyId: string; isNewPatient: boolean };
    expect(second.patientId).toBe(first.patientId);
    expect(second.isNewPatient).toBe(false);
    expect(second.journeyId).not.toBe(first.journeyId);
    expect(sql(`SELECT count(*) FROM patients WHERE id = '${first.patientId}'`)).toBe("1");
    expect(sql(`SELECT count(*) FROM journeys WHERE patient_id = '${first.patientId}'`)).toBe("2");
    // Each journey keeps the source it started with.
    expect(sql(`SELECT j.journey_type || ':' || s.key FROM journeys j JOIN lead_sources s ON s.id = j.source_id WHERE j.patient_id = '${first.patientId}' ORDER BY j.created_at`)).toBe("Cataract:google\nOculoplasty:instagram");
    await context.close();
  });

  test("8. breadcrumb: Leads > Patient > Cataract keeps the list you came from (filters and all), and Patient is not Journey", async ({ browser }) => {
    const { page, context } = await as(browser, "admin");
    const name = NAME("Crumb");
    const lead = await createLead(page, name);
    await page.goto("/leads?view=uncontacted");
    const row = page.locator('[data-testid^="lead-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    await row.click({ position: { x: 300, y: 10 } });
    await expect(page.getByTestId("journey-detail")).toBeVisible();

    const crumbs = page.getByTestId("breadcrumb");
    await expect(crumbs).toContainText("Leads");
    await expect(crumbs.getByTestId("breadcrumb-1")).toHaveText(name);
    await expect(crumbs.getByTestId("breadcrumb-2")).toHaveText("Cataract");
    await expect(crumbs.getByTestId("breadcrumb-2")).toHaveAttribute("aria-current", "page");
    await expect(crumbs).not.toContainText(/customer/i);

    // Patient is a different page from the Journey, and the trail stays rooted at Leads.
    await crumbs.getByTestId("breadcrumb-1").click();
    await expect(page).toHaveURL(new RegExp(`/patients/${lead.patientId}`));
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByTestId("breadcrumb").getByTestId("breadcrumb-0")).toHaveText("Leads");
    await expect(page.getByTestId("breadcrumb").getByTestId("breadcrumb-1")).toHaveText(name);
    // …and the root takes you back to the SAME filtered list.
    await page.getByTestId("breadcrumb").getByTestId("breadcrumb-0").click();
    await expect(page).toHaveURL(/\/leads\?view=uncontacted/);
    await expect(page.locator('[data-testid^="lead-row-"]').filter({ hasText: name })).toBeVisible();

    // A direct link with no source still reads sensibly (Journeys > Patient > Cataract).
    await page.goto(`/journeys/${lead.journeyId}`);
    await expect(page.getByTestId("breadcrumb-0")).toHaveText("Journeys");
    await context.close();
  });
});
