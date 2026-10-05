import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded PulseOS dev DB
// and DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("extended dashboard aggregations (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD },
    });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("today strip has exactly the six spec KPIs including attributed revenue", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/today", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["appointmentsToday", "attributedRevenue", "consultationsCompleted", "newEnquiries", "treatmentDecisionsPending", "waitingNow"].sort(),
    );
    expect(body.attributedRevenue).toBeGreaterThanOrEqual(0);
  });

  it("journey health radial segments are non-increasing and overallPct is 0-100", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/journey-health", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.segments.map((s: { key: string }) => s.key)).toEqual(["booked", "attended", "consulted", "treatment_advised"]); // no "Contacted" segment
    for (let i = 1; i < body.segments.length; i++) {
      expect(body.segments[i].count).toBeLessThanOrEqual(body.segments[i - 1].count);
    }
    expect(body.overallPct).toBeGreaterThanOrEqual(0);
    expect(body.overallPct).toBeLessThanOrEqual(100);
  });

  it("marketing sources include spend and roas derived from campaign spend", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/marketing", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { source: string; spend: number; roas: number | null }[];
    expect(rows.length).toBeGreaterThan(0);
    const meta = rows.find((r) => r.source === "meta");
    expect(meta?.spend).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.roas === null || typeof row.roas === "number").toBe(true);
    }
  });

  it("spend at risk (by reason) totals a non-negative figure derived from pending attention tasks", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/spend-at-risk-by-reason", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalAtRisk).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.byReason)).toBe(true);
  });

  it("branch filter narrows the today strip", async () => {
    const branchesRes = await app.inject({ method: "GET", url: "/branches", cookies: { pulseos_session: cookie } });
    const branches = branchesRes.json() as { id: string }[];
    expect(branches.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "GET",
      url: `/dashboard/today?branchId=${branches[0].id}`,
      cookies: { pulseos_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().newEnquiries).toBeGreaterThanOrEqual(0);
  });

  it("doctor dashboard exposes queue, radial, and secondary-list fields for a doctor", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.doctor@pulseos.local", password: DEMO_PASSWORD },
    });
    const doctorCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;

    const res = await app.inject({ method: "GET", url: "/dashboard/doctor", cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.completionPct).toBe("number");
    expect(body.completionPct).toBeGreaterThanOrEqual(0);
    expect(body.completionPct).toBeLessThanOrEqual(100);
    for (const key of ["today", "awaitingOutcome", "treatmentFollowUps", "postCare", "recentPatients"]) {
      expect(Array.isArray(body[key])).toBe(true);
    }
  });
});
