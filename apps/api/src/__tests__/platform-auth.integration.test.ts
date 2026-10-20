import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { platformAuditEvents, platformSessions, platformUsers } from "../db/schema.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, PLATFORM_COOKIE } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";

describe("platform auth and isolation (integration)", () => {
  let app: FastifyInstance;
  let tenant: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tenant = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("a platform user signs in and gets their platform role and permissions", async () => {
    const owner = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
    const res = await app.inject({ method: "GET", url: "/platform/auth/session", cookies: asPlatform(owner.cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: owner.id, role: "PLATFORM_OWNER" });
    expect(res.json().user.permissions).toContain("MANAGE_PLATFORM_SETTINGS");
    // Nothing secret travels with the session.
    expect(JSON.stringify(res.json())).not.toMatch(/password|hash/i);
  });

  it("the platform cookie is httpOnly and separate from the tenant session cookie", async () => {
    const u = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD, { signIn: false });
    const res = await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: u.email, password: PASSWORD } });
    const cookie = res.cookies.find((c) => c.name === PLATFORM_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(res.cookies.find((c) => c.name === "pulseos_session")).toBeUndefined();
  });

  it("a tenant SUPER_ADMIN cannot sign in to the platform with their tenant credentials", async () => {
    const [row] = await db.select({ email: platformUsers.email }).from(platformUsers).limit(1);
    void row;
    const email = (await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: tenant.cookie.SUPER_ADMIN! } })).json().user.email;
    const res = await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("a tenant session never authorizes a platform endpoint", async () => {
    for (const role of ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "DOCTOR"] as const) {
      for (const url of ["/platform/auth/session", "/platform/overview", "/platform/tenants", "/platform/users"]) {
        const res = await app.inject({ method: "GET", url, cookies: { pulseos_session: tenant.cookie[role]! } });
        expect(res.statusCode, `${role} ${url}`).toBe(401);
      }
    }
  });

  it("a refused platform request still carries CORS headers, so the console can read the 401", async () => {
    const res = await app.inject({ method: "GET", url: "/platform/auth/session", headers: { origin: (process.env.WEB_ORIGIN ?? "http://localhost:3310").split(",")[0]! } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBeTruthy();
  });

  it("unknown email and wrong password answer identically", async () => {
    const u = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD, { signIn: false });
    const wrong = await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: u.email, password: "not-the-password" } });
    const unknown = await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: "nobody-at-all@platform-test.local", password: "not-the-password" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("a suspended platform user cannot sign in, and their open session stops working", async () => {
    const u = await createPlatformUser(db, app, "PLATFORM_ADMIN", PASSWORD);
    await db.update(platformUsers).set({ status: "SUSPENDED" }).where(eq(platformUsers.id, u.id));
    const session = await app.inject({ method: "GET", url: "/platform/auth/session", cookies: asPlatform(u.cookie) });
    expect(session.statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: u.email, password: PASSWORD } });
    expect(login.statusCode).toBe(401);
  });

  it("logout ends the platform session server-side", async () => {
    const u = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD);
    const out = await app.inject({ method: "POST", url: "/platform/auth/logout", cookies: asPlatform(u.cookie) });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/platform/auth/session", cookies: asPlatform(u.cookie) });
    expect(after.statusCode).toBe(401);
    expect(await db.select().from(platformSessions).where(eq(platformSessions.id, u.cookie))).toHaveLength(0);
  });

  it("sign-in success and failure are audited without the password", async () => {
    const u = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD, { signIn: false });
    await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: u.email, password: "wrong-password-xyz" } });
    await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: u.email, password: PASSWORD } });
    const rows = await db.select().from(platformAuditEvents).where(eq(platformAuditEvents.actorLabel, u.email)).orderBy(desc(platformAuditEvents.createdAt));
    const actions = rows.map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toContain("platform.login:FAILURE");
    expect(actions).toContain("platform.login:SUCCESS");
    expect(JSON.stringify(rows)).not.toContain("wrong-password-xyz");
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it("repeated failed platform sign-ins are throttled", async () => {
    const u = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD, { signIn: false });
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email: u.email, password: `wrong-${i}` }, remoteAddress: "10.9.8.7" })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("the platform audit trail is append-only at the database", async () => {
    const [row] = await db.select({ id: platformAuditEvents.id }).from(platformAuditEvents).limit(1);
    await expect(db.update(platformAuditEvents).set({ summary: "tampered" }).where(eq(platformAuditEvents.id, row!.id))).rejects.toThrow();
    await expect(db.delete(platformAuditEvents).where(eq(platformAuditEvents.id, row!.id))).rejects.toThrow();
  });
});
