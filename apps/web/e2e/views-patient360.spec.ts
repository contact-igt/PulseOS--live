import { test, expect, type Page } from "@playwright/test";
import { purgePatients } from "./support/fixtures";
import type { CreateLeadResult, Lookups, PatientUpcoming, SessionUser, TaskRow } from "@pulseos/types";

// Patient 360: Timeline (default) | Upcoming. Upcoming is derived only from
// existing records (future appointments, open tasks, scheduled treatments),
// time-ordered in hospital time, and labels each item's journey when the
// patient has more than one (Patient != Journey). Creates its own patient.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const TZ = "Asia/Kolkata";
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function devLogin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-gynecology").click();
  await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
  await page.waitForURL(/\/command-centre/);
}

async function call<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([base, m, p, b]) => {
      const res = await fetch(`${base}${p}`, { method: m, credentials: "include", headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
      return res.json();
    },
    [API, method, path, body] as const,
  ) as Promise<T>;
}

/** A fictional patient with two journeys, a future appointment on one and an open task (due IST 00:15) on the other. */
async function seedPatient(page: Page) {
  const lookups = await call<Lookups>(page, "GET", "/lookups");
  const me = (await call<{ user: SessionUser }>(page, "GET", "/auth/session")).user;
  const branchId = lookups.branches[0].id;
  const phone = `97${String(Date.now()).slice(-8)}`;
  const name = `Upcoming Demo ${phone.slice(-4)}`;
  const a = await call<CreateLeadResult>(page, "POST", "/leads", { name, phone, specialtyKey: "GYNECOLOGY", branchId, source: "website", journeyType: "Gynecology Consultation" });
  const b = await call<CreateLeadResult>(page, "POST", "/leads", { name, phone, specialtyKey: "GYNECOLOGY", branchId, source: "phone", journeyType: "Pregnancy Care" });
  const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
  const inThree = dayKey(new Date(Date.now() + 3 * 86_400_000));
  const appt = await call<{ id: string }>(page, "POST", "/appointments", { patientId: a.patientId, journeyId: a.journeyId, branchId, doctorId: lookups.doctors[0].id, scheduledAt: new Date(`${inThree}T10:30:00+05:30`).toISOString() });
  const task = await call<TaskRow>(page, "POST", "/tasks", { patientId: b.patientId, journeyId: b.journeyId, assignedTo: me.id, type: "CALLBACK", dueAt: new Date(`${tomorrow}T00:15:00+05:30`).toISOString() });
  return { patientId: a.patientId, journeyA: a.journeyId, journeyB: b.journeyId, apptId: appt.id, taskId: task.id, tomorrow, inThree };
}

test.describe("Patient 360 Upcoming", () => {
  // Fictional "Upcoming Demo …" patients (and their journeys, appointments, tasks) are removed after the run.
  test.afterAll(() => purgePatients("Upcoming Demo "));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("lists the patient's upcoming items in hospital time order, each with its journey and a link to it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page);
    const s = await seedPatient(page);
    await page.goto(`/patients/${s.patientId}`);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await page.getByTestId("view-switch-upcoming").click();
    await expect(page).toHaveURL(/view=upcoming/);

    const list = page.getByTestId("patient-upcoming");
    await expect(list).toBeVisible();
    const api = await call<PatientUpcoming>(page, "GET", `/patients/${s.patientId}/upcoming`);
    await expect(list.locator('[data-testid^="upcoming-item-"]')).toHaveCount(api.items.length);

    // Order: the task (tomorrow 00:15 IST) comes before the appointment (in three days).
    const order = await list.locator('[data-testid^="upcoming-item-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order.indexOf(`upcoming-item-${s.taskId}`)).toBeLessThan(order.indexOf(`upcoming-item-${s.apptId}`));

    // IST 00:15 tomorrow is grouped under tomorrow (its UTC date is today).
    await expect(page.getByTestId(`upcoming-day-${s.tomorrow}`).getByTestId(`upcoming-item-${s.taskId}`)).toBeVisible();

    // Two journeys: every item says which journey it belongs to, and links to it.
    const task = page.getByTestId(`upcoming-item-${s.taskId}`);
    await expect(task).toContainText("Pregnancy Care");
    await expect(page.getByTestId(`upcoming-item-${s.apptId}`)).toContainText("Gynecology Consultation");
    await expect(task.getByRole("link")).toHaveAttribute("href", new RegExp(`/journeys/${s.journeyB}`));

    // The journey selector narrows Upcoming exactly like it narrows the timeline.
    await page.getByTestId(`journey-tab-${s.journeyA}`).click();
    await expect(page.getByTestId(`upcoming-item-${s.apptId}`)).toBeVisible();
    await expect(page.getByTestId(`upcoming-item-${s.taskId}`)).toHaveCount(0);

    // View survives reload.
    await page.reload();
    await expect(page.getByTestId("patient-upcoming")).toBeVisible();
  });

  test("390px: Upcoming stacks without page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await devLogin(page);
    const s = await seedPatient(page);
    await page.goto(`/patients/${s.patientId}?view=upcoming`);
    await expect(page.getByTestId("patient-upcoming")).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over).toBeLessThanOrEqual(0);
  });
});
