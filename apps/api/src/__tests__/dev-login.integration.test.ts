import { describe, expect, it, afterEach, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded PulseOS dev DB
// (the same one `pnpm db:seed` populates).
//
// Dev Login exists to skip re-typing credentials during local development —
// never in production. The guard is env-driven and evaluated at route
// REGISTRATION time (not just per-request), so a disabled/production build
// has no such route at all, not just a 403 on one that exists. That's why
// these tests build a fresh app per case with different env vars rather than
// toggling a flag on one shared instance.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function buildWithEnv(env: { NODE_ENV?: string; ENABLE_DEV_LOGIN?: string }): Promise<FastifyInstance> {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevFlag = process.env.ENABLE_DEV_LOGIN;
  if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env.NODE_ENV;
  if (env.ENABLE_DEV_LOGIN === undefined) delete process.env.ENABLE_DEV_LOGIN;
  else process.env.ENABLE_DEV_LOGIN = env.ENABLE_DEV_LOGIN;

  const app = await buildApp();
  await app.ready();

  // Restore immediately — only route REGISTRATION (already done above) reads
  // these; nothing else in the app should key off them mid-request.
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (prevFlag === undefined) delete process.env.ENABLE_DEV_LOGIN;
  else process.env.ENABLE_DEV_LOGIN = prevFlag;

  return app;
}

describe.skipIf(!DEMO_PASSWORD)("Dev Login (integration)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("does not exist when ENABLE_DEV_LOGIN is unset, even outside production", async () => {
    const app = await buildWithEnv({ NODE_ENV: "test" });
    apps.push(app);
    const roles = await app.inject({ method: "GET", url: "/auth/dev-login/roles" });
    expect(roles.statusCode).toBe(404);
    const login = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN" } });
    expect(login.statusCode).toBe(404);
  });

  it("does not exist in production even with the flag on — production always wins", async () => {
    const app = await buildWithEnv({ NODE_ENV: "production", ENABLE_DEV_LOGIN: "true" });
    apps.push(app);
    const roles = await app.inject({ method: "GET", url: "/auth/dev-login/roles" });
    expect(roles.statusCode).toBe(404);
    const login = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN" } });
    expect(login.statusCode).toBe(404);
  });

  it("lists the seeded demo roles when enabled outside production", async () => {
    const app = await buildWithEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "true" });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/auth/dev-login/roles" });
    expect(res.statusCode).toBe(200);
    const roles = res.json() as { role: string; label: string }[];
    expect(roles.map((r) => r.role).sort()).toEqual(["DOCTOR", "FRONT_DESK", "HOSPITAL_ADMIN", "PATIENT_COORDINATOR", "SUPER_ADMIN"]);
  });

  it.each([
    ["SUPER_ADMIN", "gyn.superadmin@pulseos.local"],
    ["HOSPITAL_ADMIN", "gyn.admin@pulseos.local"],
    ["DOCTOR", "gyn.doctor@pulseos.local"],
    ["FRONT_DESK", "gyn.frontdesk@pulseos.local"],
    ["PATIENT_COORDINATOR", "gyn.coordinator@pulseos.local"],
  ])("logs in as %s and returns a real, working session cookie for %s", async (role, expectedEmail) => {
    const app = await buildWithEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "true" });
    apps.push(app);

    const login = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe(role);
    expect(login.json().user.email).toBe(expectedEmail);

    const cookie = login.cookies.find((c) => c.name === "pulseos_session");
    expect(cookie).toBeDefined();

    // Same normal session behavior as a real password login — not a
    // parallel/weaker auth path.
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie!.value } });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.role).toBe(role);
  });

  it("rejects an environment with no such role seeded rather than crashing", async () => {
    const app = await buildWithEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "true" });
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "DOCTOR", environment: "not-an-environment" } });
    expect(res.statusCode).toBe(400);
  });

  it("the Ophthalmology V1 environment signs in to a Beta V1 tenant; the V2 environment to a growth tenant", async () => {
    const app = await buildWithEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "true" });
    apps.push(app);
    const v1 = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN", environment: "ophthalmology-v1" } });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().user.edition).toBe("BETA_V1_CORE");
    expect(v1.json().user.email).toBe("eyev1.admin@pulseos.local");
    const v2 = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN", environment: "ophthalmology" } });
    expect(v2.json().user.edition).toBe("BETA_V2_GROWTH");
  });

  it("rejects an unknown role string", async () => {
    const app = await buildWithEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "true" });
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "NOT_A_REAL_ROLE" } });
    expect(res.statusCode).toBe(400);
  });
});
