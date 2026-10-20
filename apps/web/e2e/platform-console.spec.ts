import { expect, test, type Page } from "@playwright/test";
import { sql } from "./support/fixtures";

// The company-side Platform Console. Runs against the local dev database (seeded demo platform staff, see
// apps/api/src/seed/demo/platform.ts). Tenants this spec creates are TEST workspaces named "E2E Platform …".

const PASSWORD = process.env.DEMO_PASSWORD ?? "";
const OWNER = "owner@platform.pulseos.local";

/** What the API's local outbox "sent" to this address (development only; there is no email provider). */
async function linkFor(email: string): Promise<string> {
  const res = await fetch("http://localhost:4310/dev/outbox");
  const { messages } = (await res.json()) as { messages: { to: string; text: string }[] };
  const msg = messages.find((m) => m.to === email);
  if (!msg) throw new Error(`no outbox message for ${email}`);
  return /(https?:\/\/\S+#token=[A-Za-z0-9_-]+)/.exec(msg.text)![1]!;
}

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

  test("invite a hospital user, who sets their own password and signs in; then change their role", async ({ page, browser }) => {
    const tag = Date.now().toString(36);
    const email = `nila.${tag}@e2e-platform.local`;
    await platformLogin(page);
    await page.goto("/platform/tenants?q=gyn-demo");
    await page.getByTestId("tenant-row-gyn-demo").click();
    await page.getByRole("tab", { name: "Users" }).click();
    await page.getByTestId("invite-member").click();
    await page.getByTestId("member-name").fill("Nila Frontdesk");
    await page.getByTestId("member-email").fill(email);
    await page.getByTestId("action-dialog-confirm").click();
    await expect(page.getByTestId("tenant-users-notice")).toContainText(`Invitation sent to ${email}`);
    await expect(page.getByTestId(`member-${email}`)).toContainText("Invited");

    // The invitee, in their own browser: the link carries the token in the fragment only.
    const link = await linkFor(email);
    const invitee = await (await browser.newContext()).newPage();
    await invitee.goto(link);
    await expect(invitee).not.toHaveURL(/token=/);
    await invitee.fill("#new-password", "nila-chooses-this-1");
    await invitee.fill("#confirm-password", "nila-chooses-this-1");
    await invitee.getByTestId("set-password-submit").click();
    await expect(invitee.getByTestId("set-password-done")).toBeVisible();
    await invitee.goto(link);
    await expect(invitee.getByTestId("set-password-invalid")).toBeVisible();
    const login = await invitee.request.post("http://localhost:4310/auth/login", { data: { email, password: "nila-chooses-this-1" } });
    expect(login.status()).toBe(200);

    // Back in the console: the person's page, then a role change.
    await page.goto(`/platform/users?q=${encodeURIComponent(email)}`);
    await page.getByTestId(`user-row-${email}`).click();
    await expect(page.getByTestId("platform-user-detail")).toContainText(email);
    await page.getByTestId("membership-menu-gyn-demo").click();
    await page.getByTestId("row-menu-role").click();
    await page.locator("#new-role").selectOption("PATIENT_COORDINATOR");
    await page.getByTestId("action-dialog-confirm").click();
    await expect(page.getByTestId("user-notice")).toContainText("Role changed to Coordinator");
    expect(sql(`select role from users where email = '${email}'`)).toBe("PATIENT_COORDINATOR");
    await expect(page.getByTestId("user-history")).toContainText("PATIENT_COORDINATOR");
  });

  test("access page lists invitations and resends without ever showing a link", async ({ page }) => {
    await platformLogin(page);
    await page.goto("/platform/access");
    await expect(page.getByTestId("platform-access")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("#token=");
  });

  test("support mode: reason, persistent banner naming the staff member, read-only, ended and audited", async ({ page }) => {
    await platformLogin(page, "support@platform.pulseos.local");
    await page.goto("/platform/tenants?q=eye-demo");
    await page.getByTestId("tenant-row-eye-demo").click();
    await page.getByTestId("open-as-support").click();
    await expect(page.getByTestId("support-tenant")).not.toHaveValue("");
    await expect(page.getByTestId("start-support-submit")).toBeDisabled();
    await page.getByTestId("support-reason").fill("E2E: checking the command centre for a client ticket");
    await page.getByTestId("start-support-submit").click();

    await expect(page).toHaveURL(/\/command-centre/);
    const banner = page.getByTestId("support-banner");
    await expect(banner).toContainText("Support Mode — PulseOS Ophthalmology Demo");
    await expect(banner).toContainText("Meera Iyer");
    await expect(banner).toContainText("read-only");
    // A write through the API is refused while read-only.
    const write = await page.request.post("http://localhost:4310/lead-sources", { data: { label: "E2E support write" }, headers: { origin: "http://localhost:3310" } });
    expect(write.status()).toBe(403);
    // Still visible on another page.
    await page.goto("/patients");
    await expect(banner).toBeVisible();

    await page.getByTestId("end-support").click();
    await expect(page).toHaveURL(/\/platform\/support/);
    await expect(page.getByTestId("start-support")).toBeVisible();
    expect(Number(sql("select count(*) from platform_audit_events where action = 'support.ended' and actor_label = 'support@platform.pulseos.local'"))).toBeGreaterThan(0);
  });
});
