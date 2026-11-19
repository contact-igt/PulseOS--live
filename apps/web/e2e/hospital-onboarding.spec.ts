import { test, expect } from "@playwright/test";

test("public onboarding explains how to request a workspace", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("signup-link").click();
  await page.waitForURL("**/signup");
  await expect(page.getByRole("heading", { name: "Get PulseOS for your hospital" })).toBeVisible();
  await expect(page.getByText(/Contact your PulseOS representative/)).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await page.waitForURL("**/login");
});

test("hospital invitation accepts a password using the fragment token", async ({ page }) => {
  const token = "a".repeat(43);
  const password = "A longer secret password";
  await page.route("**/auth/hospital-invitations/redeem", async (route) => {
    const headers = {
      "access-control-allow-origin": route.request().headers().origin ?? "http://localhost:3310",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ token, password });
    await route.fulfill({ status: 200, headers, json: { accepted: true } });
  });
  await page.goto(`/hospital-invitation#${token}`);
  await expect(page).toHaveURL(/\/hospital-invitation$/);
  await page.getByLabel("New password", { exact: true }).fill(password);
  const confirmation = page.getByLabel("Confirm password", { exact: true });
  await confirmation.fill("A different test password");
  await page.getByRole("button", { name: "Show confirm password" }).click();
  await expect(confirmation).toHaveAttribute("type", "text");
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Hide confirm password" }).click();
  await expect(confirmation).toHaveAttribute("type", "password");
  const submit = page.getByRole("button", { name: "Accept invitation" });
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: "Passwords do not match." })).toBeVisible();
  await confirmation.fill(password);
  await submit.click();
  await expect(page.getByRole("status")).toContainText("Your password is set");
  expect((await page.context().cookies()).some((cookie) => cookie.name === "pulseos_session")).toBe(false);
});

test("Platform Super Admin can queue a new invitation email and observe provider acceptance", async ({ page }) => {
  const id = "e04edfd0-c83c-4c44-8a2b-e1fb72db87b7";
  let queued = false;
  let accepted = false;
  await page.route(/\/platform\/(me|hospitals\/)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() || url.origin === new URL(page.url()).origin) return route.continue();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? "http://localhost:3310",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-pulseos-platform, idempotency-key",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith("/me")) return route.fulfill({ headers, json: {
      id, email: "platform@example.test", role: "PLATFORM_SUPER_ADMIN", permissions: ["hospital:read", "hospital:invite"],
    } });
    if (url.pathname.endsWith("/invitation-resend")) {
      expect(request.method()).toBe("POST");
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      queued = true;
      return route.fulfill({ headers, status: 202, json: { queued: true } });
    }
    return route.fulfill({ headers, json: {
      id, tenantId: id, onboardingId: id, name: "Invitation Hospital", active: false, provisioning: "created",
      template: "installed", invitation: "pending", ready: false, readinessFailures: ["invitation_acceptance_required"],
      invitationDelivery: { enabled: true, status: accepted ? "accepted" : queued ? "pending" : "failed",
        expiresAt: "2026-11-20T00:00:00Z", attempts: queued && !accepted ? 0 : 1,
        failure: queued ? null : "mail_attempt_failed" },
    } });
  });
  await page.goto("/platform/hospitals/" + id);
  await expect(page.getByText("Delivery failed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resend invitation email" }).click();
  await expect(page.getByText("Invitation email queued.")).toBeVisible();
  await expect(page.getByText("Delivery pending", { exact: true })).toBeVisible();
  accepted = true;
  await expect(page.getByText("Email provider accepted")).toBeVisible({ timeout: 10000 });
});
