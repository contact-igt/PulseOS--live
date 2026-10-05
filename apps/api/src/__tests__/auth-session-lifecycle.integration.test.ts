import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { sessions, tenants } from "../db/schema.js";
import type { FastifyInstance } from "fastify";

// End-to-end session lifecycle against the real app: a login creates a real
// server session, logout revokes it server-side (the old cookie stops
// working, not just disappears from the browser), and Developer Login yields
// the same kind of session, in the selected demo tenant, with the right role.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

function sessionCookie(res: { cookies: { name: string; value: string; httpOnly?: boolean }[] }) {
  return res.cookies.find((c) => c.name === "pulseos_session");
}

describe.skipIf(!DEMO_PASSWORD)("auth session lifecycle (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const prev = process.env.ENABLE_DEV_LOGIN;
    process.env.ENABLE_DEV_LOGIN = "true";
    app = await buildApp();
    await app.ready();
    if (prev === undefined) delete process.env.ENABLE_DEV_LOGIN;
    else process.env.ENABLE_DEV_LOGIN = prev;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  async function login(email: string, password = DEMO_PASSWORD!) {
    return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  }

  async function sessionStatus(cookie: string) {
    return (await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } })).statusCode;
  }

  it("an unknown user gets the same 401 as a wrong password (no account enumeration)", async () => {
    const unknown = await login("nobody@pulseos.local");
    const wrong = await login("eye.admin@pulseos.local", "not-the-password");
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("login sets an httpOnly session cookie that authenticates protected API calls", async () => {
    const res = await login("eye.admin@pulseos.local");
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie?.httpOnly).toBe(true);
    expect(await sessionStatus(cookie!.value)).toBe(200);
    const protectedRes = await app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: cookie!.value } });
    expect(protectedRes.statusCode).toBe(200);
  });

  it("a malformed session cookie is treated as signed out: login, logout and session still work", async () => {
    const bad = { pulseos_session: "not-a-uuid" };
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: bad })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/logout", cookies: bad })).statusCode).toBeLessThan(400);
    const res = await app.inject({ method: "POST", url: "/auth/login", cookies: bad, payload: { email: "eye.admin@pulseos.local", password: DEMO_PASSWORD } });
    expect(res.statusCode).toBe(200);
  });

  it("the session user carries the hospital timezone (from the tenant, never the client)", async () => {
    const res = await login("eye.admin@pulseos.local");
    expect(res.json().user.timezone).toBe("Asia/Kolkata");
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: sessionCookie(res)!.value } });
    expect(session.json().user.timezone).toBe("Asia/Kolkata");
  });

  it("logout revokes the session server-side: the same cookie is rejected afterwards", async () => {
    const cookie = sessionCookie(await login("eye.coordinator@pulseos.local"))!.value;
    expect(await sessionStatus(cookie)).toBe(200);

    const out = await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: cookie } });
    expect(out.statusCode).toBe(200);
    expect(await sessionStatus(cookie)).toBe(401);
    expect((await app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: cookie } })).statusCode).toBe(401);
  });

  it("logout is safe to call twice and without any session", async () => {
    const cookie = sessionCookie(await login("eye.frontdesk@pulseos.local"))!.value;
    expect((await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/logout" })).statusCode).toBe(200);
  });

  it("an expired session is treated as unauthenticated", async () => {
    const cookie = sessionCookie(await login("eye.doctor@pulseos.local"))!.value;
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessions.id, cookie));
    expect(await sessionStatus(cookie)).toBe(401);
  });

  describe.each([
    ["ophthalmology", "PulseOS Ophthalmology Demo"],
    ["gynecology", "PulseOS Gynecology Demo"],
  ])("Developer Login — %s", (environment, tenantName) => {
    it.each(["HOSPITAL_ADMIN", "DOCTOR", "FRONT_DESK", "PATIENT_COORDINATOR"])("%s gets a real server session in the selected tenant", async (role) => {
      const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { environment, role } });
      expect(res.statusCode).toBe(200);
      const cookie = sessionCookie(res)!.value;

      const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } });
      expect(session.statusCode).toBe(200);
      const { user } = session.json() as { user: { role: string; tenantId: string } };
      expect(user.role).toBe(role);
      const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, user.tenantId));
      expect(tenant.name).toBe(tenantName);

      await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: cookie } });
      expect(await sessionStatus(cookie)).toBe(401);
    });
  });

  it("Developer Login rejects an unknown environment instead of silently picking a tenant", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { environment: "cardiology", role: "HOSPITAL_ADMIN" } });
    expect([400, 404]).toContain(res.statusCode);
    expect(sessionCookie(res)).toBeUndefined();
  });
});
