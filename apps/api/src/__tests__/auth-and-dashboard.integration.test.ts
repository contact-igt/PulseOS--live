import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded PulseOS dev DB
// (the same one `pnpm db:seed` populates), and DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("auth + admin dashboard (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects invalid credentials with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.admin@pulseos.local", password: "definitely-wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logs in the seeded admin and returns real dashboard aggregation", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "pulseos_session");
    expect(cookie).toBeDefined();

    const today = await app.inject({
      method: "GET",
      url: "/dashboard/today",
      cookies: { pulseos_session: cookie!.value },
    });
    expect(today.statusCode).toBe(200);
    const body = today.json();
    expect(typeof body.appointmentsToday).toBe("number");
    expect(body.appointmentsToday).toBeGreaterThanOrEqual(0);
  });

  it("rejects an unauthenticated dashboard request", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/today" });
    expect(res.statusCode).toBe(401);
  });

  it("blocks a doctor-only endpoint for the admin role", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD },
    });
    const cookie = login.cookies.find((c) => c.name === "pulseos_session")!;

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/doctor",
      cookies: { pulseos_session: cookie.value },
    });
    expect(res.statusCode).toBe(403);
  });

  it("conversion funnel is monotonically non-increasing and never exceeds the first stage", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD },
    });
    const cookie = login.cookies.find((c) => c.name === "pulseos_session")!;

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/conversion",
      cookies: { pulseos_session: cookie.value },
    });
    expect(res.statusCode).toBe(200);
    const stages = res.json() as { count: number }[];
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].count).toBeLessThanOrEqual(stages[i - 1].count);
    }
    for (const stage of stages) {
      expect(stage.count).toBeLessThanOrEqual(stages[0].count);
    }
  });
});
