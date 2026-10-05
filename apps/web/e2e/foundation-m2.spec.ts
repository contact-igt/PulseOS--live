import { test, expect, type Page } from "@playwright/test";
import { purgePatientsByPhone, sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const run = `${Date.now()}`.slice(-6);
const phones: string[] = [];

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

const uniquePhone = () => {
  const p = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  phones.push(p);
  return p;
};

// Beta V1 foundation: Departments, Lead Sources, intake without a name, source vs channel, edition gating.
// Runs on the Ophthalmology V1 demo tenant; every row it writes is removed afterwards.
test.describe("Beta V1 foundation (M1 + M2)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => {
    purgePatientsByPhone(phones);
    sql(`DELETE FROM lead_sources WHERE key LIKE 'custom_e2e_%' AND tenant_id IN (SELECT id FROM tenants WHERE name = 'PulseOS Ophthalmology V1 Demo')`);
  });

  test("a V1 tenant sees the core CRM and operational Analytics, a dimmed Beta V2 Inbox, and is sent home from a growth URL", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await expect(page.getByTestId("nav-/leads")).toBeVisible();
    await expect(page.getByTestId("nav-/campaigns")).toHaveCount(0);
    await expect(page.getByTestId("nav-/analytics")).toBeVisible(); // operational analytics is core (M6.6); marketing analytics stays V2
    await expect(page.getByTestId("nav-/inbox")).toHaveCount(0);
    await expect(page.getByTestId("nav-locked-/inbox")).toContainText("Beta V2");
    // No spend / ROAS panels on the V1 Command Centre.
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await expect(page.getByText("Spend at risk", { exact: false })).toHaveCount(0);

    await page.goto("/campaigns");
    await expect(page).toHaveURL(/command-centre/);
  });

  test("Add Lead needs only a phone: no name, a reported age, Instagram as the source and a phone call as the channel", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await expect(page.getByTestId("add-lead-drawer")).toBeVisible();

    const phone = uniquePhone();
    await page.getByTestId("lead-phone-input").fill(phone);
    await page.getByTestId("lead-age-input").fill("47");
    await page.getByTestId("lead-specialty-select").selectOption("CATARACT");
    await expect(page.getByTestId("lead-department")).toContainText("Ophthalmology");

    // The offered sources are the hospital's catalogue — and not the archived legacy ones.
    const sources = await page.locator("#lead-source option").allTextContents();
    expect(sources).toEqual(["Instagram", "Facebook", "YouTube", "Google", "Referral", "Direct", "Walk-in", "Phone", "WhatsApp", "Other"]);
    await page.locator("#lead-source").selectOption("instagram");
    await page.getByTestId("lead-channel-select").selectOption("MANUAL_CALL");

    const branch = page.locator("#lead-branch");
    await branch.selectOption(await branch.locator("option").nth(1).getAttribute("value") as string);
    await page.getByTestId("add-lead-submit").click();
    await expect(page.getByTestId("add-lead-drawer")).not.toBeVisible();

    // Unknown name is shown as such — and nothing was stored as a name.
    expect(sql(`SELECT count(*) FROM patients WHERE phone = '${phone}' AND name IS NULL`)).toBe("1");
    await page.getByText("Unknown patient").first().click();
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByText("47 yrs")).toBeVisible();
    await expect(page.getByTestId("journey-department")).toContainText("Ophthalmology");
    // SOURCE is Instagram; the first CHANNEL (a phone call) is on the timeline, separately.
    await expect(page.getByText("Instagram").first()).toBeVisible();
    await expect(page.getByTestId("timeline-channel").filter({ hasText: "Phone call" }).first()).toBeVisible();
  });

  test("Settings → Departments shows the installed template, can rename it, and archive hides its services from Add Lead", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=departments");
    await expect(page.getByTestId("department-OPHTHALMOLOGY")).toBeVisible();
    await expect(page.getByTestId("department-services-OPHTHALMOLOGY")).toContainText("Cataract");
    await expect(page.getByTestId("department-services-OPHTHALMOLOGY")).toContainText("Other");
    // The Gynecology template is offered; installing is not exercised here so the demo tenant stays Ophthalmology-only.
    await expect(page.getByTestId("department-install-gynecology")).toBeVisible();
    await expect(page.getByTestId("department-install-ophthalmology")).toHaveCount(0);

    await page.getByTestId("department-rename-OPHTHALMOLOGY").click();
    await expect(page.getByTestId("department-editor")).toBeVisible();
    await page.getByTestId("department-name-input").fill("Eye Care");
    await page.getByTestId("department-save").click();
    await expect(page.getByTestId("department-OPHTHALMOLOGY")).toContainText("Eye Care");

    await page.getByTestId("department-archive-OPHTHALMOLOGY").click();
    await expect(page.getByTestId("department-OPHTHALMOLOGY")).toContainText("Archived");
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await expect(page.locator("#lead-specialty option")).toHaveCount(1); // only the placeholder is left

    // Restore and rename back — leave the demo exactly as found.
    await page.goto("/settings?section=departments");
    await page.getByTestId("department-archive-OPHTHALMOLOGY").click();
    await expect(page.getByTestId("department-OPHTHALMOLOGY")).not.toContainText("Archived");
    await page.getByTestId("department-rename-OPHTHALMOLOGY").click();
    await page.getByTestId("department-name-input").fill("Ophthalmology");
    await page.getByTestId("department-save").click();
    await expect(page.getByTestId("department-OPHTHALMOLOGY")).toContainText("Ophthalmology");
  });

  test("Settings → Lead Sources: an Admin adds a source that Add Lead then offers, and archiving removes it again", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=sources");
    await expect(page.getByTestId("source-row-instagram")).toBeVisible();
    await expect(page.getByTestId("source-row-website")).toContainText("Archived"); // legacy value kept, not offered

    const name = `E2E Newspaper ${run}`;
    await page.getByTestId("source-add").click();
    await page.getByTestId("source-name-input").fill(name);
    await page.getByTestId("source-save").click();
    await expect(page.getByText(name)).toBeVisible();

    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    await expect(page.locator("#lead-source")).toContainText(name);
    await page.keyboard.press("Escape");

    await page.goto("/settings?section=sources");
    await page.getByTestId(`source-row-custom_e2e_newspaper_${run}`).getByRole("button", { name: "Archive" }).click();
    await expect(page.getByTestId(`source-row-custom_e2e_newspaper_${run}`)).toContainText("Archived");
  });

  test("Staff do not see Departments or Lead Sources, and the API refuses the install", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    await page.goto("/settings");
    await expect(page.getByTestId("settings-tab-departments")).toHaveCount(0);
    await expect(page.getByTestId("settings-tab-sources")).toHaveCount(0);
    const status = await page.evaluate(async () => {
      const r = await fetch("http://localhost:4310/departments/install", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateKey: "gynecology" }) });
      return r.status;
    });
    expect(status).toBe(403);
  });
});
