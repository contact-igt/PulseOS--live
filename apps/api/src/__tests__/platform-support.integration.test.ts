import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { leadSources, platformAuditEvents, supportSessions, tenants, users } from "../db/schema.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { createPlatformUser, PLATFORM_COOKIE, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";
const SUPPORT_COOKIE = "pulseos_support";

describe("support mode (integration)", () => {
  let app: FastifyInstance;
  let agent: TestPlatformUser;
  let implementation: TestPlatformUser;
  let auditor: TestPlatformUser;
  let t: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    agent = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD);
    implementation = await createPlatformUser(db, app, "IMPLEMENTATION_ADMIN", PASSWORD);
    auditor = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD);
    t = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
    other = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  async function start(u: TestPlatformUser, tenantId: string, reason = "Customer reported a missing follow-up") {
    const res = await app.inject({ method: "POST", url: `/platform/tenants/${tenantId}/support-sessions`, cookies: { [PLATFORM_COOKIE]: u.cookie }, payload: { reason, minutes: 30 } });
    const cookie = res.cookies.find((c) => c.name === SUPPORT_COOKIE)?.value ?? "";
    return { res, cookie };
  }
  const as = (u: TestPlatformUser, support: string) => ({ [PLATFORM_COOKIE]: u.cookie, [SUPPORT_COOKIE]: support });
  const json = (r: LightMyRequestResponse) => r.json() as Record<string, unknown>;

  it("needs a permission and a stated reason, and is audited", async () => {
    expect((await start(auditor, t.tenantId)).res.statusCode).toBe(403);
    const noReason = await app.inject({ method: "POST", url: `/platform/tenants/${t.tenantId}/support-sessions`, cookies: { [PLATFORM_COOKIE]: agent.cookie }, payload: { reason: "" } });
    expect(noReason.statusCode).toBe(400);
    const { res, cookie } = await start(agent, t.tenantId);
    expect(res.statusCode).toBe(201);
    expect(res.cookies.find((c) => c.name === SUPPORT_COOKIE)?.httpOnly).toBe(true);
    const audit = await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.action, "support.started"), eq(platformAuditEvents.supportSessionId, res.json().session.id)));
    expect(audit[0]).toMatchObject({ actorPlatformUserId: agent.id, tenantId: t.tenantId, reason: "Customer reported a missing follow-up", context: "SUPPORT_MODE" });
    void cookie;
  });

  it("shows the hospital as its admin sees it, labelled as support and as the real staff member - read-only by default", async () => {
    const { cookie } = await start(agent, t.tenantId);
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: as(agent, cookie) });
    expect(session.statusCode).toBe(200);
    const user = session.json().user;
    expect(user.tenantId).toBe(t.tenantId);
    expect(user.role).toBe("HOSPITAL_ADMIN");
    expect(user.support).toMatchObject({ staffEmail: agent.email, writeEnabled: false });
    expect(user.name).toMatch(/PulseOS Support/);
    const clientNames = (await db.select({ name: users.name }).from(users).where(and(eq(users.tenantId, t.tenantId), eq(users.isSystem, false)))).map((u) => u.name);
    expect(clientNames).not.toContain(user.name);
    // Reads work; every write is refused.
    expect((await app.inject({ method: "GET", url: "/patients", cookies: as(agent, cookie) })).statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: "/lead-sources", cookies: as(agent, cookie), payload: { label: "Support should not write" } });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe("support_read_only");
  });

  it("the support cookie alone is nothing: it needs the same staff member's live platform session", async () => {
    const { cookie } = await start(agent, t.tenantId);
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: { [SUPPORT_COOKIE]: cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: { [PLATFORM_COOKIE]: implementation.cookie, [SUPPORT_COOKIE]: cookie } })).statusCode).toBe(401);
  });

  it("is time-limited", async () => {
    const { res, cookie } = await start(agent, t.tenantId);
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.id, res.json().session.id));
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: as(agent, cookie) })).statusCode).toBe(401);
  });

  it("stays inside its hospital: another hospital's records are not found", async () => {
    const { cookie } = await start(agent, t.tenantId);
    const res = await app.inject({ method: "GET", url: `/patients/${other.patientId}/360`, cookies: as(agent, cookie) });
    expect(res.statusCode).toBe(404);
  });

  it("edits need their own permission, reason and time limit; every write is audited as the platform staff member", async () => {
    const { res, cookie } = await start(implementation, t.tenantId, "Configure lead sources during onboarding");
    const sid = res.json().session.id;
    const agentStart = await start(agent, t.tenantId);
    expect((await app.inject({ method: "POST", url: `/platform/support-sessions/${agentStart.res.json().session.id}/enable-edits`, cookies: { [PLATFORM_COOKIE]: agent.cookie }, payload: { reason: "I want to edit", minutes: 10 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/platform/support-sessions/${sid}/enable-edits`, cookies: { [PLATFORM_COOKIE]: implementation.cookie }, payload: { minutes: 10 } })).statusCode).toBe(400);
    const enable = await app.inject({ method: "POST", url: `/platform/support-sessions/${sid}/enable-edits`, cookies: { [PLATFORM_COOKIE]: implementation.cookie }, payload: { reason: "Client asked us to add their newspaper source", minutes: 10 } });
    expect(enable.statusCode).toBe(200);

    const label = `Support Added ${Date.now()}`;
    const write = await app.inject({ method: "POST", url: "/lead-sources", cookies: as(implementation, cookie), payload: { label } });
    expect(write.statusCode).toBe(201);
    expect(await db.select().from(leadSources).where(and(eq(leadSources.tenantId, t.tenantId), eq(leadSources.label, label)))).toHaveLength(1);
    const audit = await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.supportSessionId, sid), eq(platformAuditEvents.action, "support.write")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorPlatformUserId: implementation.id, tenantId: t.tenantId, context: "SUPPORT_MODE", reason: "Client asked us to add their newspaper source" });
    expect(json(write)).toBeTruthy();

    // When the edit window closes, writes are refused again.
    await db.update(supportSessions).set({ writeExpiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.id, sid));
    expect((await app.inject({ method: "POST", url: "/lead-sources", cookies: as(implementation, cookie), payload: { label: `${label} again` } })).json().error).toBe("support_read_only");
  });

  it("ending the session is audited and immediately ends access", async () => {
    const { res, cookie } = await start(agent, t.tenantId);
    const sid = res.json().session.id;
    const end = await app.inject({ method: "POST", url: `/platform/support-sessions/${sid}/end`, cookies: as(agent, cookie) });
    expect(end.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: as(agent, cookie) })).statusCode).toBe(401);
    expect(await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.supportSessionId, sid), eq(platformAuditEvents.action, "support.ended")))).toHaveLength(1);
  });

  it("platform support access survives a tenant suspension (read-only)", async () => {
    const victim = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
    await db.update(tenants).set({ status: "SUSPENDED" }).where(eq(tenants.id, victim.tenantId));
    const { res, cookie } = await start(agent, victim.tenantId);
    expect(res.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: as(agent, cookie) })).statusCode).toBe(200);
  });

  it("lists support sessions for the Support page", async () => {
    const res = await app.inject({ method: "GET", url: `/platform/support-sessions?tenantId=${t.tenantId}`, cookies: { [PLATFORM_COOKIE]: auditor.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.length).toBeGreaterThan(0);
    expect(res.json().rows[0]).toHaveProperty("reason");
  });
});
