import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { accountTokens, platformSettings } from "../db/schema.js";
import { recordPlatformAudit } from "../domain/platform/audit.service.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";

describe("platform audit, security, health and settings (integration)", () => {
  let app: FastifyInstance;
  let owner: TestPlatformUser;
  let admin: TestPlatformUser;
  let support: TestPlatformUser;
  let auditor: TestPlatformUser;
  let t: TestTenant;
  let original: { key: string; value: unknown }[];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    owner = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
    admin = await createPlatformUser(db, app, "PLATFORM_ADMIN", PASSWORD);
    support = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD);
    auditor = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD);
    t = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
    original = await db.select({ key: platformSettings.key, value: platformSettings.value }).from(platformSettings);
  });

  afterAll(async () => {
    await db.delete(platformSettings);
    for (const o of original) await db.insert(platformSettings).values({ key: o.key, value: o.value });
    await app.close();
    await queryClient.end();
  });

  const get = (u: TestPlatformUser, url: string) => app.inject({ method: "GET", url, cookies: asPlatform(u.cookie) });

  it("the audit trail is readable by auditors and admins, not by support agents, and never stores secret values", async () => {
    const marker = `audit-marker-${randomUUID().slice(0, 8)}`;
    await recordPlatformAudit(db, { platformUserId: owner.id, label: owner.email }, { action: "test.event", summary: marker, tenantId: t.tenantId, metadata: { password: "hunter2-should-vanish", apiKey: "k-should-vanish", note: "Bearer abc.def.ghi" } });
    const res = await get(auditor, `/platform/audit?q=${marker}`);
    expect(res.statusCode).toBe(200);
    const row = res.json().rows[0];
    expect(row).toMatchObject({ action: "test.event", actor: owner.email, tenantId: t.tenantId });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("hunter2-should-vanish");
    expect(raw).not.toContain("k-should-vanish");
    expect((await get(support, "/platform/audit")).statusCode).toBe(403);
    expect((await get(admin, `/platform/audit?tenantId=${t.tenantId}&pageSize=5`)).json().rows.every((r: { tenantId: string }) => r.tenantId === t.tenantId)).toBe(true);
  });

  it("the security view lists denials and failures (e.g. a refused permission)", async () => {
    await get(support, "/platform/audit");
    const res = await get(auditor, "/platform/audit?security=true&pageSize=50");
    expect(res.json().rows.some((r: { action: string; outcome: string }) => r.action === "platform.permission_denied" && r.outcome === "DENIED")).toBe(true);
    expect(res.json().rows.every((r: { outcome: string; action: string }) => r.outcome !== "SUCCESS" || /login|denied|suspend|revoke|support|role|reset/.test(r.action))).toBe(true);
  });

  it("a tenant's audit tab merges platform actions and the tenant's own settings history", async () => {
    const res = await get(auditor, `/platform/tenants/${t.tenantId}/audit`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("platform");
    expect(res.json()).toHaveProperty("tenantActivity");
  });

  it("health reports real status and versions without paths, secrets or connection strings", async () => {
    const res = await get(support, "/platform/health");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.database.ok).toBe(true);
    expect(typeof body.database.latencyMs).toBe("number");
    expect(body.migrations.applied).toBeGreaterThanOrEqual(52);
    expect(body.migrations.pending).toBe(0);
    expect(body.api).toHaveProperty("version");
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/\/Users\/|postgres:\/\/|DATABASE_URL|SESSION_SECRET|CONNECTOR_ENCRYPTION/);
  });

  it("only a Platform Owner changes global settings; the invitation lifetime then applies to new invitations", async () => {
    const current = (await get(owner, "/platform/settings")).json().settings;
    expect((await app.inject({ method: "PUT", url: "/platform/settings", cookies: asPlatform(admin.cookie), payload: { ...current, invitationExpiryHours: 5 } })).statusCode).toBe(403);
    const bad = await app.inject({ method: "PUT", url: "/platform/settings", cookies: asPlatform(owner.cookie), payload: { ...current, defaultTimezone: "Nowhere/Never" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/platform/settings", cookies: asPlatform(owner.cookie), payload: { ...current, invitationExpiryHours: 5, supportContact: "support@invictus.example" } });
    expect(ok.statusCode).toBe(200);
    const email = `ttl.${randomUUID().slice(0, 8)}@platform-test.local`;
    const inv = await app.inject({ method: "POST", url: `/platform/tenants/${t.tenantId}/members`, cookies: asPlatform(owner.cookie), payload: { name: "Tara TTL", email, role: "DOCTOR" } });
    const [token] = await db.select().from(accountTokens).where(eq(accountTokens.id, inv.json().invitation.id));
    const hours = (token!.expiresAt.getTime() - token!.createdAt.getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(5);
    // The support contact reaches hospital staff whose workspace is unavailable.
    const [fd] = await db.select().from((await import("../db/schema.js")).users).where(eq((await import("../db/schema.js")).users.id, t.userIds.FRONT_DESK!));
    await db.update((await import("../db/schema.js")).tenants).set({ status: "SUSPENDED" }).where(eq((await import("../db/schema.js")).tenants.id, t.tenantId));
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: fd!.email, password: PASSWORD } });
    expect(login.json().message).toContain("support@invictus.example");
  });
});
