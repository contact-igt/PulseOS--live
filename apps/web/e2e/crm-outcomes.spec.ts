import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// Workflow outcomes end to end: an admin configures an outcome; a coordinator logs outcomes from the
// Journey page and from My Work; the Journey moves forward only, the follow-up Task appears, and the
// sub-status shows. Fictional fixtures only, removed afterwards.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const RUN = Date.now().toString().slice(-8);
const OUTCOME_LABEL = `E2E Waiting for reports ${RUN}`;
const OUTCOME_KEY = `e2e_waiting_for_reports_${RUN}`;
const PATIENT = `E2E Outcome Patient ${RUN}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function newJourney(page: Page, name = PATIENT): Promise<{ patientId: string; journeyId: string }> {
  const lookups = (await (await page.request.get(`${API}/lookups`)).json()) as { branches: { id: string }[] };
  const res = await page.request.post(`${API}/leads`, {
    data: { name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0].id, source: "walk_in", journeyType: "Cataract" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { patientId: string; journeyId: string };
}

test.describe("Workflow outcomes", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => {
    purgePatients("E2E Outcome Patient");
    sql(`UPDATE journeys SET last_outcome_id = NULL WHERE last_outcome_id IN (SELECT id FROM crm_outcomes WHERE key LIKE 'e2e_%'); DELETE FROM crm_outcomes WHERE key LIKE 'e2e_%';`);
  });

  test("an admin adds, edits, archives and restores an outcome (stages stay fixed)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/settings?section=outcomes");
    await expect(page.getByTestId("outcomes-section")).toBeVisible();
    await expect(page.getByTestId("outcome-row-needs_callback")).toContainText("Needs a follow-up date and time");

    await page.getByTestId("outcomes-add").click();
    await page.getByTestId("outcome-save").click();
    await expect(page.getByTestId("outcome-editor-error")).toContainText("label");
    await page.getByTestId("outcome-label").fill(OUTCOME_LABEL);
    // Only Contacted or Lost: the journey stage list is not editable.
    await expect(page.getByTestId("outcome-stage").locator("option")).toHaveText(["Contacted", "Lost"]);
    await page.getByTestId("outcome-requires-follow-up").check();
    await page.getByTestId("outcome-save").click();
    const row = page.getByTestId(`outcome-row-${OUTCOME_KEY}`);
    await expect(row).toContainText("Needs a follow-up date and time");

    await row.getByTestId(`outcome-edit-${OUTCOME_KEY}`).click();
    await page.getByTestId("outcome-requires-follow-up").uncheck();
    await page.getByTestId("outcome-asks-reason").check();
    await page.getByTestId("outcome-save").click();
    await expect(row).toContainText("asks why");
    await expect(row).not.toContainText("follow-up date");

    await page.getByTestId(`outcome-archive-${OUTCOME_KEY}`).click();
    await expect(row).toBeHidden();
    await page.getByTestId("outcomes-show-archived").check();
    await expect(row).toContainText("Archived");
    await page.getByTestId(`outcome-restore-${OUTCOME_KEY}`).click();
    await expect(row).not.toContainText("Archived");
  });

  test("logging 'Needs callback' from the Journey needs a date, schedules the follow-up and shows the sub-status", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.coordinator@pulseos.local");
    const { journeyId } = await newJourney(page);
    await page.goto(`/journeys/${journeyId}`);
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("journey-stage")).toContainText("Enquiry");

    await page.getByTestId("journey-log-outcome").click();
    const sheet = page.getByTestId("log-outcome");
    await expect(sheet).toBeVisible();
    await page.getByTestId("log-outcome-save").click();
    await expect(page.getByTestId("log-outcome-error")).toContainText("Choose what happened");

    await page.getByTestId("log-outcome-choice-needs_callback").click();
    // The follow-up time is pre-filled (tomorrow 10:00) and required; clearing it is refused, not silently saved.
    await expect(page.getByTestId("log-outcome-follow-up")).not.toHaveValue("");
    await page.getByTestId("log-outcome-follow-up").fill("");
    await page.getByTestId("log-outcome-save").click();
    await expect(page.getByTestId("log-outcome-error")).toContainText("when to follow up");
    await page.getByTestId("log-outcome-note").fill("Asked us to call after 5pm");
    await page.getByTestId("log-outcome-follow-up").fill("2030-01-15T17:00");
    await page.getByTestId("log-outcome-save").click();
    await expect(sheet).toBeHidden();

    // Moved forward, sub-status shown, follow-up scheduled — and it all survives a refresh.
    await page.reload();
    await expect(page.getByTestId("journey-stage")).toContainText("Contacted");
    await expect(page.getByTestId("journey-sub-status")).toContainText("Needs callback");
    await expect(page.getByTestId("journey-tasks")).toContainText("Callback");
    await expect(page.getByTestId("journey-timeline")).toContainText("Outcome: Needs callback");
  });

  test("'Not interested' closes an early journey as lost; an offered appointment can be booked from the result", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.coordinator@pulseos.local");
    const lost = await newJourney(page);
    await page.goto(`/journeys/${lost.journeyId}`);
    await page.getByTestId("journey-log-outcome").click();
    await page.getByTestId("log-outcome-choice-not_interested").click();
    await page.getByTestId("log-outcome-reason").fill("Chose another hospital");
    await page.getByTestId("log-outcome-save").click();
    await page.reload();
    await expect(page.getByTestId("journey-stage")).toContainText("Lost");
    await expect(page.getByTestId("journey-timeline")).toContainText("Outcome: Not interested");

    const interested = await newJourney(page);
    await page.goto(`/journeys/${interested.journeyId}`);
    await page.getByTestId("journey-log-outcome").click();
    await page.getByTestId("log-outcome-choice-interested").click();
    await page.getByTestId("log-outcome-save").click();
    await expect(page.getByTestId("log-outcome-done")).toBeVisible();
    await page.getByTestId("log-outcome-book-appointment").click();
    await expect(page.getByTestId("new-appointment-drawer")).toBeVisible();
  });

  test("My Work: logging an outcome closes the task it came from", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.coordinator@pulseos.local");
    const j = await newJourney(page);
    const me = ((await (await page.request.get(`${API}/auth/session`)).json()) as { user: { id: string } }).user.id;
    const taskRes = await page.request.post(`${API}/tasks`, { data: { patientId: j.patientId, journeyId: j.journeyId, type: "CALLBACK", assignedTo: me, dueAt: new Date(Date.now() + 3600_000).toISOString(), notes: `e2e outcome ${RUN}` } });
    const task = (await taskRes.json()) as { id: string };
    await page.goto("/my-work");
    await expect(page.getByTestId(`task-row-${task.id}`)).toBeVisible();
    await page.getByTestId(`task-log-outcome-${task.id}`).click();
    await page.getByTestId("log-outcome-choice-price_enquiry").click();
    await page.getByTestId("log-outcome-save").click();
    await expect(page.getByTestId("log-outcome")).toBeHidden();
    // The task is now completed: it stays listed but offers no further actions, and the open-work counts drop it.
    await expect(page.getByTestId(`task-log-outcome-${task.id}`)).toBeHidden();
    await expect(page.getByTestId(`task-complete-${task.id}`)).toBeHidden();
    const after = (await (await page.request.get(`${API}/tasks?patientId=${j.patientId}`)).json()) as { id: string; status: string }[];
    expect(after.find((t) => t.id === task.id)?.status).toBe("completed");
  });

  test("on a phone the Log outcome sheet is full width and nothing overflows", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eye.coordinator@pulseos.local");
    const j = await newJourney(page);
    await page.goto(`/journeys/${j.journeyId}`);
    await page.getByTestId("journey-log-outcome").click();
    const sheet = page.getByTestId("log-outcome");
    await expect(sheet).toBeVisible();
    expect((await sheet.boundingBox())!.width).toBeGreaterThanOrEqual(385);
    await page.getByTestId("log-outcome-choice-needs_callback").click();
    await expect(page.getByTestId("log-outcome-follow-up")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});
