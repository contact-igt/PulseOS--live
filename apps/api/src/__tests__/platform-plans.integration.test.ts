import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { platformAuditEvents, tenantCapabilities, tenants } from "../db/schema.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";

describe("platform plans and capabilities (integration)", () => {
  let app: FastifyInstance;
  let admin: TestPlatformUser;
  let implementation: TestPlatformUser;
  let auditor: TestPlatformUser;
  let t: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await createPlatformUser(db, app, "PLATFORM_ADMIN", PASSWORD);
    implementation = await createPlatformUser(db, app, "IMPLEMENTATION_ADMIN", PASSWORD);
    auditor = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD);
    t = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  const tenantGet = (url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! } });

  it("lists the plans with their default capabilities and real tenant counts", async () => {
    const res = await app.inject({ method: "GET", url: "/platform/plans", cookies: asPlatform(auditor.cookie) });
    expect(res.statusCode).toBe(200);
    const growth = res.json().plans.find((p: { key: string }) => p.key === "BETA_V2_GROWTH");
    expect(growth.name).toBe("Growth");
    expect(growth.capabilities.find((c: { key: string }) => c.key === "SPEND_ATTRIBUTION").included).toBe(true);
    expect(growth.tenants.total).toBeGreaterThanOrEqual(1);
  });

  it("shows plan default, tenant override and effective access side by side", async () => {
    const res = await app.inject({ method: "GET", url: `/platform/tenants/${t.tenantId}/capabilities`, cookies: asPlatform(auditor.cookie) });
    expect(res.statusCode).toBe(200);
    const row = res.json().capabilities.find((c: { key: string }) => c.key === "SPEND_ATTRIBUTION");
    expect(row).toMatchObject({ planDefault: true, override: null, effective: true });
  });

  it("a capability switched off by the platform is refused by the API at once (server-side enforcement)", async () => {
    expect((await tenantGet("/dashboard/spend-at-risk")).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/capabilities/SPEND_ATTRIBUTION`, cookies: asPlatform(implementation.cookie), payload: { enabled: false } })).statusCode).toBe(403);
    const off = await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/capabilities/SPEND_ATTRIBUTION`, cookies: asPlatform(admin.cookie), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const denied = await tenantGet("/dashboard/spend-at-risk");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("feature_not_available");
    const row = (await app.inject({ method: "GET", url: `/platform/tenants/${t.tenantId}/capabilities`, cookies: asPlatform(auditor.cookie) })).json().capabilities.find((c: { key: string }) => c.key === "SPEND_ATTRIBUTION");
    expect(row).toMatchObject({ planDefault: true, override: false, effective: false });
    const audit = await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.tenantId, t.tenantId), eq(platformAuditEvents.action, "capability.changed")));
    expect(audit).toHaveLength(1);
    // Back to the plan default (override removed).
    const reset = await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/capabilities/SPEND_ATTRIBUTION`, cookies: asPlatform(admin.cookie), payload: { enabled: null } });
    expect(reset.statusCode).toBe(200);
    expect(await db.select().from(tenantCapabilities).where(and(eq(tenantCapabilities.tenantId, t.tenantId), eq(tenantCapabilities.capability, "SPEND_ATTRIBUTION")))).toHaveLength(0);
    expect((await tenantGet("/dashboard/spend-at-risk")).statusCode).toBe(200);
  });

  it("refuses impossible combinations and locked capabilities", async () => {
    const dep = await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/capabilities/MARKETING_ANALYTICS`, cookies: asPlatform(admin.cookie), payload: { enabled: false } });
    expect(dep.statusCode).toBe(409);
    expect(dep.json().error).toBe("required_by");
    const locked = await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/capabilities/ANALYTICS_CORE`, cookies: asPlatform(admin.cookie), payload: { enabled: false } });
    expect(locked.statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/capabilities/NOT_A_THING`, cookies: asPlatform(admin.cookie), payload: { enabled: true } })).statusCode).toBe(404);
  });

  it("changing the plan changes the defaults, keeps the tenant's overrides, and is enforced on the next request", async () => {
    const [row] = await db.select().from(tenants).where(eq(tenants.id, t.tenantId));
    const res = await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/plan`, cookies: asPlatform(admin.cookie), payload: { edition: "BETA_V1_CORE", version: row!.version, reason: "Downgraded to Core" } });
    expect(res.statusCode).toBe(200);
    expect((await tenantGet("/dashboard/spend-at-risk")).statusCode).toBe(403);
    const session = await tenantGet("/auth/session");
    expect(session.json().user.edition).toBe("BETA_V1_CORE");
    const stale = await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/plan`, cookies: asPlatform(admin.cookie), payload: { edition: "BETA_V2_GROWTH", version: row!.version, reason: "Upgrade" } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/platform/tenants/${t.tenantId}/plan`, cookies: asPlatform(implementation.cookie), payload: { edition: "BETA_V2_GROWTH", version: row!.version + 1, reason: "Upgrade" } })).statusCode).toBe(403);
  });

  it("a plan change that would leave an override without its dependency is refused, listing what is in the way", async () => {
    const x = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
    // On Core, switch on nothing extra; then add a Growth-only override that needs MARKETING_ANALYTICS via an upgrade first.
    const [r0] = await db.select().from(tenants).where(eq(tenants.id, x.tenantId));
    await app.inject({ method: "PUT", url: `/platform/tenants/${x.tenantId}/plan`, cookies: asPlatform(admin.cookie), payload: { edition: "BETA_V2_GROWTH", version: r0!.version, reason: "Upgrade" } });
    await app.inject({ method: "PUT", url: `/platform/tenants/${x.tenantId}/capabilities/CAMPAIGNS`, cookies: asPlatform(admin.cookie), payload: { enabled: true } });
    const [r1] = await db.select().from(tenants).where(eq(tenants.id, x.tenantId));
    const down = await app.inject({ method: "PUT", url: `/platform/tenants/${x.tenantId}/plan`, cookies: asPlatform(admin.cookie), payload: { edition: "BETA_V1_CORE", version: r1!.version, reason: "Downgrade" } });
    expect(down.statusCode).toBe(409);
    expect(down.json().error).toBe("invalid_capabilities");
    expect(down.json().detail.join(" ")).toMatch(/CAMPAIGNS/);
  });
});
