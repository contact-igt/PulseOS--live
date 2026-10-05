import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import type { OperationsReport, Role, TreatmentDefinitionVm, TreatmentRow } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { revenueEvents, scheduleResources, timelineEvents, treatmentOpportunities } from "../db/schema.js";
import { addDays, dayKeyIn, zonedWallTime } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const IST = "Asia/Kolkata";

// Three different dates answer three different questions, and must never be mistaken for one another:
//   Scheduled for = treatment_opportunities.planned_date        (the calendar)
//   Completed on  = treatment_opportunities.completed_at        (completed-procedure reporting)
//   Payment date  = revenue_events.occurred_at                  (revenue)
describe.skipIf(!DEMO_PASSWORD)("treatment completion date and reporting (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  let catalog: TreatmentDefinitionVm[];
  let doctorId: string;
  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: as(tt, role), ...(payload ? { payload } : {}) });
  const phone = () => `+9198${String(71000000 + ++n * 41).padStart(8, "0")}`;
  const today = dayKeyIn(new Date(), IST);
  const D1 = addDays(today, -4);
  const D2 = addDays(today, -3);
  const D3 = addDays(today, -2);
  const at = (day: string, h: number, m = 0) => zonedWallTime(day, h, m, IST);
  const range = (from: string, to: string) => `range=custom&from=${from}&to=${to}`;

  /** A procedure scheduled through the real service and walked to COMPLETED through the real transition. */
  async function scheduled(label = "Cataract") {
    const lead = await call(t, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: `Completion ${label}`, specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(lead.statusCode).toBe(201);
    const { journeyId, patientId } = lead.json() as { journeyId: string; patientId: string };
    const res = await call(t, "PATIENT_COORDINATOR", "POST", `/journeys/${journeyId}/surgery`, {
      treatmentDefinitionId: catalog.find((d) => d.key === "CATARACT_SURGERY")!.id, scheduledAt: new Date(Date.now() + 5 * 86_400_000 + ++n * 60_000).toISOString(), resourceId: doctorId, branchId: t.branchId,
    });
    expect(res.statusCode, res.body).toBe(201);
    return { journeyId, patientId, treatmentId: (res.json() as { treatmentId: string }).treatmentId };
  }
  const complete = (id: string) => call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${id}/status`, { status: "COMPLETED" });
  const rowOf = async (id: string) => (await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.id, id)))[0]!;
  const report = async (q: string, tt = t) => {
    const res = await call(tt, "HOSPITAL_ADMIN", "GET", `/reports/operations?${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as OperationsReport;
  };
  const sheet = async (kind: string, q: string, name: string) => {
    const res = await call(t, "HOSPITAL_ADMIN", "GET", `/reports/export?kind=${kind}&${q}`);
    expect(res.statusCode, res.body).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(name)!;
    const rows: string[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v)))));
    return rows;
  };

  beforeAll(async () => {
    app = await buildApp();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, other]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    catalog = (await call(t, "HOSPITAL_ADMIN", "GET", "/treatment-catalog")).json() as TreatmentDefinitionVm[];
    const [d] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, t.tenantId), eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)));
    doctorId = d!.id;
  });
  afterAll(async () => {
    for (const tt of [t, other]) {
      if (!tt) continue;
      for (const table of ["revenue_events", "tasks", "treatment_opportunities", "appointments"]) await db.execute(sql`delete from ${sql.raw(table)} where tenant_id = ${tt.tenantId}::uuid`);
      await destroyTestTenant(db, tt);
    }
    await app?.close();
    await queryClient.end();
  });

  describe("the transition stamps completedAt", () => {
    it("completing through the treatment service sets completedAt from the server clock, once; payment and the Timeline agree", async () => {
      const { treatmentId } = await scheduled();
      expect((await rowOf(treatmentId)).completedAt).toBeNull(); // scheduled, not completed
      const before = Date.now();
      expect((await complete(treatmentId)).statusCode).toBe(200);
      const row = await rowOf(treatmentId);
      expect(row.status).toBe("COMPLETED");
      expect(row.completedAt).not.toBeNull();
      expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.completedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      const [rev] = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatmentId));
      expect(rev!.occurredAt.getTime()).toBe(row.completedAt!.getTime()); // recorded in the same instant, as its own fact
      // the API exposes it next to the (different) scheduled date
      const listed = ((await call(t, "HOSPITAL_ADMIN", "GET", "/treatments")).json() as TreatmentRow[]).find((r) => r.id === treatmentId)!;
      expect(listed.completedAt).toBe(row.completedAt!.toISOString());
      expect(listed.plannedDate).not.toBe(listed.completedAt);
    });

    it("completing again changes nothing and adds no second event, payment or follow-up", async () => {
      const { treatmentId } = await scheduled();
      await complete(treatmentId);
      const first = await rowOf(treatmentId);
      const again = await complete(treatmentId);
      expect(again.statusCode).toBe(409);
      expect((await rowOf(treatmentId)).completedAt!.getTime()).toBe(first.completedAt!.getTime());
      const lines = await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityId, treatmentId), sql`${timelineEvents.title} like '% — completed'`));
      expect(lines).toHaveLength(1);
      expect(await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatmentId))).toHaveLength(1);
    });

    it("two racing completions end with one stamp", async () => {
      const { treatmentId } = await scheduled();
      const results = await Promise.all([complete(treatmentId), complete(treatmentId), complete(treatmentId)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect(await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatmentId))).toHaveLength(1);
    });

    it("a completion time can only ever belong to a COMPLETED treatment (database rule)", async () => {
      const { treatmentId } = await scheduled();
      await expect(db.update(treatmentOpportunities).set({ completedAt: new Date() }).where(eq(treatmentOpportunities.id, treatmentId))).rejects.toThrow();
    });

    it("the Journey page's treatments carry completedAt next to the planned date (not 'date not recorded')", async () => {
      const { treatmentId, journeyId } = await scheduled();
      await complete(treatmentId);
      const detail = (await call(t, "HOSPITAL_ADMIN", "GET", `/journeys/${journeyId}`)).json() as { treatments: TreatmentRow[] };
      const row = detail.treatments.find((x) => x.id === treatmentId)!;
      expect(row.completedAt).toBe((await rowOf(treatmentId)).completedAt!.toISOString());
      expect(row.plannedDate).not.toBeNull();
      expect(row.plannedDate).not.toBe(row.completedAt);
    });

    it("the status endpoint cannot rewrite 'Scheduled for' while completing, and refuses a malformed date instead of failing with a 500", async () => {
      const { treatmentId } = await scheduled();
      const planned = (await rowOf(treatmentId)).plannedDate!.getTime();
      expect((await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/status`, { status: "COMPLETED", plannedDate: "2020-01-05T10:00:00Z" })).statusCode).toBe(200);
      const row = await rowOf(treatmentId);
      expect(row.plannedDate!.getTime()).toBe(planned); // still the date it was scheduled for
      const { treatmentId: other2 } = await scheduled();
      const bad = await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${other2}/status`, { status: "COMPLETED", plannedDate: "not-a-date" });
      expect(bad.statusCode).toBe(400);
      expect((await rowOf(other2)).status).toBe("SCHEDULED");
      expect((await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${other2}/status`, { status: "NOPE" })).statusCode).toBe(400);
    });

    it("another hospital cannot complete this hospital's procedure", async () => {
      const { treatmentId } = await scheduled();
      const res = await call(other, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/status`, { status: "COMPLETED" });
      expect(res.statusCode).toBe(404);
      expect((await rowOf(treatmentId)).completedAt).toBeNull();
    });
  });

  describe("reports use the true completion time", () => {
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      // A: scheduled for D1, completed D2, paid D3 — three different days on purpose.
      const a = await scheduled("A");
      await complete(a.treatmentId);
      await db.update(treatmentOpportunities).set({ plannedDate: at(D1, 10), completedAt: at(D2, 12) }).where(eq(treatmentOpportunities.id, a.treatmentId));
      await db.update(revenueEvents).set({ occurredAt: at(D3, 15) }).where(eq(revenueEvents.treatmentOpportunityId, a.treatmentId));
      // B: a historical completed row whose completion time was never recorded, but which has a payment inside the period.
      const b = await scheduled("B");
      await complete(b.treatmentId);
      // The legacy shape: completed, but neither a planned date nor a completion time was ever recorded.
      await db.update(treatmentOpportunities).set({ plannedDate: null, completedAt: null }).where(eq(treatmentOpportunities.id, b.treatmentId));
      await db.update(revenueEvents).set({ occurredAt: at(D2, 11) }).where(eq(revenueEvents.treatmentOpportunityId, b.treatmentId));
      Object.assign(ids, { a: a.treatmentId, b: b.treatmentId, aJourney: a.journeyId, bJourney: b.journeyId });
    });

    it("'Procedures completed' lands on the completion day — not the planned day and not the payment day", async () => {
      expect((await report(range(D2, D2))).kpis.proceduresCompleted).toBe(1);
      expect((await report(range(D1, D1))).kpis.proceduresCompleted).toBe(0); // planned that day
      expect((await report(range(D3, D3))).kpis.proceduresCompleted).toBe(0); // paid that day
    });

    it("'Procedures planned' still follows the planned (scheduled-for) date", async () => {
      expect((await report(range(D1, D1))).kpis.proceduresScheduled).toBe(1);
      expect((await report(range(D2, D2))).kpis.proceduresScheduled).toBe(0);
    });

    it("a historical completed row with no completion time is NOT dated by its payment — it is counted as 'date not recorded'", async () => {
      const wide = await report(range(D1, D3));
      expect(wide.kpis.proceduresCompleted).toBe(1); // only A; B's payment on D2 does not make it a D2 completion
      expect(wide.kpis.proceduresCompletedUndated).toBeGreaterThanOrEqual(1);
      const row = ((await call(t, "HOSPITAL_ADMIN", "GET", "/treatments")).json() as TreatmentRow[]).find((r) => r.id === ids.b)!;
      expect(row.status).toBe("COMPLETED");
      expect(row.completedAt).toBeNull(); // readable, honestly undated
    });

    it("'completed, date not recorded' stays visible when a branch or doctor filter is chosen (legacy rows have neither recorded)", async () => {
      const unfiltered = (await report(range(D1, D3))).kpis.proceduresCompletedUndated;
      expect(unfiltered).toBeGreaterThanOrEqual(1);
      expect((await report(`${range(D1, D3)}&branchId=${t.branchId}`)).kpis.proceduresCompletedUndated).toBe(unfiltered);
      expect((await report(`${range(D1, D3)}&doctorId=${doctorId}`)).kpis.proceduresCompletedUndated).toBe(unfiltered);
    });

    it("hospital days: a completion at 00:20 IST belongs to that IST day although UTC is still the day before", async () => {
      await db.update(treatmentOpportunities).set({ completedAt: at(D2, 0, 20) }).where(eq(treatmentOpportunities.id, ids.a!));
      expect(at(D2, 0, 20).toISOString().slice(0, 10)).toBe(addDays(D2, -1));
      expect((await report(range(D2, D2))).kpis.proceduresCompleted).toBe(1);
      expect((await report(range(addDays(D2, -1), addDays(D2, -1)))).kpis.proceduresCompleted).toBe(0);
      await db.update(treatmentOpportunities).set({ completedAt: at(D2, 12) }).where(eq(treatmentOpportunities.id, ids.a!));
    });

    it("the Excel 'Procedures' workbook shows Scheduled for, Completed on and Payment date as three separate columns", async () => {
      const rows = await sheet("procedures", range(D1, D3), "Procedures");
      const [header, ...body] = rows;
      expect(header).toEqual(["Procedure", "Patient", "Phone", "Service", "Status", "Scheduled for", "Completed on", "Payment date", "Doctor", "Branch", "Estimated value (₹)", "In this report"]);
      const a = body.find((r) => r[1] === "Completion A")!;
      expect(a[5]).toMatch(/10:00/); // planned D1
      expect(a[6]).toMatch(/12:00/); // completed D2
      expect(a[7]).toMatch(/15:00/); // paid D3
      expect(new Set([a[5], a[6], a[7]]).size).toBe(3);
      const b = body.find((r) => r[1] === "Completion B")!;
      expect(b[6]).toBe("Date not recorded"); // never the payment date
      expect(b[5]).toBe("Date not recorded");
      expect(b[7]).toMatch(/11:00/);
      // Every row says whether it is part of the screen's counts, so the sheet reconciles with the KPIs.
      expect(a[11]).toBe("Planned in period · Completed in period"); // scheduled D1 and completed D2, both inside D1–D3
      expect(b[11]).toBe("Not counted — completion date not recorded");
    });

    it("the summary workbook counts completed procedures by completion date and states the undated ones", async () => {
      const rows = await sheet("summary", range(D2, D2), "Summary");
      const done = rows.find((r) => r[0] === "Procedures completed")!;
      expect(done[1]).toBe("1");
      expect(done[2]).toMatch(/completed in the period/i);
      expect(rows.find((r) => r[0] === "Completed, date not recorded")).toBeTruthy();
    });

    it("another hospital sees none of this, in the report or the workbook", async () => {
      expect((await report(range(D1, D3), other)).kpis).toMatchObject({ proceduresCompleted: 0, proceduresScheduled: 0, proceduresCompletedUndated: 0 });
    });
  });
});
