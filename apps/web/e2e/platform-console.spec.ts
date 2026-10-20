import { expect, test, type Page } from "@playwright/test";
import { sql } from "./support/fixtures";

// The company-side Platform Console. Runs against the local dev database (seeded demo platform staff, see
// apps/api/src/seed/demo/platform.ts). Tenants this spec creates are TEST workspaces named "E2E Platform …".

const PASSWORD = process.env.DEMO_PASSWORD ?? "";
const OWNER = "owner@platform.pulseos.local";

async function platformLogin(page: Page, email = OWNER) {
  await page.goto("/platform/login");
  await page.fill("#platform-email", email);
  await page.fill("#platform-password", PASSWORD);
  await page.getByTestId("platform-login-submit").click();
  await expect(page.getByTestId("platform-shell")).toBeVisible();
}

test.describe("Platform Console", () => {
  test.skip(!PASSWORD, "DEMO_PASSWORD is required");

  test("every /platform page needs a platform session", async ({ page }) => {
    await page.goto("/platform/tenants");
    await expect(page).toHaveURL(/\/platform\/login\?from=%2Fplatform%2Ftenants/);
    await expect(page.getByTestId("dev-login-block")).toHaveCount(0);
  });

  test("a hospital Super Admin cannot sign in to the console", async ({ page }) => {
    await page.goto("/platform/login");
    await page.fill("#platform-email", "gyn.superadmin@pulseos.local");
    await page.fill("#platform-password", PASSWORD);
    await page.getByTestId("platform-login-submit").click();
    await expect(page.getByTestId("platform-login-error")).toContainText("no platform access");
    await expect(page).toHaveURL(/\/platform\/login/);
  });

  test("overview shows live totals", async ({ page }) => {
    await platformLogin(page);
    await expect(page.getByTestId("platform-kpis")).toContainText("Total tenants");
    const total = Number(sql("select count(*) from tenants"));
    await expect(page.getByTestId("metric-tenants-count")).toHaveText(String(total));
  });

  test("create a tenant through the wizard, then suspend and reactivate it", async ({ page }) => {
    const tag = Date.now().toString(36);
    await platformLogin(page);
    await page.goto("/platform/tenants");
    await page.getByTestId("create-tenant").click();
    await page.getByTestId("tenant-name").fill(`E2E Platform ${tag}`);
    await expect(page.getByTestId("tenant-slug")).toHaveValue(`e2e-platform-${tag}`);
    await page.locator("#t-env").selectOption("TEST");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("branch-city-0").fill("Chennai");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("admin-name").fill("Esha Admin");
    await page.getByTestId("admin-email").fill(`esha.${tag}@e2e-platform.local`);
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("step-review")).toContainText(`/login/e2e-platform-${tag}`);
    await page.getByTestId("wizard-create").dblclick();

    await expect(page.getByTestId("platform-tenant-detail")).toBeVisible();
    await expect(page.getByTestId("created-banner")).toContainText("Tenant created as Draft");
    expect(sql(`select count(*) from tenants where login_slug = 'e2e-platform-${tag}'`)).toBe("1");
    await expect(page.locator('[data-tenant-status="DRAFT"]').first()).toBeVisible();
    await expect(page.getByTestId("check-admin_invited")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("check-admin_accepted")).toHaveAttribute("data-done", "false");

    await page.getByTestId("lifecycle-ACTIVATE").click();
    await page.getByTestId("action-dialog-reason").fill("E2E go-live");
    await page.getByTestId("action-dialog-confirm").click();
    await expect(page.locator('[data-tenant-status="ACTIVE"]').first()).toBeVisible();

    await page.getByTestId("lifecycle-SUSPEND").click();
    await page.getByTestId("action-dialog-reason").fill("E2E pause");
    await expect(page.getByTestId("action-dialog-confirm")).toBeDisabled();
    await page.getByTestId("action-dialog-typed").fill(`e2e-platform-${tag}`);
    await page.getByTestId("action-dialog-confirm").click();
    await expect(page.locator('[data-tenant-status="SUSPENDED"]').first()).toBeVisible();

    await page.getByTestId("lifecycle-REACTIVATE").click();
    await page.getByTestId("action-dialog-reason").fill("E2E resume");
    await page.getByTestId("action-dialog-confirm").click();
    await expect(page.locator('[data-tenant-status="ACTIVE"]').first()).toBeVisible();

    expect(sql(`select count(*) from platform_audit_events where tenant_id = (select id from tenants where login_slug = 'e2e-platform-${tag}') and action in ('tenant.created', 'tenant.activated', 'tenant.suspended', 'tenant.reactivated')`)).toBe("4");
  });

  test("directory search is server-side and opens the tenant", async ({ page }) => {
    await platformLogin(page);
    await page.goto("/platform/tenants");
    await page.getByTestId("tenant-search").fill("namokar-v1");
    await expect(page.getByTestId("tenant-row-namokar-v1")).toBeVisible();
    await expect(page.locator('[data-testid^="tenant-row-"]')).toHaveCount(1);
    await page.getByTestId("tenant-row-namokar-v1").click();
    await expect(page.getByTestId("tenant-login-link")).toContainText("/login/namokar-v1");
  });
});
