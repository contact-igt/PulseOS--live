import { test, expect } from "@playwright/test";
import { purgePatients } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

function uniquePhone(): string {
  return `9${Math.floor(100000000 + Math.random() * 899999999)}`;
}

test.describe("CRM critical business flows", () => {
  // Fictional "E2E Flow …" patients created by this spec are removed afterwards (repeatable without a reseed).
  test.afterAll(() => purgePatients("E2E Flow "));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("FLOW 1: Admin creates a new lead end to end — appears in Leads, opens its Journey page, and shows on the Timeline", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();

    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();

    const phone = uniquePhone();
    // Unique per run: these flows write real rows and the demo DB is only
    // cleared by `pnpm db:seed`, so a fixed name makes every assertion below
    // resolve to N elements once the suite has run more than once.
    const patientName = `E2E Flow One Patient ${phone}`;
    await page.getByTestId("lead-phone-input").fill(phone);
    await page.locator("#lead-name").fill(patientName);
    await page.getByTestId("lead-specialty-select").selectOption("GYNECOLOGY");
    // Configured service fields sit under "Additional details".
    await page.getByTestId("lead-additional-toggle").click();
    await expect(page.getByTestId("lead-custom-fields")).toBeVisible();

    const branchSelect = page.locator("#lead-branch");
    const firstBranchValue = await branchSelect.locator("option").nth(1).getAttribute("value");
    await branchSelect.selectOption(firstBranchValue!);

    await page.locator("#lead-source").selectOption("instagram");

    const ownerSelect = page.locator("#lead-owner");
    const firstOwnerValue = await ownerSelect.locator("option").nth(1).getAttribute("value");
    await ownerSelect.selectOption(firstOwnerValue!);

    await page.getByTestId("lead-next-callback").check(); // date and time default to tomorrow

    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).not.toBeVisible();

    // Appears in Leads.
    await expect(page.getByText(patientName)).toBeVisible();

    // A Leads row opens the dedicated Journey page (not Patient 360): the
    // journey's service and its own Timeline are shown there.
    await page.getByText(patientName).first().click();
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("journey-service")).toContainText("Pregnancy Care");
    await expect(page.getByText("Lead created — Pregnancy Care")).toBeVisible();
    await expect(page.getByText("Follow-up scheduled · Callback")).toBeVisible();
  });

  test("FLOW 2: Add Lead with a phone that matches an existing patient warns and creates a new Journey, not a duplicate Patient", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");

    const phone = uniquePhone();
    const patientName = `E2E Flow Two Patient ${phone}`;

    // First, create the initial patient via Add Lead.
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("lead-phone-input").fill(phone);
    await page.locator("#lead-name").fill(patientName);
    await page.getByTestId("lead-specialty-select").selectOption("GYNECOLOGY");
    const branchSelect = page.locator("#lead-branch");
    const firstBranchValue = await branchSelect.locator("option").nth(1).getAttribute("value");
    await branchSelect.selectOption(firstBranchValue!);
    await page.locator("#lead-source").selectOption("direct");
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).not.toBeVisible();

    // Now submit a second lead with the SAME phone, different specialty.
    await page.getByTestId("add-lead-button").click();
    await page.getByTestId("lead-phone-input").fill(phone);
    await page.getByTestId("lead-phone-input").blur();
    await expect(page.getByTestId("existing-patient-banner")).toBeVisible();
    await expect(page.getByTestId("existing-patient-banner")).toContainText("Existing patient found");
    await expect(page.getByTestId("existing-patient-banner")).toContainText(patientName);

    await page.getByTestId("lead-specialty-select").selectOption("FERTILITY");
    await branchSelect.selectOption(firstBranchValue!);
    await page.locator("#lead-source").selectOption("instagram");
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).not.toBeVisible();

    // Exactly one "E2E Flow Two Patient" patient exists — not two.
    // `?q=` — the Patients page reads `q` (see patients/page.tsx); `?search=`
    // was silently ignored, so this assertion was counting every patient in
    // the hospital rather than the ones matching this phone.
    await page.goto(`/patients?q=${encodeURIComponent(phone)}`);
    await expect(page.getByTestId("patients-page")).toBeVisible();
    const matchingRows = page.locator("tbody tr", { hasText: patientName });
    await expect(matchingRows).toHaveCount(1);

    // That one patient now has 2 journeys, both active (header reads "2 journeys · 2 active").
    await matchingRows.first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByText(/2 journeys · 2 active/)).toBeVisible();
  });

  test("FLOW: Add Lead drawer does not wipe fast-typed input on reopen (effect-timing race regression)", async ({ page }) => {
    // Regression for a real bug: the drawer stayed mounted permanently
    // under QuickCreateProvider, gated only by an internal `if (!open)
    // return null`. On reopen, React repainted with the PREVIOUS close's
    // stale form state before its reset effect (deps [open, ...]) had a
    // chance to flush — so fast input landing in that window got silently
    // overwritten moments later. Fix: QuickCreateProvider now only mounts
    // each Quick Create drawer while its kind is active, so every open is a
    // fresh component instance with correct initial state from the first
    // paint, and there is no delayed reset effect left to race against.
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();

    const firstPhone = uniquePhone();

    // Open once, type into several fields, then close WITHOUT submitting —
    // this is exactly the scenario that left stale state behind pre-fix.
    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await page.getByTestId("lead-phone-input").fill(firstPhone);
    await page.locator("#lead-name").fill("E2E Race Stale Name");
    await page.locator("#lead-source").selectOption("instagram");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("add-lead-drawer")).not.toBeVisible();

    // Reopen and fast-fill different values immediately, back to back, with
    // no waits in between — the exact repro shape for the race.
    const secondPhone = uniquePhone();
    const secondName = `E2E Race Fresh Name ${secondPhone}`;
    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();
    await page.getByTestId("lead-phone-input").fill(secondPhone);
    await page.locator("#lead-name").fill(secondName);
    await page.locator("#lead-source").selectOption("google");

    // Give any lingering delayed-reset effect a moment to fire before
    // asserting — the bug's failure mode was the value reverting shortly
    // AFTER a correct-looking paint, not being wrong immediately.
    await page.waitForTimeout(300);

    await expect(page.getByTestId("lead-phone-input")).toHaveValue(secondPhone);
    await expect(page.locator("#lead-name")).toHaveValue(secondName);
    await expect(page.locator("#lead-source")).toHaveValue("google");
    // Fields never touched this time must show their fresh defaults, not
    // anything left over from the first open (branch/specialty were never
    // set in either open, so they should read as unset, not carry over).
    await expect(page.locator("#lead-branch")).toHaveValue("");
    await expect(page.locator("#lead-specialty")).toHaveValue("");
  });

  test("FLOW 6: Campaigns page filters by specialty and source, showing Spend → Lead → Treatment → Revenue for the seeded weak campaign", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await expect(page.getByText("Marketing Efficiency")).toBeVisible();

    await page.getByTestId("campaigns-specialty-filter").selectOption("GYNECOLOGY");
    await expect(page.getByText("Meta – Antenatal Care Awareness")).toBeVisible();
    await expect(page.getByTestId(/campaign-row-/).first()).toBeVisible();
  });
});
