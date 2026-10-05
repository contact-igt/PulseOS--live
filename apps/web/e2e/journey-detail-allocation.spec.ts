import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// Journey Detail page + lead allocation (owner assignment).
//
// Data safety: this spec mutates journey owners in the live demo DB, so every
// test that assigns snapshots the original owner first and restores it in a
// `finally` through the API. Re-running the spec without reseeding is safe.
// Ophthalmology demo tenant; journeys addressed by patient name.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";

type RoleKey = "HOSPITAL_ADMIN" | "FRONT_DESK" | "PATIENT_COORDINATOR";
const HOME: Record<RoleKey, RegExp> = { HOSPITAL_ADMIN: /\/command-centre/, FRONT_DESK: /\/front-desk/, PATIENT_COORDINATOR: /\/my-work/ };

async function devLogin(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(HOME[role]);
}

interface LeadApiRow { id: string; patientId: string; patientName: string; ownerId: string | null }

async function leadByName(page: Page, name: string): Promise<LeadApiRow> {
  const res = await page.request.get(`${API}/leads`);
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as LeadApiRow[];
  const row = rows.find((r) => r.patientName === name);
  if (!row) throw new Error(`No lead row for ${name}`);
  return row;
}

async function setOwner(request: APIRequestContext, journeyId: string, ownerUserId: string | null) {
  const res = await request.patch(`${API}/journeys/${journeyId}/owner`, { data: { ownerUserId } });
  expect(res.ok(), `restore owner for ${journeyId}`).toBeTruthy();
}

async function owners(page: Page): Promise<{ id: string; name: string }[]> {
  const res = await page.request.get(`${API}/lookups`);
  return ((await res.json()) as { owners: { id: string; name: string }[] }).owners;
}

test.describe("Journey detail + allocation", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("a lead row opens the Journey page (patient, service, stage, timeline), which links to Patient 360 and back", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    const geetha = await leadByName(page, "Geetha Bhat");

    await page.goto("/leads");
    await page.getByTestId(`lead-row-${geetha.id}`).click();

    await expect(page).toHaveURL(new RegExp(`/journeys/${geetha.id}`));
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("patient-360")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Geetha Bhat" })).toBeVisible();
    await expect(page.getByTestId("journey-service")).toContainText("Cataract");
    await expect(page.getByTestId("journey-stage")).toBeVisible();
    await expect(page.getByTestId("journey-owner")).toBeVisible();
    await expect(page.getByTestId("journey-timeline")).toBeVisible();
    await expect(page.getByTestId("journey-timeline").locator("li").first()).toBeVisible();
    await expect(page.getByTestId("journey-appointments")).toBeVisible();
    await expect(page.getByTestId("journey-treatments")).toBeVisible();
    await expect(page.getByTestId("journey-revenue")).toBeVisible();

    // The breadcrumb's root is Leads (the row click carried ?from=leads) and takes you back to it.
    await expect(page.getByTestId("breadcrumb-0")).toHaveText("Leads");
    await expect(page.getByTestId("breadcrumb-0")).toHaveAttribute("href", /^\/leads/);

    // Journey -> Patient 360 -> browser back -> Journey.
    await page.getByTestId("journey-patient-link").click();
    await expect(page).toHaveURL(new RegExp(`/patients/${geetha.patientId}`));
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("journey-detail")).toBeVisible();
  });

  test("keratoconus journey shows specialty custom fields as a compact grid", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    const abhishek = await leadByName(page, "Abhishek Nayak");
    await page.goto(`/journeys/${abhishek.id}`);
    await expect(page.getByTestId("journey-service")).toContainText("Keratoconus");
    await expect(page.getByTestId("journey-custom-fields")).toBeVisible();
    expect(await page.getByTestId("journey-custom-fields").locator("dt").count()).toBeGreaterThan(0);
  });

  test("an unknown journey id shows a clear not-found state, not a crash", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    await page.goto("/journeys/00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("journey-not-found")).toBeVisible();
    await expect(page.getByTestId("journey-detail")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Back to Journeys/ })).toBeVisible();
  });

  test("admin reassigns the owner from the Journey page; it persists and drives the Mine/Unassigned filters", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    const tanvi = await leadByName(page, "Tanvi Shetty");
    const team = await owners(page);
    const original = tanvi.ownerId;
    const target = team.find((o) => o.id !== original)!;

    try {
      await page.goto(`/journeys/${tanvi.id}`);
      await page.getByTestId("journey-assign-owner").click();
      const dialog = page.getByTestId("assign-owner-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("assign-owner-select").selectOption(target.id);
      await dialog.getByTestId("assign-owner-submit").click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("journey-owner")).toContainText(target.name);

      // Persistence: survives a full reload.
      await page.reload();
      await expect(page.getByTestId("journey-owner")).toContainText(target.name);

      // Unassign, then Unassigned scope on Leads lists it (server-side filter).
      await page.getByTestId("journey-assign-owner").click();
      await page.getByTestId("assign-owner-select").selectOption("");
      await page.getByTestId("assign-owner-submit").click();
      await expect(page.getByTestId("journey-owner")).toContainText("Unassigned");

      await page.goto("/leads");
      await page.getByTestId("owner-scope-unassigned").click();
      await expect(page.getByTestId(`lead-row-${tanvi.id}`)).toBeVisible();
      await page.getByTestId("owner-scope-all").click();
      await expect(page.getByTestId(`lead-owner-${tanvi.id}`)).toContainText("Unassigned");

      // Journeys page honours ?owner=unassigned too (deep-link from Command Centre team panel).
      await page.goto("/journeys?owner=unassigned");
      await expect(page.getByTestId("journeys-page")).toBeVisible();
      await expect(page.getByRole("row", { name: /Tanvi Shetty/ })).toBeVisible();
      await expect(page.getByTestId("owner-scope-unassigned")).toHaveAttribute("aria-selected", "true");
    } finally {
      await setOwner(page.request, tanvi.id, original);
    }
  });

  test("single-row Assign on Leads does not navigate, is keyboard reachable, and Escape closes the dialog", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    const zoya = await leadByName(page, "Zoya Khan");
    const team = await owners(page);
    const target = team.find((o) => o.id !== zoya.ownerId)!;

    try {
      await page.goto("/leads");
      const assign = page.getByTestId(`assign-owner-${zoya.id}`);
      await assign.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/leads/);
      const dialog = page.getByTestId("assign-owner-dialog");
      await expect(dialog).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(assign).toBeFocused();

      await assign.click();
      await expect(page).toHaveURL(/\/leads/);
      await dialog.getByTestId("assign-owner-select").selectOption(target.id);
      await dialog.getByTestId("assign-owner-submit").click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/leads/);
      await expect(page.getByTestId(`lead-owner-${zoya.id}`)).toContainText(target.name);
    } finally {
      await setOwner(page.request, zoya.id, zoya.ownerId);
    }
  });

  test("Mine scope shows only the signed-in owner's journeys after they take one", async ({ page }) => {
    await devLogin(page, "PATIENT_COORDINATOR");
    const me = (await (await page.request.get(`${API}/auth/session`)).json()).user as { id: string; name: string };
    const team = await owners(page);
    test.skip(!team.some((o) => o.id === me.id), "Coordinator is not an assignable owner in this seed");
    const tanvi = await leadByName(page, "Tanvi Shetty");
    const original = tanvi.ownerId;

    try {
      await setOwner(page.request, tanvi.id, me.id);
      await page.goto("/leads");
      await page.getByTestId("owner-scope-mine").click();
      await expect(page.getByTestId(`lead-row-${tanvi.id}`)).toBeVisible();
      await page.getByTestId("owner-scope-unassigned").click();
      await expect(page.getByTestId(`lead-row-${tanvi.id}`)).toHaveCount(0);
    } finally {
      await setOwner(page.request, tanvi.id, original);
    }
  });

  test("bulk allocation: select two rows, Assign to..., both owners update", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    const tanvi = await leadByName(page, "Tanvi Shetty");
    const zoya = await leadByName(page, "Zoya Khan");
    const team = await owners(page);
    const target = team.find((o) => o.id !== tanvi.ownerId && o.id !== zoya.ownerId) ?? team.find((o) => o.id !== tanvi.ownerId)!;

    try {
      await page.goto("/leads");
      await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
      await page.getByTestId(`lead-select-${tanvi.id}`).check();
      await page.getByTestId(`lead-select-${zoya.id}`).check();
      await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
      await page.getByTestId("bulk-assign").click();
      const dialog = page.getByTestId("assign-owner-dialog");
      await dialog.getByTestId("assign-owner-select").selectOption(target.id);
      await dialog.getByTestId("assign-owner-submit").click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId(`lead-owner-${tanvi.id}`)).toContainText(target.name);
      await expect(page.getByTestId(`lead-owner-${zoya.id}`)).toContainText(target.name);
      await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId(`lead-owner-${zoya.id}`)).toContainText(target.name);
    } finally {
      await setOwner(page.request, tanvi.id, tanvi.ownerId);
      await setOwner(page.request, zoya.id, zoya.ownerId);
    }
  });

  test("Front Desk sees no allocation controls, the server refuses the write, and restricted sections are quiet", async ({ page }) => {
    await devLogin(page, "FRONT_DESK");
    const zoya = await leadByName(page, "Zoya Khan");

    await page.goto("/leads");
    await expect(page.getByTestId(`lead-row-${zoya.id}`)).toBeVisible();
    await expect(page.locator('[data-testid^="lead-select-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="assign-owner-"]')).toHaveCount(0);
    await expect(page.getByTestId("add-lead-button")).toBeVisible();

    await page.getByTestId(`lead-row-${zoya.id}`).click();
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("journey-owner")).toBeVisible();
    await expect(page.getByTestId("journey-assign-owner")).toHaveCount(0);
    // Front Desk lacks VIEW_TREATMENT / VIEW_REVENUE: quiet note, never an error.
    await expect(page.getByTestId("journey-restricted-note")).toBeVisible();
    await expect(page.getByTestId("journey-treatments")).toHaveCount(0);
    await expect(page.getByTestId("journey-revenue")).toHaveCount(0);
    // (scoped: Next's route announcer also carries role=alert)
    await expect(page.getByTestId("journey-detail").getByRole("alert")).toHaveCount(0);

    const res = await page.request.patch(`${API}/journeys/${zoya.id}/owner`, { data: { ownerUserId: null } });
    expect(res.status()).toBe(403);
  });

  test("Add Lead still opens the quick-create drawer from the Leads toolbar", async ({ page }) => {
    await devLogin(page, "PATIENT_COORDINATOR");
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-lead-drawer")).toHaveCount(0);
  });
});
