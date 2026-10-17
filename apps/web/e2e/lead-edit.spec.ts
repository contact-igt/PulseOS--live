import { test, expect, type Page } from "@playwright/test";
import { purgePatients } from "./support/fixtures";

// Edit Lead: the drawer opened from the Leads row menu, the shared ?edit= link and the journey page; what is saved; what a role may not change.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const RUN = `${Date.now()}`.slice(-6);
const NAME = `E2E EditLead ${RUN}`;
const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function createLead(page: Page): Promise<{ journeyId: string; patientId: string }> {
  const lookups = await (await page.request.get(`${API}/lookups`)).json();
  const res = await page.request.post(`${API}/leads`, {
    data: { name: NAME, phone: phone(), specialtyKey: "GYNECOLOGY", branchId: lookups.branches[0].id, sourceKey: "phone", journeyType: "Gynecology Consultation" },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe("Edit Lead", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => purgePatients("E2E EditLead "));

  test("an admin edits a lead from the shared link, saves, and the change is stored", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    const { journeyId } = await createLead(page);

    await page.goto(`/leads?edit=${journeyId}`);
    const drawer = page.getByTestId("edit-lead-drawer");
    await expect(drawer).toBeVisible();
    await expect(page).not.toHaveURL(/edit=/);
    await expect(page.getByLabel("Name")).toHaveValue(NAME);
    await expect(page.getByTestId("edit-lead-save")).toBeDisabled();

    await page.getByLabel("Name").fill(`${NAME} Renamed`);
    await page.getByLabel("Priority").selectOption("high");
    await page.getByLabel("Notes").fill("Prefers evening calls");
    await expect(page.getByTestId("edit-lead-save")).toBeEnabled();
    await page.screenshot({ path: "test-results/lead-edit-details.png" });
    await page.getByTestId("edit-lead-save").click();
    await expect(drawer).toBeHidden();

    const model = await (await page.request.get(`${API}/leads/${journeyId}/edit`)).json();
    expect(model.patient.name).toBe(`${NAME} Renamed`);
    expect(model.journey).toMatchObject({ priority: "high", notes: "Prefers evening calls" });
  });

  test("the Insights tab shows how the lead is doing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    const { journeyId } = await createLead(page);

    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("journey-edit-lead").click();
    await expect(page.getByTestId("edit-lead-drawer")).toBeVisible();
    await page.getByTestId("edit-lead-tab-insights").click();
    await expect(page.getByTestId("lead-insights")).toContainText("Original source");
    await expect(page.getByTestId("lead-insights")).toContainText("Today");
    await page.screenshot({ path: "test-results/lead-edit-insights.png" });
  });

  test("closing with unsaved changes asks first", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    const { journeyId } = await createLead(page);
    await page.goto(`/leads?edit=${journeyId}`);
    await page.getByLabel("Name").fill("Throwaway");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Throwaway");
  });

  test("Front Desk can edit details but not the owner or the original source", async ({ page }) => {
    await login(page, "gyn.frontdesk@pulseos.local");
    const { journeyId } = await createLead(page);
    await page.goto(`/leads?edit=${journeyId}`);
    await expect(page.getByTestId("edit-lead-drawer")).toBeVisible();
    await expect(page.getByLabel("Team member")).toBeDisabled();
    await expect(page.getByLabel("Original source")).toBeDisabled();
    await expect(page.getByLabel("Name")).toBeEnabled();
  });

  test("from the Leads table row menu", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    const { journeyId } = await createLead(page);
    await page.goto("/leads");
    await page.getByTestId(`lead-menu-${journeyId}`).click();
    await page.getByRole("menuitem", { name: "Edit lead" }).click();
    await expect(page.getByTestId("edit-lead-drawer")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue(NAME);
  });
});
