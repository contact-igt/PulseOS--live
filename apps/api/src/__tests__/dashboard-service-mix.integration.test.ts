import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray, sum } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { journeys, revenueEvents, tasks, treatmentOpportunities } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { AttentionItem, ServiceMixRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

interface Session { cookie: string; tenantId: string }

describe.skipIf(!DEMO_PASSWORD)("Command Centre data: attention links + service mix (integration)", () => {
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

  it("attention items carry the real patient and journey ids of their task (the item id is a task id, not a patient id)", async () => {
    const items = await get<AttentionItem[]>("ophthalmology", "/dashboard/attention");
    expect(items.length).toBeGreaterThan(0);
    const rows = await db
      .select({ id: tasks.id, patientId: tasks.patientId, journeyId: tasks.journeyId })
      .from(tasks)
      .where(inArray(tasks.id, items.map((i) => i.id)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const item of items) {
      const row = byId.get(item.id);
      expect(row, `attention item ${item.id} is a task`).toBeTruthy();
      expect(item.patientId).toBe(row!.patientId);
      expect(item.journeyId).toBe(row!.journeyId);
    }
  });

  describe.each(["gynecology", "ophthalmology"])("%s tenant service mix", (key) => {
    it("has one row per journey type, and every figure reconciles with the raw rows", async () => {
      const tenantId = sessions[key].tenantId;
      const mix = await get<ServiceMixRow[]>(key, "/dashboard/service-mix");

      const journeyCounts = await db
        .select({ service: journeys.journeyType, c: count() })
        .from(journeys)
        .where(eq(journeys.tenantId, tenantId))
        .groupBy(journeys.journeyType);
      expect(mix.map((r) => r.service).sort()).toEqual(journeyCounts.map((r) => r.service).sort());
      expect(mix.reduce((s, r) => s + r.journeys, 0)).toBe(journeyCounts.reduce((s, r) => s + r.c, 0));

      for (const row of mix) {
        expect(row.journeys).toBe(journeyCounts.find((r) => r.service === row.service)!.c);

        const [{ c: completed }] = await db
          .select({ c: count() })
          .from(treatmentOpportunities)
          .innerJoin(journeys, eq(treatmentOpportunities.journeyId, journeys.id))
          .where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(journeys.journeyType, row.service), eq(treatmentOpportunities.status, "COMPLETED")));
        expect(row.treatmentsCompleted, `${row.service} completed`).toBe(completed);

        const [{ total }] = await db
          .select({ total: sum(revenueEvents.amount) })
          .from(revenueEvents)
          .innerJoin(journeys, eq(revenueEvents.journeyId, journeys.id))
          .where(and(eq(revenueEvents.tenantId, tenantId), eq(journeys.journeyType, row.service)));
        expect(row.revenue, `${row.service} revenue`).toBe(Number(total ?? 0));

        expect(row.activeJourneys).toBeLessThanOrEqual(row.journeys);
        expect(row.treatmentsInPipeline).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // Isolation is also proven above (per-tenant totals reconcile exactly with
  // that tenant's own rows — a leaked row would inflate them); this pins the
  // specialty content so a mis-scoped query can't pass by coincidence.
  it("each tenant's mix reflects its own specialty", async () => {
    const eye = await get<ServiceMixRow[]>("ophthalmology", "/dashboard/service-mix");
    const gyn = await get<ServiceMixRow[]>("gynecology", "/dashboard/service-mix");
    expect(eye.some((r) => /cataract/i.test(r.service))).toBe(true);
    expect(gyn.some((r) => /cataract/i.test(r.service))).toBe(false);
  });

  it("requires the admin command-centre permission", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "eye.frontdesk@pulseos.local", password: DEMO_PASSWORD } });
    const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const res = await app.inject({ method: "GET", url: "/dashboard/service-mix", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(403);
  });
});
