import { expect, test } from "@playwright/test";

test("filters and refreshes messaging exceptions within the Platform console", async ({ page }) => {
  const tenantId = "e04edfd0-c83c-4c44-8a2b-e1fb72db87b7";
  const command = {
    id: "574484df-f207-4699-9614-a08814e769fb", tenantId, hospitalName: "Operations Hospital",
    onboardingId: null, action: "pause", createdAt: "2026-11-18T00:00:00Z", verifiedAt: null, attempts: 3,
  };
  let failRefresh = false;
  await page.route(/\/platform\/(me|dashboard|operations\/messaging)/, async (route) => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? "http://localhost:3310",
      "access-control-allow-credentials": "true",
    };
    const url = new URL(request.url());
    if (url.pathname.endsWith("/me")) return route.fulfill({ headers, json: {
      id: tenantId, email: "operations@example.test", role: "PLATFORM_OPERATIONS_ADMIN", permissions: ["hospital:lifecycle:read"],
    } });
    if (url.pathname.endsWith("/dashboard")) return route.fulfill({ headers, json: {
      total: 4, active: 2, provisioning: 1, suspended: 1, pending: 1, loginDisabled: 2, templateFailures: 0,
      failedOnboarding: 0, pendingInvitations: 1, pendingCommands: 3, failedCommands: 1, agedCommands: 2, integrationProblems: 1,
      recentHospitals: [], recentAudit: [],
    } });
    if (failRefresh) return route.fulfill({ headers, status: 503, json: { error: "unavailable" } });
    const status = url.searchParams.get("status");
    const hospital = url.searchParams.get("tenantId");
    const pageNumber = url.searchParams.get("page");
    const failed = { ...command, status: "failed", classification: "management_unauthorized", pendingMinutes: null };
    const pending = { ...command, status: "pending", classification: "provider_pausing", pendingMinutes: 16 };
    const items = hospital ? [] : [status === "failed" || pageNumber === "2" ? failed : pending];
    return route.fulfill({ headers, json: { items, hasMore: !status && !hospital && pageNumber === "1" } });
  });
  await page.goto("/platform");
  await expect(page.getByText("Commands pending at least 15 min").locator("..")).toContainText("2");
  await page.getByRole("link", { name: "Review messaging exceptions" }).click();
  await expect(page.getByText("Pending 16 min")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Management unauthorized")).toBeVisible();
  await page.getByLabel("Command status").selectOption("pending");
  await expect(page.getByText("Pending 16 min")).toBeVisible();
  await page.getByLabel("Command status").selectOption("failed");
  await expect(page.getByText("Management unauthorized")).toBeVisible();
  await expect(page.getByRole("link", { name: "Operations Hospital" })).toHaveAttribute("href", "/platform/hospitals/" + tenantId + "?legacy=1");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Hospital tenant ID")).toBeVisible();
  await page.getByLabel("Hospital tenant ID").fill(tenantId);
  await page.getByRole("button", { name: "Filter by hospital" }).click();
  await expect(page.getByText("No matching commands.")).toBeVisible();
  failRefresh = true;
  await page.getByRole("button", { name: "Refresh list" }).click();
  await expect(page.getByText("The request could not be completed. Try again.", { exact: true })).toBeVisible();
});
