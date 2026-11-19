import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, queryClient } from "../db/client.js";
import { branches, connectors, connectorSecrets, hospitalMessagingCommands, platformAccounts, platformSessions, tenants, users } from "../db/schema.js";
import { buildApp } from "../app.js";
import { changeLifecycle } from "../domain/tenant/hospital-lifecycle.service.js";
import { readHospitalArchivalAssessment } from "../domain/tenant/hospital-archival-assessment.service.js";
import { digest } from "../domain/tenant/hospital-onboarding.service.js";
import { countAgedHospitalMessagingCommands, processHospitalMessagingCommands, readMessagingCoordination, requestMessagingAction } from "../domain/tenant/hospital-messaging.service.js";

describe.skipIf(process.env.HOSPITAL_MESSAGING_TEST_DATABASE !== "1")("hospital messaging coordination", () => {
  beforeAll(async () => {
    const [database] = await queryClient`select current_database() as name`;
    expect(database?.name).toBe("pulseos_messaging_test");
  });
  afterAll(async () => { await queryClient.end(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function fixture() {
    vi.stubEnv("WHATSNEXUS_MANAGEMENT_ENABLED", "true");
    vi.stubEnv("WHATSNEXUS_MANAGEMENT_ORIGIN", "https://provider.fixture.invalid");
    vi.stubEnv("WHATSNEXUS_MANAGEMENT_JWT", "synthetic-management-token");
    const tenantId = randomUUID();
    const remoteTenant = "remote_" + randomUUID();
    const actor = { id: randomUUID(), kind: "browser" } as const;
    await db.insert(platformAccounts).values({ id: actor.id, email: actor.id + "@example.test", role: "PLATFORM_SUPER_ADMIN", mfaSecret: "enrolled" });
    await db.insert(tenants).values({ id: tenantId, name: "Synthetic hospital" });
    const [branch] = await db.insert(branches).values({ tenantId, name: "Synthetic branch", city: "Synthetic city" }).returning();
    await db.insert(users).values({ tenantId, branchId: branch!.id, role: "SUPER_ADMIN",
      name: "Synthetic admin", email: tenantId + "@example.test", passwordHash: "fixture" });
    const [connector] = await db.insert(connectors).values({
      tenantId, provider: "whatsnexus", type: "MESSAGING", mode: "LIVE", status: "CONNECTED",
      displayName: "Synthetic WhatsNexus", capabilities: [], configuration: { baseUrl: "https://provider.fixture.invalid", tenantId: remoteTenant },
    }).returning();
    await db.insert(connectorSecrets).values({ connectorId: connector!.id, encryptedPayload: "fixture-only" });
    const target = { id: tenantId, legacy: true };
    const suspend = () => changeLifecycle(db, target, actor, "SUSPENDED", { version: 0, reason: "OPERATIONS" }, true);
    const latest = async () => (await readMessagingCoordination(db, tenantId)).latest;
    let paired = tenantId;
    const status: { state: "ACTIVE" | "PAUSED" | "PAUSING"; version: number; lastCommand: string | null;
      permits: { state: string; count: number }[]; openPermits: { id: string }[] } = {
      state: "ACTIVE", version: 0, lastCommand: null, permits: [], openPermits: [],
    };
    const commands: Array<Record<string, unknown>> = [];
    let denyResume = false;
    let loseResponse = false;
    const transport: typeof fetch = async (input, options) => {
      const base = "https://provider.fixture.invalid/api/management/integrations/pulseos/" + remoteTenant;
      expect(String(input)).toContain(base);
      expect(options?.headers).toMatchObject({ Authorization: "Bearer synthetic-management-token" });
      const suffix = String(input).slice(base.length);
      if (suffix === "") return Response.json({ success: true, data: { enabled: true, pulseosTenantId: paired,
        hasApiKey: true, hasCallbackSecret: true } });
      if (suffix === "/messaging-status") return Response.json(status);
      const command = JSON.parse(String(options?.body)) as Record<string, unknown>;
      commands.push(command);
      expect(command.pulseosTenantId).toBe(tenantId);
      expect(command.expectedVersion).toBe(status.version);
      if (suffix === "/messaging-resume" && denyResume) return new Response(null, { status: 403 });
      status.version += 1;
      status.lastCommand = String(command.commandId);
      status.state = suffix === "/messaging-pause" ? "PAUSING" : "ACTIVE";
      if (loseResponse) throw new Error("synthetic timeout after acceptance");
      return Response.json({ state: suffix === "/messaging-pause" ? "PAUSED" : status.state, version: status.version });
    };
    const tick = (fetcher = transport) => processHospitalMessagingCommands(db, new Date(Date.now() + 600_000), fetcher);
    return { tenantId, connector: connector!, actor, suspend, latest, tick, status, commands,
      loseResponse: () => { loseResponse = true; }, denyResume: () => { denyResume = true; },
      changeRemotePairing: () => { paired = randomUUID(); },
      restore: () => changeLifecycle(db, target, actor, "ACTIVE", { version: 1, reason: "SERVICE_RESTORED" }, true),
      resume: (permissions = ["hospital:restore"]) => requestMessagingAction(db, tenantId, tenantId, 2, actor, "resume", permissions),
    };
  }

  it("persists one pause, confirms status independently and requires an explicit authorized resume", async () => {
    const f = await fixture();
    await Promise.all([f.suspend(), f.suspend()]);
    const pause = await f.latest();
    expect(pause).toMatchObject({ action: "pause", status: "pending" });
    expect(await db.select().from(hospitalMessagingCommands).where(eq(hospitalMessagingCommands.tenantId, f.tenantId))).toHaveLength(1);
    await f.tick();
    f.status.permits = [{ state: "sending", count: 1 }];
    f.status.openPermits = [{ id: randomUUID() }];
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "pending", observation: { state: "PAUSING", unresolvedPermits: 1 } });
    const assessment = await readHospitalArchivalAssessment(db, { id: f.tenantId, legacy: true });
    expect(assessment?.whatsNexus.observation).toMatchObject({ state: "PAUSING", alignment: "matching", unresolvedPermits: 1 });
    expect(assessment?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "BLOCKED_BY_INTEGRATION" }),
      expect.objectContaining({ classification: "EVIDENCE_UNAVAILABLE" }),
    ]));
    expect(f.commands[0]).toMatchObject({ commandId: pause?.id, lifecycleVersion: 1, expectedVersion: 0 });
    f.status.state = "PAUSED";
    f.status.permits = [];
    await db.update(hospitalMessagingCommands).set({ dueAt: new Date() })
      .where(and(eq(hospitalMessagingCommands.tenantId, f.tenantId), eq(hospitalMessagingCommands.action, "pause")));
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "confirmed", observation: { state: "PAUSED" } });
    expect(await f.restore()).toMatchObject({ lifecycle: { status: "ACTIVE" } });
    expect(f.commands).toHaveLength(1);
    expect(await f.resume([])).toBe("forbidden");
    expect(await f.resume()).toBeNull();
    expect(await f.resume()).toBeNull();
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "confirmed", observation: { state: "ACTIVE" }, action: "resume" });
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1]).toMatchObject({ lifecycleVersion: 2, expectedVersion: 1 });
    await db.update(connectorSecrets).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(connectorSecrets.connectorId, f.connector.id));
    expect(await readMessagingCoordination(db, f.tenantId)).toMatchObject({ bindingCurrent: false });
    expect((await readHospitalArchivalAssessment(db, { id: f.tenantId, legacy: true }))?.whatsNexus.observation)
      .toMatchObject({ state: "ACTIVE", alignment: "historical", unresolvedPermits: null });
  });

  it("reconciles a lost provider response with the original command across worker invocations", async () => {
    const f = await fixture();
    await f.suspend();
    await f.tick();
    f.loseResponse();
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "pending", error: "provider_unavailable", expectedVersion: 0 });
    f.status.state = "PAUSED";
    await db.update(hospitalMessagingCommands).set({ dueAt: new Date() }).where(eq(hospitalMessagingCommands.tenantId, f.tenantId));
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "confirmed", observation: { state: "PAUSED" } });
    expect(f.commands).toHaveLength(1);
  });

  it("fails closed on pairing and version conflicts while keeping the hospital suspended", async () => {
    const wrong = await fixture();
    await wrong.suspend();
    wrong.changeRemotePairing();
    await wrong.tick();
    expect(await wrong.latest()).toMatchObject({ status: "failed", error: "pairing_mismatch" });
    expect(wrong.commands).toHaveLength(0);
    const stale = await fixture();
    await stale.suspend();
    await stale.tick();
    stale.status.version = 2;
    await stale.tick();
    expect(await stale.latest()).toMatchObject({ status: "failed", error: "provider_version_or_pairing_conflict" });
    expect(stale.commands).toHaveLength(0);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, stale.tenantId));
    expect(tenant?.lifecycleStatus).toBe("SUSPENDED");
  });

  it("supersedes an unsent pause on restoration, and preserves provider denial on explicit resume", async () => {
    const stale = await fixture();
    await stale.suspend();
    await stale.restore();
    await stale.tick();
    expect(await stale.latest()).toMatchObject({ status: "superseded" });
    expect(stale.commands).toHaveLength(0);
    const denied = await fixture();
    await denied.suspend();
    denied.status.state = "PAUSED";
    await denied.tick();
    await denied.restore();
    expect(await denied.resume()).toBeNull();
    denied.denyResume();
    await denied.tick();
    expect(await denied.latest()).toMatchObject({ action: "resume", status: "failed", error: "management_unauthorized" });
    expect(denied.status.state).toBe("PAUSED");
  });

  it("keeps suspension effective during provider outage and skips external coordination when disabled", async () => {
    const outage = await fixture();
    await outage.suspend();
    await outage.tick(async () => { throw new Error("synthetic outage"); });
    expect(await outage.latest()).toMatchObject({ status: "pending", error: "provider_unavailable" });
    const [hospital] = await db.select().from(tenants).where(eq(tenants.id, outage.tenantId));
    expect(hospital).toMatchObject({ lifecycleStatus: "SUSPENDED", loginEnabled: false });
    const commandId = (await outage.latest())?.id;
    // Simulate exhaustion rather than waiting through the bounded backoff.
    await db.update(hospitalMessagingCommands).set({ status: "failed" }).where(eq(hospitalMessagingCommands.tenantId, outage.tenantId));
    expect(await requestMessagingAction(db, outage.tenantId, outage.tenantId, 1, outage.actor, "retry", ["hospital:suspend"])).toBeNull();
    expect(await outage.latest()).toMatchObject({ id: commandId, status: "pending" });
    outage.status.state = "PAUSED";
    await outage.tick();
    expect(await outage.latest()).toMatchObject({ id: commandId, status: "confirmed" });
    const disabled = await fixture();
    vi.stubEnv("WHATSNEXUS_MANAGEMENT_ENABLED", "false");
    expect(await disabled.suspend()).toMatchObject({ lifecycle: { status: "SUSPENDED" } });
    expect(await disabled.latest()).toBeNull();
  });

  it("enforces platform permissions on the registered resume endpoint", async () => {
    const f = await fixture();
    await f.suspend();
    f.status.state = "PAUSED";
    await f.tick();
    await f.restore();
    await db.update(platformAccounts).set({ mfaSecret: "enrolled", role: "PLATFORM_OPERATIONS_ADMIN" })
      .where(eq(platformAccounts.id, f.actor.id));
    const token = randomBytes(32).toString("base64url");
    await db.insert(platformSessions).values({
      tokenHash: digest(token), accountId: f.actor.id, expiresAt: new Date(Date.now() + 600_000),
    });
    const app = await buildApp();
    try {
      const submit = () => app.inject({
        method: "POST", url: "/platform/hospitals/" + f.tenantId + "/whatsnexus-resume?legacy=1",
        headers: { cookie: "pulseos_platform_session=" + token, origin: "http://localhost:3310", "x-pulseos-platform": "1" },
        payload: { version: 2, approved: true },
      });
      expect((await submit()).statusCode).toBe(403);
      await db.update(platformAccounts).set({ role: "PLATFORM_SUPER_ADMIN" })
        .where(eq(platformAccounts.id, f.actor.id));
      expect((await submit()).statusCode).toBe(202);
      expect(await f.latest()).toMatchObject({ action: "resume", status: "pending" });
      expect(f.commands).toHaveLength(0);
      await db.update(platformAccounts).set({ role: "PLATFORM_OPERATIONS_ADMIN" }).where(eq(platformAccounts.id, f.actor.id));
      await f.tick();
      expect(await f.latest()).toMatchObject({ status: "failed", error: "operator_authorization_changed" });
      expect(f.commands).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("serializes restoration with an in-flight pause and reconciles the older command without replaying it", async () => {
    const f = await fixture();
    await f.suspend();
    await f.tick();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const running = f.tick(async (input, options) => {
      if (options?.method === "POST") {
        entered();
        await proceed;
      }
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messaging-pause")) {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
        f.commands.push(body);
        f.status.state = "PAUSING";
        f.status.version = 1;
        f.status.lastCommand = String(body.commandId);
        return Response.json({ state: f.status.state, version: f.status.version });
      }
      if (url.pathname.endsWith("/messaging-status")) return Response.json(f.status);
      return Response.json({ success: true, data: { enabled: true, pulseosTenantId: f.tenantId, hasApiKey: true, hasCallbackSecret: true } });
    });
    await started;
    const restore = f.restore();
    release();
    await running;
    expect(await restore).toMatchObject({ lifecycle: { status: "ACTIVE", version: 2 } });
    expect(await f.resume()).toBe("pause_not_confirmed");
    f.status.state = "PAUSED";
    await db.update(hospitalMessagingCommands).set({ dueAt: new Date() }).where(eq(hospitalMessagingCommands.tenantId, f.tenantId));
    await f.tick();
    expect(await f.latest()).toMatchObject({ action: "pause", status: "confirmed", lifecycleVersion: 1 });
    expect(f.commands).toHaveLength(1);
  });

  it("rejects older status data, preserves the prior observation and reports aged pending commands", async () => {
    const f = await fixture();
    await f.suspend();
    await f.tick();
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "pending", observation: { state: "PAUSING", version: 1 } });
    await db.update(hospitalMessagingCommands).set({ dueAt: new Date(), createdAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(hospitalMessagingCommands.tenantId, f.tenantId));
    expect(await countAgedHospitalMessagingCommands(db, new Date())).toBe(1);
    f.status.state = "PAUSED";
    f.status.version = 0;
    await f.tick();
    expect(await f.latest()).toMatchObject({
      status: "pending", error: "stale_provider_status", observation: { state: "PAUSING", version: 1 },
    });
    expect(f.commands).toHaveLength(1);
    f.status.version = 1;
    await db.update(hospitalMessagingCommands).set({ dueAt: new Date() }).where(eq(hospitalMessagingCommands.tenantId, f.tenantId));
    await f.tick();
    expect(await f.latest()).toMatchObject({ status: "confirmed", observation: { state: "PAUSED", version: 1 } });
    expect(await countAgedHospitalMessagingCommands(db, new Date())).toBe(0);
  });

  it("prevents a queued resume from sending after resuspension", async () => {
    const f = await fixture();
    await f.suspend();
    f.status.state = "PAUSED";
    await f.tick();
    await f.restore();
    expect(await f.resume()).toBeNull();
    expect(await changeLifecycle(db, { id: f.tenantId, legacy: true }, f.actor, "SUSPENDED",
      { version: 2, reason: "OPERATIONS" }, true)).toMatchObject({ lifecycle: { status: "SUSPENDED", version: 3 } });
    await f.tick();
    const result = await readMessagingCoordination(db, f.tenantId);
    expect(result.latest).toMatchObject({ action: "pause", status: "confirmed", lifecycleVersion: 3 });
    expect(result.history).toContainEqual(expect.objectContaining({ action: "resume", status: "superseded" }));
    expect(f.commands).toHaveLength(0);
  });

  it("never contacts the provider after a pending command's local pairing rotates", async () => {
    const f = await fixture();
    await f.suspend();
    await f.tick();
    await db.update(connectorSecrets).set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(connectorSecrets.connectorId, f.connector.id));
    const transport = vi.fn<typeof fetch>();
    await f.tick(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(await f.latest()).toMatchObject({ status: "failed", error: "pairing_changed" });
  });

  it("discards the status if the remote pairing changes during the read", async () => {
    const f = await fixture();
    await f.suspend();
    let reads = 0;
    await f.tick(async (input, options) => {
      expect(options?.method).toBe("GET");
      if (String(input).endsWith("/messaging-status")) return Response.json({ ...f.status, state: "PAUSED", version: 1 });
      return Response.json({ success: true, data: {
        enabled: true, hasApiKey: true, hasCallbackSecret: true, pulseosTenantId: reads++ === 0 ? f.tenantId : randomUUID(),
      } });
    });
    expect(await f.latest()).toMatchObject({ status: "failed", error: "pairing_mismatch", observation: null, verifiedAt: null });
  });

  it("serves sanitized, filtered operations data to Platform staff and emits a terminal warning once", async () => {
    const f = await fixture();
    await f.suspend();
    const command = (await f.latest())!;
    await db.update(hospitalMessagingCommands).set({ createdAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(hospitalMessagingCommands.id, command.id));
    await db.update(connectors).set({ status: "ERROR" }).where(eq(connectors.id, f.connector.id));
    await db.update(platformAccounts).set({ role: "PLATFORM_OPERATIONS_ADMIN" }).where(eq(platformAccounts.id, f.actor.id));
    const token = randomBytes(32).toString("base64url");
    await db.insert(platformSessions).values({
      tokenHash: digest(token), accountId: f.actor.id, expiresAt: new Date(Date.now() + 600_000),
    });
    const app = await buildApp();
    try {
      const cookie = "pulseos_platform_session=" + token;
      const path = "/platform/operations/messaging?status=pending&tenantId=" + f.tenantId;
      expect((await app.inject({ url: path, headers: { cookie: "pulseos_session=synthetic" } })).statusCode).toBe(403);
      const response = await app.inject({ url: path, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ hasMore: false, items: [{ id: command.id, tenantId: f.tenantId, pendingMinutes: 16 }] });
      expect(response.body).not.toMatch(/partnerOrigin|pairingRevision|encryptedPayload|provider.fixture.invalid/);
      const dashboard = await app.inject({ url: "/platform/dashboard", headers: { cookie } });
      expect(dashboard.json()).toMatchObject({ agedCommands: expect.any(Number), integrationProblems: 1, recentAudit: [] });
      const details = await app.inject({ url: "/platform/hospitals/" + f.tenantId + "/lifecycle-operations?legacy=1", headers: { cookie } });
      expect(details.json()).toMatchObject({ connector: { mode: "LIVE", status: "ERROR" }, recentAudit: [] });
      expect(details.body).not.toMatch(/encryptedPayload|partnerOrigin|provider.fixture.invalid/);
      await db.update(platformAccounts).set({ role: "PLATFORM_SUPER_ADMIN" }).where(eq(platformAccounts.id, f.actor.id));
      const auditDetails = await app.inject({ url: "/platform/hospitals/" + f.tenantId + "/lifecycle-operations?legacy=1", headers: { cookie } });
      expect(auditDetails.json().recentAudit).toMatchObject([{ subjectId: f.tenantId, action: "suspend" }]);
      const warning = vi.fn();
      const unauthorized: typeof fetch = async () => new Response(null, { status: 401 });
      await processHospitalMessagingCommands(db, new Date(), unauthorized, warning);
      await processHospitalMessagingCommands(db, new Date(), unauthorized, warning);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.objectContaining({ commandId: command.id, hospitalId: f.tenantId,
        classification: "management_unauthorized", terminal: true }));
      expect((await app.inject({ url: path, headers: { cookie } })).json().items).toEqual([]);
      expect((await app.inject({ url: path.replace("pending", "failed"), headers: { cookie } })).json().items)
        .toMatchObject([{ id: command.id, status: "failed", classification: "management_unauthorized" }]);
    } finally {
      await app.close();
    }
  });
});
