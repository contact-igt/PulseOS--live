import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Doctor Home outcome recording (catalog procedure), Treatments filters and the Patient 360
// "Open journey" link, all in the Ophthalmology demo tenant.
//
// Re-runnable without reseeding: the outcome test creates its own completed, outcome-less
// appointment straight in Postgres (same DB the dev API uses) and removes everything it
// created - the appointment, outcome, treatment, timeline rows - and restores the journey
// stage in afterEach, pass or fail.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://localhost:5432/pulseos_dev";

type RoleKey = "HOSPITAL_ADMIN" | "DOCTOR" | "PATIENT_COORDINATOR";
const HOME: Record<RoleKey, RegExp> = { HOSPITAL_ADMIN: /\/command-centre/, DOCTOR: /\/doctor-home/, PATIENT_COORDINATOR: /\/my-work/ };

async function devLogin(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(HOME[role]);
}

function sql(statement: string): string {
  return execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-F", "|", "-c", statement], { encoding: "utf8" }).trim();
}

let created: { appointmentId: string; journeyId: string; patientName: string; originalStage: string } | null = null;

function createAwaitingOutcomeAppointment() {
  const row = sql(`
    WITH pick AS (
      SELECT j.id AS journey_id, j.tenant_id, j.patient_id, j.stage::text AS stage, p.name AS patient_name
      FROM journeys j
      JOIN tenants t ON t.id = j.tenant_id AND t.name = 'PulseOS Ophthalmology Demo'
      JOIN patients p ON p.id = j.patient_id
      WHERE j.specialty_key = 'LASER_VISION_CORRECTION'
        AND NOT EXISTS (SELECT 1 FROM treatment_opportunities o WHERE o.journey_id = j.id)
      ORDER BY j.created_at
      LIMIT 1
    ), doc AS (
      SELECT id, branch_id, tenant_id FROM users WHERE email = 'eye.doctor@pulseos.local'
    ), ins AS (
      INSERT INTO appointments (tenant_id, patient_id, journey_id, branch_id, doctor_user_id, status, scheduled_at, reason)
      SELECT pick.tenant_id, pick.patient_id, pick.journey_id, doc.branch_id, doc.id, 'completed', now(), 'E2E outcome recording'
      FROM pick, doc
      RETURNING id
    )
    SELECT ins.id, pick.journey_id, pick.patient_name, pick.stage FROM ins, pick;`);
  const [appointmentId, journeyId, patientName, originalStage] = row.split("|");
  created = { appointmentId, journeyId, patientName, originalStage };
  return created;
}

function cleanUp() {
  if (!created) return;
  const { appointmentId, journeyId, originalStage } = created;
  sql(`
    DELETE FROM timeline_events WHERE related_entity_id IN (
      SELECT t.id FROM treatment_opportunities t JOIN consultation_outcomes c ON c.id = t.consultation_outcome_id WHERE c.appointment_id = '${appointmentId}'
      UNION SELECT id FROM consultation_outcomes WHERE appointment_id = '${appointmentId}');
    DELETE FROM treatment_opportunities WHERE consultation_outcome_id IN (SELECT id FROM consultation_outcomes WHERE appointment_id = '${appointmentId}');
    DELETE FROM consultation_outcomes WHERE appointment_id = '${appointmentId}';
    DELETE FROM appointments WHERE id = '${appointmentId}';
    UPDATE journeys SET stage = '${originalStage}' WHERE id = '${journeyId}';`);
  created = null;
}

test.describe("Doctor Home outcome recording, Treatments filters, Patient 360 journey link", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterEach(() => cleanUp());

  test("a doctor records Treatment Advised with a catalog procedure for the journey's own service, and it appears on Treatments with the catalog label", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { appointmentId, patientName } = createAwaitingOutcomeAppointment();

    await devLogin(page, "DOCTOR");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    const row = page.getByTestId(`outcome-row-${appointmentId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(patientName);
    await expect(row).toContainText("Laser Vision Correction");

    // Treatment Advised asks WHICH treatment, from the catalog slice of this journey's service only.
    await page.getByTestId(`outcome-TREATMENT_ADVISED-${appointmentId}`).click();
    const select = page.getByTestId(`treatment-select-${appointmentId}`);
    await expect(select).toBeVisible();
    expect(await select.locator("option").allTextContents()).toEqual(["Select a treatment", "LASIK", "SMILE", "PRK"]);
    await expect(page.getByTestId(`treatment-confirm-${appointmentId}`)).toBeDisabled();
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/doctor-home-outcome-picker-1440.png`, fullPage: true });

    await select.selectOption({ label: "PRK" });
    await page.getByTestId(`treatment-confirm-${appointmentId}`).click();

    await expect(page.getByRole("status")).toContainText(/Outcome recorded/i);
    await expect(page.getByRole("status")).toContainText("PRK");
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/doctor-home-outcome-recorded-1440.png`, fullPage: true });
    // The queue updates: the row leaves "awaiting outcome".
    await expect(page.getByTestId(`outcome-row-${appointmentId}`)).toHaveCount(0);

    // The treatment now exists in the pipeline with the catalog label (seen by an admin).
    const adminContext = await browser.newContext({ baseURL: page.url().split("/doctor-home")[0] });
    const adminPage = await adminContext.newPage();
    await adminPage.setViewportSize({ width: 1440, height: 900 });
    await devLogin(adminPage, "HOSPITAL_ADMIN");
    await adminPage.goto("/treatments");
    await adminPage.getByTestId("treatment-filter-service").selectOption({ label: "Laser Vision Correction" });
    await adminPage.getByTestId("treatment-filter-procedure").selectOption({ label: "PRK" });
    const recorded = adminPage.locator("tbody tr", { hasText: patientName });
    await expect(recorded).toBeVisible();
    await expect(recorded).toContainText("PRK");
    await expect(recorded).toContainText("Advised");
    await adminContext.close();
  });

  test("outcomes that create no treatment record straight away, with the queue updating", async ({ page }) => {
    const { appointmentId } = createAwaitingOutcomeAppointment();
    await devLogin(page, "DOCTOR");
    await page.getByTestId(`outcome-CONSULTED-${appointmentId}`).click();
    await expect(page.getByRole("status")).toContainText(/Outcome recorded: Consultation completed/i);
    await expect(page.getByTestId(`outcome-row-${appointmentId}`)).toHaveCount(0);
  });

  test("Treatments filters: service and procedure narrow the list through the API, and state/clear work", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();

    const rows = page.locator("tbody tr");
    await expect(rows.filter({ hasText: "Ramesh Hegde" })).toBeVisible(); // Cataract
    await expect(rows.filter({ hasText: "Sneha Kamath" })).toBeVisible(); // Laser / PRK

    const filteredRequest = page.waitForRequest((r) => r.url().includes("/treatments?") && r.url().includes("service=Laser"));
    await page.getByTestId("treatment-filter-service").selectOption({ label: "Laser Vision Correction" });
    await filteredRequest;
    await expect(rows.filter({ hasText: "Sneha Kamath" })).toBeVisible();
    await expect(rows.filter({ hasText: "Ramesh Hegde" })).toHaveCount(0);

    // Procedure options are scoped to the chosen service.
    const procedureLabels = await page.getByTestId("treatment-filter-procedure").locator("option").allTextContents();
    expect(procedureLabels).toContain("PRK");
    expect(procedureLabels).not.toContain("Cataract Surgery");

    const procedureRequest = page.waitForRequest((r) => r.url().includes("treatmentDefinitionId="));
    await page.getByTestId("treatment-filter-procedure").selectOption({ label: "PRK" });
    await procedureRequest;
    await expect(rows.filter({ hasText: "Sneha Kamath" })).toBeVisible();
    await expect(rows.filter({ hasText: "Farhan Sheikh" })).toHaveCount(0); // SMILE

    await page.getByTestId("treatment-filter-state").selectOption({ label: "Completed" });
    await expect(page.getByText("No treatments match these filters.")).toBeVisible();

    await page.getByTestId("treatment-filters-clear").click();
    await expect(rows.filter({ hasText: "Ramesh Hegde" })).toBeVisible();
  });

  test("Treatments row links go to Patient 360 (patient name) and Journey Detail (service / row)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto("/treatments");
    const row = page.locator("tbody tr", { hasText: "Sneha Kamath" });
    await expect(row.getByRole("link", { name: "Sneha Kamath" })).toHaveAttribute("href", /\/patients\/[0-9a-f-]{36}/);
    await expect(row.getByTestId(/treatment-journey-link-/)).toHaveAttribute("href", /\/journeys\/[0-9a-f-]{36}/);
    // Existing status actions keep working: a DECISION_PENDING row offers Accept.
    await expect(row.getByRole("button", { name: "Accept" })).toBeVisible();
  });

  test("Patient 360: every journey card links to its Journey Detail page, and a lone completed journey is not called active", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");

    await page.goto(`/patients?q=${encodeURIComponent("Sneha Kamath")}`);
    await page.locator("tbody tr", { hasText: "Sneha Kamath" }).first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    const open = page.getByRole("link", { name: /Open journey/ }).first();
    await expect(open).toHaveAttribute("href", /\/journeys\/[0-9a-f-]{36}/);
    await open.click();
    await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}/);

    await page.goto(`/patients?q=${encodeURIComponent("Geetha Bhat")}`);
    await page.locator("tbody tr", { hasText: "Geetha Bhat" }).first().click();
    await expect(page.getByTestId("patient-journey-summary")).toHaveText("1 journey · Treatment Completed");
    await expect(page.getByText("1 active journey")).toHaveCount(0);
  });

  test("Patient 360 for a Doctor has no Open journey link (Journey Detail is not in a doctor's navigation)", async ({ page }) => {
    await devLogin(page, "DOCTOR");
    await page.goto(`/patients?q=${encodeURIComponent("Sneha Kamath")}`);
    await page.locator("tbody tr", { hasText: "Sneha Kamath" }).first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open journey/ })).toHaveCount(0);
  });
});
