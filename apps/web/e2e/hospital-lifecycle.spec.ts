import { expect, test } from "@playwright/test";
import type { HospitalArchivalAssessment } from "@pulseos/types";

test("confirms a suspension and restoration from the hospital detail", async ({ page }) => {
  const id = "e04edfd0-c83c-4c44-8a2b-e1fb72db87b7";
  let version = 1;
  let active = true;
  let remote: "ACTIVE" | "PAUSING" | "PAUSED" = "ACTIVE";
  let resumed = false;
  let commandFailed = false;
  let bindingCurrent = true;
  await page.route(/\/platform\/(me|hospitals\/)/, async (route) => {
    const call = route.request();
    const url = new URL(call.url());
    if (call.isNavigationRequest() || url.origin === new URL(page.url()).origin) return route.continue();
    const headers = {
      "access-control-allow-origin": call.headers().origin ?? "http://localhost:3310",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-pulseos-platform",
    };
    if (call.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const send = (json: unknown) => route.fulfill({ status: 200, json, headers });
    const lifecycle = () => ({
      status: active ? "ACTIVE" : "SUSPENDED", version, loginEnabled: active, changedAt: null,
      suspension: active ? null : { reason: "OPERATIONS", explanation: null },
    });
    if (url.pathname.endsWith("/me")) return send({
      id, email: "operator@example.test", role: "PLATFORM_SUPER_ADMIN",
      permissions: ["hospital:read", "hospital:lifecycle:read", "hospital:suspend", "hospital:restore"],
    });
    if (url.pathname.endsWith("/lifecycle-history")) return send({ items: [], hasMore: false });
    if (url.pathname.endsWith("/archival-assessment")) return send({
      assessedAt: "2026-11-18T00:00:00Z",
      lifecycle: { state: active ? "ACTIVE" : "SUSPENDED", version },
      onboarding: { invitation: "redeemed", delivery: null, template: "installed" },
      evidence: {
        appointments: 1, futureAppointments: 1, pendingTasks: 0, pendingNotifications: 1, unknownDispatches: 0,
        pendingWebhooks: 0, pendingCommands: 0, recordedFailedCommands: 0, openConnectorEvents: 0,
        heldMetaLeads: 2, runningAdsSyncs: 0, pendingOrRunningCallWork: 0,
      },
      recordedRevenue: false,
      whatsNexus: { binding: "LIVE", observation: {
        state: remote, observedAt: "2026-11-18T00:00:00Z", alignment: "historical", unresolvedPermits: null,
      } },
      findings: [{ classification: "POLICY_NOT_APPROVED", basis: "policy", reason: "Archival and retention policy requires approval." }],
    } satisfies HospitalArchivalAssessment);
    if (url.pathname.endsWith("/lifecycle-operations")) return send({
      providerCoordination: "external_pause_unverified", heldInbound: 2, queuedOutbound: 1,
      expiringMetaLeads: 1, exhaustedMetaLeads: 1,
      unresolvedDispatches: 1, oldestPendingAt: null, lastVerifiedProviderHealthAt: null,
      restorationReconciliation: active ? "awaiting_review" : "held",
      messaging: {
        enabled: true, bindingCurrent, history: [],
        latest: version === 1 ? null : {
          id, action: resumed ? "resume" : "pause", status: commandFailed ? "failed" : remote === "PAUSING" ? "pending" : "confirmed",
          error: commandFailed ? "management_unauthorized" : null,
          lifecycleVersion: version === 2 || !resumed ? 2 : version, verifiedAt: "2026-11-18T00:00:00Z",
          observation: { state: remote, unresolvedPermits: remote === "PAUSING" ? 1 : 0 },
        },
      },
    });
    if (url.pathname.endsWith("/lifecycle")) return send(lifecycle());
    if (url.pathname.endsWith("/replay-held-meta-leads")) {
      expect(call.postDataJSON()).toEqual({ version, approved: true });
      return send({ processed: 2, failed: 0, skipped: 0 });
    }
    if (url.pathname.endsWith("/whatsnexus-resume")) {
      expect(call.postDataJSON()).toEqual({ version, approved: true });
      resumed = true;
      remote = "ACTIVE";
      return send({ queued: true });
    }
    if (url.pathname.endsWith("/whatsnexus-retry")) {
      expect(call.postDataJSON()).toEqual({ version, approved: true });
      commandFailed = false;
      return send({ queued: true });
    }
    if (call.method() === "POST") {
      expect(call.postDataJSON()).toEqual({ version, reason: active ? "OPERATIONS" : "SERVICE_RESTORED" });
      active = !active;
      if (!active) remote = "PAUSING";
      version++;
      return send({ lifecycle: lifecycle() });
    }
    return send({
      id, tenantId: id, onboardingId: id, name: "Lifecycle Hospital", slug: "lifecycle-hospital", active,
      provisioning: "created", invitation: "accepted", template: "installed", ready: true, lifecycleStatus: lifecycle().status,
    });
  });

  await page.goto("/platform/hospitals/" + id);
  const assessment = page.getByRole("region", { name: "Archival preparation" });
  await expect(assessment.getByText(/Historical observation/)).toBeVisible();
  await expect(assessment.getByText(/Archival and retention policy requires approval/)).toBeVisible();
  await expect(assessment.getByRole("button", { name: "Archive hospital" })).toHaveCount(0);
  await expect(page.getByText("External pause unverified")).toBeVisible();
  await expect(page.getByText("Meta leads expiring within 24 hours")).toBeVisible();
  await expect(page.getByText("Meta leads with exhausted retries")).toBeVisible();
  await page.getByRole("button", { name: "Suspend hospital" }).click();
  await expect(page.getByRole("dialog")).toContainText("blocks new intake");
  await page.getByRole("button", { name: "Confirm suspend" }).click();
  await expect(page.getByText("Hospital suspended.")).toBeVisible();
  await expect(page.getByText("Suspension reason: Operations")).toBeVisible();
  await expect(page.getByText("WhatsNexus pause is unconfirmed.", { exact: false })).toBeVisible();
  await expect(page.getByText("Unresolved WhatsNexus send permits 1")).toBeVisible();
  commandFailed = true;
  await expect(page.getByText(/management unauthorized/i)).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Retry WhatsNexus reconciliation" }).click();
  remote = "PAUSED";
  await expect(page.getByText("PAUSED", { exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Restore hospital" }).click();
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByText("Hospital restored. Staff must sign in again.")).toBeVisible();
  expect(resumed).toBe(false);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Authorize WhatsNexus resume" }).click();
  await expect(page.getByText("WhatsNexus coordination queued.")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Review and recover Meta leads" }).click();
  await expect(page.getByText("Meta leads processed 2, failed 0, skipped 0.")).toBeVisible();
  bindingCurrent = false;
  await page.reload();
  await expect(page.getByText("WhatsNexus pairing changed. Previous observations are historical.")).toBeVisible();
  await expect(page.getByText("External pause unverified")).toBeVisible();
});
