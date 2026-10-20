import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { accountTokens, branches, departments, leadSources, patients, platformAuditEvents, tenantLoginConfigs, tenants, users } from "../db/schema.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";

function slugFor(tag: string) {
  return `pt-${tag}`;
}

function createBody(tag: string, overrides: Record<string, unknown> = {}) {
  return {
    creationKey: randomUUID(),
    organization: { name: `Platform Test Hospital ${tag}`, slug: slugFor(tag), industry: "Healthcare", country: "India", timezone: "Asia/Kolkata", locale: "en-IN", environment: "TEST" },
    plan: { edition: "BETA_V1_CORE", capabilityOverrides: { SMS_NOTIFICATIONS: true } },
    setup: { branches: [{ name: "Main", city: "Chennai" }], departmentTemplates: ["ophthalmology"], customLeadSources: [{ label: "Newspaper", bucket: "other" }], branding: { shortName: "PTH", headline: "Welcome back" } },
    admin: { name: "Asha Admin", email: `asha.${tag}@platform-tenant-test.local`, role: "SUPER_ADMIN" },
    ...overrides,
  };
}

describe("platform tenant management (integration)", () => {
  let app: FastifyInstance;
  let owner: TestPlatformUser;
  let admin: TestPlatformUser;
  let implementation: TestPlatformUser;
  let support: TestPlatformUser;
  let auditor: TestPlatformUser;
  let existing: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    owner = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
    admin = await createPlatformUser(db, app, "PLATFORM_ADMIN", PASSWORD);
    implementation = await createPlatformUser(db, app, "IMPLEMENTATION_ADMIN", PASSWORD);
    support = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD);
    auditor = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD);
    existing = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  const create = (u: TestPlatformUser, body: unknown) => app.inject({ method: "POST", url: "/platform/tenants", cookies: asPlatform(u.cookie), payload: body as object });

  describe("create", () => {
    it("creates the tenant, its configuration and an invited first admin in one transaction", async () => {
      const tag = randomUUID().slice(0, 8);
      const res = await create(implementation, createBody(tag));
      expect(res.statusCode).toBe(201);
      const { tenant, invitation } = res.json();
      expect(tenant).toMatchObject({ status: "DRAFT", loginSlug: slugFor(tag), edition: "BETA_V1_CORE", environment: "TEST" });
      expect(invitation.deliveryStatus).toBe("SENT"); // local outbox in development
      expect(JSON.stringify(res.json())).not.toMatch(/token|password|hash/i);

      const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(branches).where(eq(branches.tenantId, tenant.id));
      expect(b!.n).toBe(1);
      const deps = await db.select().from(departments).where(eq(departments.tenantId, tenant.id));
      expect(deps.map((d) => d.key)).toContain("OPHTHALMOLOGY");
      const sources = await db.select().from(leadSources).where(eq(leadSources.tenantId, tenant.id));
      expect(sources.some((s) => s.label === "Newspaper")).toBe(true);
      const [cfg] = await db.select().from(tenantLoginConfigs).where(eq(tenantLoginConfigs.tenantId, tenant.id));
      expect(cfg).toMatchObject({ shortName: "PTH", headline: "Welcome back" });

      const [adminUser] = await db.select().from(users).where(eq(users.tenantId, tenant.id));
      expect(adminUser).toMatchObject({ role: "SUPER_ADMIN", status: "INVITED", passwordHash: null });
      const [t] = await db.select().from(tenants).where(eq(tenants.id, tenant.id));
      expect(t!.primaryAdminUserId).toBe(adminUser!.id);
      const [token] = await db.select().from(accountTokens).where(eq(accountTokens.userId, adminUser!.id));
      expect(token).toMatchObject({ purpose: "INVITE", status: "PENDING" });
      expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      const audit = await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.tenantId, tenant.id), eq(platformAuditEvents.action, "tenant.created")));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorPlatformUserId).toBe(implementation.id);
    });

    it("a repeated submission (double-click) returns the same tenant, never a second one", async () => {
      const tag = randomUUID().slice(0, 8);
      const body = createBody(tag);
      const [a, b] = await Promise.all([create(owner, body), create(owner, body)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      expect(a.json().tenant.id).toBe(b.json().tenant.id);
      const rows = await db.select().from(tenants).where(eq(tenants.loginSlug, slugFor(tag)));
      expect(rows).toHaveLength(1);
    });

    it("a taken login slug is refused with 409 and nothing is created", async () => {
      const tag = randomUUID().slice(0, 8);
      expect((await create(owner, createBody(tag))).statusCode).toBe(201);
      const again = await create(owner, { ...createBody(tag), creationKey: randomUUID(), admin: { name: "Bea Second", email: `b.${tag}@platform-tenant-test.local`, role: "SUPER_ADMIN" } });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("slug_taken");
    });

    it("a failure halfway rolls everything back: no partial tenant is left", async () => {
      const tag = randomUUID().slice(0, 8);
      const body = createBody(tag, {});
      (body.setup as { customLeadSources: unknown[] }).customLeadSources = [{ label: "Radio", bucket: "other" }, { label: "radio", bucket: "other" }];
      const res = await create(owner, body);
      expect(res.statusCode).toBe(409);
      expect(await db.select().from(tenants).where(eq(tenants.loginSlug, slugFor(tag)))).toHaveLength(0);
      expect(await db.select().from(users).where(eq(users.email, `asha.${tag}@platform-tenant-test.local`))).toHaveLength(0);
    });

    it("refuses roles without CREATE_TENANT and unknown fields (no tenant id smuggling)", async () => {
      const tag = randomUUID().slice(0, 8);
      expect((await create(support, createBody(tag))).statusCode).toBe(403);
      expect((await create(auditor, createBody(tag))).statusCode).toBe(403);
      expect((await create(owner, { ...createBody(tag), tenantId: existing.tenantId })).statusCode).toBe(400);
    });
  });

  describe("directory", () => {
    it("searches, filters and paginates on the server, with safe columns only", async () => {
      const tag = randomUUID().slice(0, 8);
      const made = (await create(owner, createBody(tag))).json().tenant;
      const bySlug = await app.inject({ method: "GET", url: `/platform/tenants?q=${slugFor(tag)}`, cookies: asPlatform(auditor.cookie) });
      expect(bySlug.statusCode).toBe(200);
      expect(bySlug.json().rows.map((r: { id: string }) => r.id)).toEqual([made.id]);
      const row = bySlug.json().rows[0];
      expect(row).toMatchObject({ status: "DRAFT", users: 1, branches: 1, primaryAdmin: { email: `asha.${tag}@platform-tenant-test.local` } });
      expect(JSON.stringify(bySlug.json())).not.toMatch(/password|hash|encrypted|recording/i);

      const byAdminEmail = await app.inject({ method: "GET", url: `/platform/tenants?q=asha.${tag}`, cookies: asPlatform(auditor.cookie) });
      expect(byAdminEmail.json().rows.map((r: { id: string }) => r.id)).toEqual([made.id]);

      const drafts = await app.inject({ method: "GET", url: "/platform/tenants?status=DRAFT&pageSize=1&page=1", cookies: asPlatform(owner.cookie) });
      expect(drafts.json().rows).toHaveLength(1);
      expect(drafts.json().total).toBeGreaterThanOrEqual(1);
      expect(drafts.json().rows.every((r: { status: string }) => r.status === "DRAFT")).toBe(true);

      const bad = await app.inject({ method: "GET", url: "/platform/tenants?status=NOPE", cookies: asPlatform(owner.cookie) });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe("detail", () => {
    it("shows aggregate counts and a checklist from real state, never patient-level data", async () => {
      const res = await app.inject({ method: "GET", url: `/platform/tenants/${existing.tenantId}`, cookies: asPlatform(support.cookie) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.counts).toMatchObject({ users: 5, branches: 1, patients: 1, calls: 1 });
      expect(body.checklist.find((c: { key: string }) => c.key === "branch").done).toBe(true);
      expect(["SETUP_INCOMPLETE", "READY_FOR_CLIENT", "ACTIVE", "NEEDS_ATTENTION"]).toContain(body.readiness);
      const [p] = await db.select({ name: patients.name }).from(patients).where(eq(patients.tenantId, existing.tenantId));
      expect(JSON.stringify(body)).not.toContain(p!.name);
      expect(JSON.stringify(body)).not.toContain(existing.recordingUrl);
    });

    it("an unknown or malformed tenant id is a plain 404", async () => {
      for (const id of [randomUUID(), "not-a-uuid"]) {
        const res = await app.inject({ method: "GET", url: `/platform/tenants/${id}`, cookies: asPlatform(owner.cookie) });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
      }
    });
  });

  describe("edit", () => {
    it("saves with the current version and refuses a stale one", async () => {
      const tag = randomUUID().slice(0, 8);
      const t = (await create(owner, createBody(tag))).json().tenant;
      const ok = await app.inject({ method: "PATCH", url: `/platform/tenants/${t.id}`, cookies: asPlatform(implementation.cookie), payload: { version: t.version, name: `Renamed ${tag}`, timezone: "Asia/Dubai" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().tenant).toMatchObject({ name: `Renamed ${tag}`, timezone: "Asia/Dubai", version: t.version + 1 });
      const stale = await app.inject({ method: "PATCH", url: `/platform/tenants/${t.id}`, cookies: asPlatform(admin.cookie), payload: { version: t.version, name: "Lost update" } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("stale_version");
      const bad = await app.inject({ method: "PATCH", url: `/platform/tenants/${t.id}`, cookies: asPlatform(admin.cookie), payload: { version: t.version + 1, timezone: "Mars/Olympus" } });
      expect(bad.statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: `/platform/tenants/${t.id}`, cookies: asPlatform(auditor.cookie), payload: { version: t.version + 1, name: "x y z" } })).statusCode).toBe(403);
    });
  });

  describe("lifecycle", () => {
    const act = (u: TestPlatformUser, id: string, body: object) => app.inject({ method: "POST", url: `/platform/tenants/${id}/lifecycle`, cookies: asPlatform(u.cookie), payload: body });

    it("moves through the legal transitions only, each with a reason in the audit trail", async () => {
      const tag = randomUUID().slice(0, 8);
      let t = (await create(owner, createBody(tag))).json().tenant;
      let r = await act(admin, t.id, { action: "START_ONBOARDING", version: t.version, reason: "Kick-off call done" });
      expect(r.statusCode).toBe(200);
      t = r.json().tenant;
      expect(t.status).toBe("ONBOARDING");
      r = await act(admin, t.id, { action: "REACTIVATE", version: t.version, reason: "not allowed from onboarding" });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe("invalid_transition");
      r = await act(admin, t.id, { action: "ACTIVATE", version: t.version, reason: "Go-live approved" });
      expect(r.json().tenant.status).toBe("ACTIVE");
      const audit = await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.tenantId, t.id), eq(platformAuditEvents.action, "tenant.activated")));
      expect(audit[0]!.reason).toBe("Go-live approved");
    });

    it("only lifecycle managers may change status, and suspension needs a reason", async () => {
      const tag = randomUUID().slice(0, 8);
      const t = (await create(owner, createBody(tag))).json().tenant;
      expect((await act(implementation, t.id, { action: "ACTIVATE", version: t.version, reason: "trying it" })).statusCode).toBe(403);
      const act1 = await act(owner, t.id, { action: "ACTIVATE", version: t.version, reason: "Go-live" });
      const noReason = await act(owner, t.id, { action: "SUSPEND", version: act1.json().tenant.version });
      expect(noReason.statusCode).toBe(400);
    });

    it("suspending blocks sign-in and ends open sessions at once, keeps every row, and reactivating restores access", async () => {
      const victim = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
      const before = await db.select({ n: sql<number>`count(*)::int` }).from(patients).where(eq(patients.tenantId, victim.tenantId));
      const [t] = await db.select().from(tenants).where(eq(tenants.id, victim.tenantId));
      const ok = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: victim.cookie.FRONT_DESK! } });
      expect(ok.statusCode).toBe(200);
      const email = ok.json().user.email;

      const sus = await act(admin, victim.tenantId, { action: "SUSPEND", version: t!.version, reason: "Contract paused by client" });
      expect(sus.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: victim.cookie.FRONT_DESK! } })).statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });
      expect(login.statusCode).toBe(403);
      expect(login.json().error).toBe("workspace_unavailable");
      const wrong = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "wrong-password" } });
      expect(wrong.statusCode).toBe(401);
      const after = await db.select({ n: sql<number>`count(*)::int` }).from(patients).where(eq(patients.tenantId, victim.tenantId));
      expect(after[0]!.n).toBe(before[0]!.n);

      const re = await act(admin, victim.tenantId, { action: "REACTIVATE", version: sus.json().tenant.version, reason: "Contract resumed" });
      expect(re.json().tenant.status).toBe("ACTIVE");
      expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } })).statusCode).toBe(200);
    });

    it("an active tenant must be suspended before it can be archived; archive never deletes", async () => {
      const victim = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
      const [t] = await db.select().from(tenants).where(eq(tenants.id, victim.tenantId));
      const r = await act(owner, victim.tenantId, { action: "ARCHIVE", version: t!.version, reason: "Client left" });
      expect(r.statusCode).toBe(409);
      const s = await act(owner, victim.tenantId, { action: "SUSPEND", version: t!.version, reason: "Client left" });
      const a = await act(owner, victim.tenantId, { action: "ARCHIVE", version: s.json().tenant.version, reason: "Client left for good" });
      expect(a.json().tenant.status).toBe("ARCHIVED");
      expect(await db.select().from(tenants).where(eq(tenants.id, victim.tenantId))).toHaveLength(1);
      expect((await app.inject({ method: "DELETE", url: `/platform/tenants/${victim.tenantId}`, cookies: asPlatform(owner.cookie) })).statusCode).toBe(404);
    });
  });
});
