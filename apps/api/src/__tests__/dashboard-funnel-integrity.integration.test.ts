import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, sql, sum } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, journeys, revenueEvents, treatmentOpportunities } from "../db/schema.js";
import { hospitalTodayBounds, tenantTimezone } from "../lib/hospital-time.js";
import type { FastifyInstance } from "fastify";

// The dashboard's numbers must reconcile with the raw rows behind them — for
// every tenant — not just be non-empty. Each figure is re-derived from the
// database here and compared with what the API reports.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

interface Session { cookie: string; tenantId: string }

describe.skipIf(!DEMO_PASSWORD)("dashboard numbers reconcile with source rows (integration)", () => {
  let app: FastifyInstance;
  const sessions: Record<string, Session> = {};

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const [key, email] of [["gynecology", "gyn.admin@pulseos.local"], ["ophthalmology", "eye.admin@pulseos.local"]]) {
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
      const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
      const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } });
      sessions[key] = { cookie, tenantId: (session.json() as { user: { tenantId: string } }).user.tenantId };
    }
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  async function get<T>(key: string, url: string): Promise<T> {
    const res = await app.inject({ method: "GET", url, cookies: { pulseos_session: sessions[key].cookie } });
    expect(res.statusCode, url).toBe(200);
    return res.json() as T;
  }

  describe.each(["gynecology", "ophthalmology"])("%s tenant", (key) => {
    it("the funnel's Enquiry stage counts every journey — the same number as the Enquiries KPI and the journey table", async () => {
      const [{ c: journeyRows }] = await db.select({ c: count() }).from(journeys).where(eq(journeys.tenantId, sessions[key].tenantId));
      const executive = await get<{ enquiries: number }>(key, "/dashboard/executive");
      const funnel = await get<{ key: string; count: number }[]>(key, "/dashboard/conversion");
      const health = await get<{ totalJourneys: number }>(key, "/dashboard/journey-health");
      expect(executive.enquiries).toBe(journeyRows);
      expect(funnel.find((s) => s.key === "enquiry")!.count).toBe(journeyRows);
      expect(health.totalJourneys).toBe(journeyRows);
    });

    it("the funnel never widens: each stage reaches at most as many journeys as the one before", async () => {
      const funnel = await get<{ key: string; count: number }[]>(key, "/dashboard/conversion");
      for (let i = 1; i < funnel.length; i++) expect(funnel[i].count, `${funnel[i].key} <= ${funnel[i - 1].key}`).toBeLessThanOrEqual(funnel[i - 1].count);
    });

    it("attributed revenue and completed treatments equal the raw revenue and treatment rows", async () => {
      const [{ total }] = await db.select({ total: sum(revenueEvents.amount) }).from(revenueEvents).where(eq(revenueEvents.tenantId, sessions[key].tenantId));
      const [{ c: completed }] = await db
        .select({ c: count() })
        .from(treatmentOpportunities)
        .where(and(eq(treatmentOpportunities.tenantId, sessions[key].tenantId), eq(treatmentOpportunities.status, "COMPLETED")));
      const executive = await get<{ attributedRevenue: number; treatmentsCompleted: number }>(key, "/dashboard/executive");
      expect(executive.attributedRevenue).toBe(Number(total ?? 0));
      expect(executive.treatmentsCompleted).toBe(completed);
    });

    it("revenue is only ever booked against completed treatments", async () => {
      const rows = await db
        .select({ status: treatmentOpportunities.status })
        .from(revenueEvents)
        .innerJoin(treatmentOpportunities, eq(revenueEvents.treatmentOpportunityId, treatmentOpportunities.id))
        .where(eq(revenueEvents.tenantId, sessions[key].tenantId));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === "COMPLETED")).toBe(true);
    });

    it("today's Patient Flow buckets add up to today's appointments", async () => {
      // "Today" is the hospital's day (tenants.timezone), never the test process's (UTC) — between 18:30 and 24:00
      // UTC the two are different calendar days.
      const { start, end } = hospitalTodayBounds(await tenantTimezone(db, sessions[key].tenantId));
      const [{ c }] = await db
        .select({ c: count() })
        .from(appointments)
        .where(and(eq(appointments.tenantId, sessions[key].tenantId), sql`${appointments.scheduledAt} >= ${start}`, sql`${appointments.scheduledAt} < ${end}`));
      const flow = await get<{ bucket: string; count: number }[]>(key, "/dashboard/patient-flow");
      const today = await get<{ appointmentsToday: number }>(key, "/dashboard/today");
      expect(today.appointmentsToday).toBe(c);
      // no_show / cancelled are outside the in-clinic buckets
      expect(flow.reduce((s, b) => s + b.count, 0)).toBeLessThanOrEqual(c);
    });

    it("campaign revenue never exceeds the tenant's total attributed revenue", async () => {
      const executive = await get<{ attributedRevenue: number }>(key, "/dashboard/executive");
      const campaigns = await get<{ revenue: number }[]>(key, "/campaigns/performance");
      expect(campaigns.reduce((s, c) => s + c.revenue, 0)).toBeLessThanOrEqual(executive.attributedRevenue);
    });
  });
});
