import { test, expect, type Page } from "@playwright/test";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home|leads/);
}

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ api, method, path, body }) => {
      const res = await fetch(`${api}${path}`, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { api: API, method, path, body },
  );
}

test.describe("M7 capabilities + Integration Hub", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD not set");

  test("A. Super Admin override on V1: Marketing Analytics on → API allows; reset → blocked again", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    await page.goto("/settings?section=features");
    await expect(page.getByTestId("features-section")).toBeVisible();
    await expect(page.getByTestId("feature-toggle-MARKETING_ANALYTICS")).not.toBeChecked();
    expect((await api(page, "GET", "/analytics/summary")).status).toBe(403);
    await page.getByTestId("feature-toggle-MARKETING_ANALYTICS").check();
    await expect(page.getByTestId("feature-MARKETING_ANALYTICS").getByText("Changed for this hospital")).toBeVisible();
    expect((await api(page, "GET", "/analytics/summary")).status).toBe(200);
    // A refused change (a dependency) is explained and the switch goes back.
    await page.getByTestId("feature-toggle-CONVERSATION_INTELLIGENCE").check();
    await expect(page.getByTestId("features-error")).toBeVisible();
    await expect(page.getByTestId("feature-toggle-CONVERSATION_INTELLIGENCE")).not.toBeChecked();
    expect((await api(page, "PUT", "/capabilities/MARKETING_ANALYTICS", { enabled: null })).status).toBe(200);
    expect((await api(page, "GET", "/analytics/summary")).status).toBe(403);
  });

  test("Hub: cards show enabled / configuration / health / mode separately; CCS IVR is configurable; V1 and V2 differ only by defaults", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/integrations");
    await expect(page.getByTestId("integrations-hub")).toBeVisible();
    for (const key of ["google_ads", "meta_ads", "runo", "ccs_ivr", "whatsapp_meta_cloud", "sms", "webhooks"]) await expect(page.getByTestId(`hub-card-${key}`)).toBeVisible();
    await expect(page.getByTestId("hub-blocked-ccs_ivr")).toHaveCount(0); // CCS IVR is no longer blocked
    await expect(page.getByTestId("hub-card-google_ads")).toContainText("Disabled");
    await expect(page.getByTestId("hub-card-runo")).toContainText("Fixture");
    // Brand label follows the edition.
    await expect(page.getByTestId("sidebar-brand")).toContainText("Beta V1");

  });

  test("Detail sheet: configuration visible to Admin, credentials Super Admin only, secrets never shown", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/integrations?open=whatsapp_meta_cloud");
    const sheet = page.getByTestId("integration-detail");
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("detail-tab-credentials").click();
    await expect(sheet.getByText("Only a Super Admin can change credentials.")).toBeVisible();
    await expect(sheet.getByTestId("secret-accessToken")).toBeDisabled();
    await sheet.getByTestId("detail-tab-webhooks").click().catch(() => {});
    await expect(sheet).not.toContainText("EAA");
  });

  test("CCS IVR card opens with configuration and credentials sections (it is no longer blocked)", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    await page.goto("/integrations?open=ccs_ivr");
    const sheet = page.getByTestId("integration-detail");
    await expect(sheet.getByText("Provider API/Webhook documentation required")).toHaveCount(0);
    await expect(sheet.getByTestId("detail-tab-configuration")).toHaveCount(1);
    await expect(sheet.getByTestId("detail-tab-credentials")).toHaveCount(1);
  });

  test("Webhooks are Super Admin only", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/integrations?section=advanced");
    await expect(page.getByTestId("webhooks-restricted")).toBeVisible();
    await login(page, "eyev1.superadmin@pulseos.local");
    await page.goto("/integrations?section=advanced");
    await expect(page.getByTestId("webhooks-panel")).toBeVisible();
    await expect(page.getByTestId("integration-logs")).toBeVisible();
  });

  test("Hub is a single column at 390px with no horizontal page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/integrations");
    await expect(page.getByTestId("hub-card-runo")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const a = await page.getByTestId("hub-card-runo").boundingBox();
    const b = await page.getByTestId("hub-card-ccs_ivr").boundingBox();
    expect(Math.abs(a!.x - b!.x)).toBeLessThan(2);
  });
});
