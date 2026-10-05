import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// Allocation rules end to end: an admin adds a Meta + Cataract rule, a new Meta Cataract lead (no owner
// chosen) is assigned by it, manual assignment still wins, and turning the rule off stops it.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const RUN = Date.now().toString().slice(-8);
const RULE = `E2E Meta cataract ${RUN}`;
const PATIENT = `E2E Alloc Patient ${RUN}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function newLead(page: Page, ownerId?: string) {
  const lookups = (await (await page.request.get(`${API}/lookups`)).json()) as { branches: { id: string }[] };
  const res = await page.request.post(`${API}/leads`, {
    data: { name: PATIENT, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0].id, source: "meta", journeyType: "Cataract", ownerId },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { journeyId: string }).journeyId;
}
const ownerOf = async (page: Page, journeyId: string) => (((await (await page.request.get(`${API}/journeys/${journeyId}`)).json()) as { journey: { owner: { name: string } | null } }).journey.owner?.name ?? null);

test.describe("Allocation rules", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => {
    purgePatients("E2E Alloc Patient");
    sql(`DELETE FROM allocation_rules WHERE name LIKE 'E2E %';`);
  });

  test("an admin adds a rule; matching new leads are assigned; manual choice wins; turning it off stops it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/settings?section=allocation");
    await expect(page.getByTestId("allocation-section")).toBeVisible();

    await page.getByTestId("allocation-add").click();
    await page.getByTestId("allocation-save").click();
    await expect(page.getByTestId("allocation-error")).toContainText("name");
    await page.getByTestId("allocation-name").fill(RULE);
    await page.getByTestId("allocation-save").click();
    await expect(page.getByTestId("allocation-error")).toContainText("when this rule applies");
    await page.getByTestId("allocation-source").selectOption("meta");
    await page.getByTestId("allocation-service").selectOption("CATARACT");
    await page.getByTestId("allocation-save").click();
    await expect(page.getByTestId("allocation-error")).toContainText("who should receive");
    await page.getByTestId("allocation-people").getByRole("checkbox").first().check();
    await page.getByTestId("allocation-save").click();
    await expect(page.getByTestId("allocation-editor")).toBeHidden();
    const row = page.locator('[data-testid^="allocation-row-"]', { hasText: RULE });
    await expect(row).toContainText("Meta · Cataract →");

    const journeyId = await newLead(page);
    expect(await ownerOf(page, journeyId)).not.toBeNull();
    // A person chose an owner: the rule does not override it.
    const me = ((await (await page.request.get(`${API}/auth/session`)).json()) as { user: { id: string; name: string } }).user;
    expect(await ownerOf(page, await newLead(page, me.id))).toBe(me.name);

    await row.getByRole("button", { name: "Turn off" }).click();
    await expect(row).toContainText("Off");
    expect(await ownerOf(page, await newLead(page))).toBeNull();

    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toBeHidden();
  });

  test("on a phone the rule sheet is full width and the people stay selectable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/settings?section=allocation");
    await page.getByTestId("allocation-add").click();
    const sheet = page.getByTestId("allocation-editor");
    await expect(sheet).toBeVisible();
    expect((await sheet.boundingBox())!.width).toBeGreaterThanOrEqual(385);
    const first = page.getByTestId("allocation-people").getByRole("checkbox").first();
    await first.check();
    await expect(first).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});
