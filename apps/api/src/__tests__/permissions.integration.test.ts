import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("role permission enforcement (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let doctorCookie: string;
  let frontDeskCookie: string;
  let coordinatorCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");
    frontDeskCookie = await loginAs(app, "gyn.frontdesk@pulseos.local");
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("Hospital Admin has expected access to the admin Command Centre", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
  });

  it("Doctor cannot access the admin Command Centre API/data", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("VIEW_ADMIN_COMMAND_CENTRE");
  });

  it("Doctor cannot access marketing/revenue data (source performance, spend at risk)", async () => {
    const [source, spend] = await Promise.all([
      app.inject({ method: "GET", url: "/dashboard/source-performance", cookies: { pulseos_session: doctorCookie } }),
      app.inject({ method: "GET", url: "/dashboard/spend-at-risk", cookies: { pulseos_session: doctorCookie } }),
    ]);
    expect(source.statusCode).toBe(403);
    expect(spend.statusCode).toBe(403);
  });

  it("Front Desk cannot record a consultation outcome", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/appointments/00000000-0000-0000-0000-000000000000/outcome",
      cookies: { pulseos_session: frontDeskCookie },
      payload: { outcome: "CONSULTED" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("RECORD_CONSULTATION_OUTCOME");
  });

  it("Coordinator can view journeys and treatment context but not the admin Command Centre", async () => {
    const [journeys, dashboard] = await Promise.all([
      app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: coordinatorCookie } }),
      app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: coordinatorCookie } }),
    ]);
    expect(journeys.statusCode).toBe(200);
    expect(dashboard.statusCode).toBe(403);
  });

  it("Front Desk can view patients and journeys (operational access, not marketing)", async () => {
    const res = await app.inject({ method: "GET", url: "/patients", cookies: { pulseos_session: frontDeskCookie } });
    expect(res.statusCode).toBe(200);
  });

  it("Doctor can view their own doctor dashboard; Front Desk cannot", async () => {
    const [doctorOk, frontDeskForbidden] = await Promise.all([
      app.inject({ method: "GET", url: "/dashboard/doctor", cookies: { pulseos_session: doctorCookie } }),
      app.inject({ method: "GET", url: "/dashboard/doctor", cookies: { pulseos_session: frontDeskCookie } }),
    ]);
    expect(doctorOk.statusCode).toBe(200);
    expect(frontDeskForbidden.statusCode).toBe(403);
  });

  it("tenant isolation remains intact under permission enforcement (no session = 401, not 403)", async () => {
    const res = await app.inject({ method: "GET", url: "/journeys" });
    expect(res.statusCode).toBe(401);
  });
});
