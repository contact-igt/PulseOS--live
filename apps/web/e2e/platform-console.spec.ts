import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import type { PlatformAccount, PlatformHospital } from "@pulseos/types";

const account: PlatformAccount = {
  id: "1", email: "platform@example.test", role: "PLATFORM_SUPER_ADMIN",
  permissions: ["dashboard:read", "hospital:read", "hospital:create", "hospital:invite", "hospital:retry", "hospital:activate", "team:manage", "audit:read"],
};

test("signs in as Super Admin with email and password and retries hospital creation with the identical request", async ({ page }) => {
  let loggedIn = false;
  let created: PlatformHospital | undefined;
  let request: { key: string; body: unknown } | undefined;
  let writes = 0;
  await page.route(/\/platform\/(me|login|dashboard|hospitals)(?:[/?]|$)/, async (route) => {
    const call = route.request();
    const url = new URL(call.url());
    if (call.isNavigationRequest() || url.origin === new URL(page.url()).origin) return route.continue();
    const { pathname } = url;
    const headers = {
      "access-control-allow-origin": call.headers().origin ?? "http://localhost:3310",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-pulseos-platform, idempotency-key",
    };
    if (call.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const send = (status: number, json: unknown) => route.fulfill({ status, json, headers });

    if (pathname === "/platform/login") {
      expect(call.headers()["x-pulseos-platform"]).toBe("1");
      expect(call.postDataJSON()).toEqual({ email: account.email, password: "Synthetic password only" });
      loggedIn = true;
      return send(200, { authenticated: true });
    }
    if (pathname === "/platform/me") return loggedIn ? send(200, account) : send(401, { error: "platform_credentials_required" });
    if (pathname === "/platform/dashboard") {
      return send(200, { total: 0, active: 0, pending: 0, loginDisabled: 0, templateFailures: 0, pendingInvitations: 0, recentHospitals: [], recentAudit: [] });
    }
    if (pathname === "/platform/hospitals" && call.method() === "POST") {
      const operation = { key: call.headers()["idempotency-key"]!, body: call.postDataJSON() };
      expect(operation.body).toMatchObject({ discoverySource: "Other" });
      writes += 1;
      if (writes === 1) {
        request = operation;
        return route.abort("timedout");
      }
      expect(operation).toEqual(request);
      created = {
        id: operation.key, onboardingId: operation.key, tenantId: "tenant-1", name: "Workshop Hospital", edition: "BETA_V1_CORE",
        slug: "workshop-hospital", loginPath: "/login/workshop-hospital", createdAt: "2026-01-01T00:00:00Z",
        provisioning: "created", template: "installed", invitation: "not_issued", active: false, ready: false,
        readinessFailures: ["invitation_acceptance_required"],
      };
      return send(200, created);
    }
    if (pathname.endsWith("/invitation")) return send(200, { invitationPath: "/hospital-invitation#example", recipient: "owner@example.test", expiresAt: "2026-01-01T00:00:00Z" });
    if (created && pathname.endsWith(created.id)) return send(200, created);
    return send(200, { items: [], hasMore: false });
  });

  await page.goto("/platform/login");
  await page.getByLabel("Platform email").fill(account.email);
  await expect(page.getByText("Use an authenticator code", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Use a setup token", { exact: true })).toHaveCount(0);
  await page.getByLabel("Password").fill("Synthetic password only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Platform dashboard" })).toBeVisible({ timeout: 20000 });

  const navigation = page.getByRole("navigation", { name: "Platform" });
  await expect(navigation.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Open Platform menu" });
  await expect(navigation).toBeHidden();
  await menu.click();
  await navigation.getByRole("link", { name: "Hospitals" }).click();
  await expect(navigation).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("link", { name: "Create hospital" }).click();
  await expect(navigation.getByRole("link", { name: "Hospitals" })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Organization type").selectOption("Eye Hospital");
  await page.getByLabel("Department", { exact: true }).selectOption("Ophthalmology");
  await page.getByLabel("First administrator name").fill("Asha Verma");
  await page.getByLabel("First administrator email").fill("owner@example.test");
  await page.getByLabel("First administrator phone").fill("+91 98765 43210");
  await page.getByLabel("Address", { exact: true }).fill("123 Test Road");
  await page.getByLabel("City").fill("Bengaluru");
  await page.getByLabel("State").fill("Karnataka");
  await page.getByLabel("PIN code").fill("560001");
  await expect(page.getByLabel("Discovery source")).toHaveCount(0);
  await page.getByLabel("Hospital name").fill("Workshop Hospital");
  await expect(page.getByLabel("Hospital name")).toHaveValue("Workshop Hospital");
  await page.getByRole("button", { name: "Create hospital" }).click();
  await expect(page.getByLabel("Hospital name")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same request" }).click();
  await expect(page.getByRole("heading", { name: "Workshop Hospital" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Activate hospital" })).toHaveCount(0);
  await expect(page.getByText("The first hospital administrator must accept their invitation.")).toBeVisible();
  await page.getByRole("button", { name: "Issue administrator invitation" }).click();
  await expect(page.getByLabel("Hospital administrator invitation link")).toHaveValue(/hospital-invitation#example$/);
  await page.getByRole("button", { name: "Hide link" }).click();
  await expect(page.getByLabel("Hospital administrator invitation link")).toHaveCount(0);
  expect(writes).toBe(2);
  await page.goto("/platform/login");
  await expect(page).toHaveURL(/\/platform$/);
  await expect(page.getByRole("heading", { name: "Platform dashboard" })).toBeVisible();
});

test("enrolls MFA and signs out through the local platform API", async ({ page, context }) => {
  const invitation = process.env.PLATFORM_E2E_SETUP_TOKEN;
  test.skip(!invitation, "Requires a one-time setup token from an isolated synthetic database");
  await page.goto("/platform/login?mode=setup");
  await page.getByLabel("One-time setup token").fill(invitation!);
  await page.getByLabel("Password").fill("Synthetic browser enrollment password");
  await page.getByRole("button", { name: "Continue to MFA setup" }).click();

  const setupKey = (await page.locator("code").textContent())!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...setupKey].map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, "0")).join("");
  const secret = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const code = String((mac.readUInt32BE(mac.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  await page.getByLabel("Authenticator code").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page.getByRole("heading", { name: "Platform dashboard" })).toBeVisible();
  const cookies = await context.cookies("http://localhost:4310/platform/me");
  expect(cookies).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "pulseos_platform_session", path: "/platform", httpOnly: true, sameSite: "Strict" }),
  ]));
  expect((await context.cookies("http://localhost:4310/patients")).some((cookie) => cookie.name === "pulseos_platform_session")).toBe(false);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/platform/login");
  expect((await context.cookies("http://localhost:4310/platform/me")).some((cookie) => cookie.name === "pulseos_platform_session")).toBe(false);
});

test("requests recovery and shows approval only to a different Super Admin", async ({ page }) => {
  const id = "1f5cc690-8b4a-46b8-8c2a-76fa6bd63a6a";
  const secret = "r".repeat(43);
  let state: "pending" | "approved" | null = null;
  let reviewer = false;
  await page.route(/\/platform\/(me|administrators)(?:[/?]|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() || url.origin === new URL(page.url()).origin) return route.continue();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? "http://localhost:3310",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-pulseos-platform",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ headers, status: 204 });
    const send = (json: unknown) => route.fulfill({ headers, json });
    if (url.pathname.endsWith("/me")) return send(reviewer ? { ...account, id: "ae44151d-13bf-4076-a962-ec0ee49ed890" } : account);
    if (url.pathname.endsWith("/recovery")) {
      if (request.method() === "GET") return send({ items: [{ id, action: "mfa_recovery_approved", actorId: account.id, createdAt: "2026-11-19T00:00:00Z" }] });
      if (!state) {
        expect(request.postDataJSON()).toEqual({ action: "request" });
        state = "pending";
        return send({ updated: true });
      }
      expect(request.postDataJSON()).toEqual({ action: "approve", code: "123456" });
      state = "approved";
      return send({ recoveryToken: secret, expiresAt: "2026-11-19T00:30:00Z" });
    }
    return send({ hasMore: false, items: [{
      id, email: "recover@example.test", role: "PLATFORM_OPERATIONS_ADMIN", permissions: [], disabled: false,
      enrolled: state !== "approved", canRecover: true, recovery: state && {
        status: state, expiresAt: "2026-11-19T00:30:00Z", canApprove: reviewer && state === "pending",
      },
    }] });
  });
  await page.goto("/platform/administrators");
  await page.getByText("recover@example.test", { exact: false }).click();
  await page.getByRole("button", { name: "Request MFA recovery" }).click();
  await expect(page.getByText("Recovery request created.")).toBeVisible();
  await expect(page.getByText(/A different Super Admin must approve/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve recovery" })).toHaveCount(0);
  reviewer = true;
  await page.reload();
  await page.getByText("recover@example.test", { exact: false }).click();
  await page.getByLabel("Your current authenticator code").fill("123456");
  await page.getByRole("button", { name: "Approve recovery" }).click();
  await expect(page.getByLabel("Administrator recovery token")).toHaveValue(secret);
  await page.getByRole("button", { name: "Hide token" }).click();
  await expect(page.getByLabel("Administrator recovery token")).toHaveCount(0);
  await page.getByRole("button", { name: "Recovery history" }).click();
  await expect(page.getByText(/Mfa recovery approved/)).toBeVisible();
});
