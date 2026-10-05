import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import type { CrmOutcomeVm, OperationsReport, ReportFilterOptions, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, departments, journeys, revenueEvents, scheduleResources, tasks, treatmentOpportunities } from "../db/schema.js";
import { addDays, dayKeyIn, zonedWallTime } from "../lib/hospital-time.js";
import { resolveReportRange } from "../domain/report/report-period.js";
import { buildOperationsReport, type EnquiryFact } from "../domain/report/operations-report.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const IST = "Asia/Kolkata";

describe("report periods (unit) — hospital calendar days", () => {
  it("resolves every preset from the hospital's today", () => {
    expect(resolveReportRange("today", "2026-10-02")).toEqual({ from: "2026-10-02", to: "2026-10-02" });
    expect(resolveReportRange("yesterday", "2026-10-01")).toEqual({ from: "2026-09-30", to: "2026-09-30" });
    expect(resolveReportRange("7d", "2026-10-02")).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(resolveReportRange("30d", "2026-10-02")).toEqual({ from: "2026-09-03", to: "2026-10-02" });
    expect(resolveReportRange("this_month", "2026-10-02")).toEqual({ from: "2026-10-01", to: "2026-10-02" });
    expect(resolveReportRange("last_month", "2026-10-02")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolveReportRange("last_month", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolveReportRange("last_month", "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("refuses broken custom ranges", () => {
    expect(() => resolveReportRange("custom", "2026-10-02")).toThrow();
    expect(() => resolveReportRange("custom", "2026-10-02", "2026-10-02", "2026-10-01")).toThrow();
    expect(() => resolveReportRange("custom", "2026-10-02", "2026-09-01", "2026-10-03")).toThrow(/after today/);
    expect(() => resolveReportRange("custom", "2026-10-02", "2025-01-01", "2026-10-01")).toThrow(/366/);
    expect(() => resolveReportRange("custom", "2026-10-02", "2026-02-30", "2026-03-01")).toThrow();
    expect(resolveReportRange("custom", "2026-10-02", "2026-09-01", "2026-10-02")).toEqual({ from: "2026-09-01", to: "2026-10-02" });
  });
});

describe("operations report aggregation (unit)", () => {
  const period = { range: "custom" as const, from: "2026-09-01", to: "2026-09-02", days: 2, timezone: IST, today: "2026-10-01" };
  const e = (over: Partial<EnquiryFact>): EnquiryFact => ({
    id: Math.random().toString(36), patientId: "p", patientName: "x", phone: "+91", day: "2026-09-01", createdAt: new Date(), stage: "contacted", service: "Cataract",
    sourceId: null, sourceLabel: null, bucket: "google", ownerUserId: null, ownerName: null, branchName: null, contacted: true, lastOutcomeKey: null,
    lastOutcomeLabel: null, booked: false, attended: false, consulted: false, procedure: false, converted: false, ...over,
  });

  it("'No response' = latest outcome No answer AND never got past Contacted AND not closed as lost", () => {
    const r = buildOperationsReport({
      period, appointments: [], followUps: [], procedures: [], completedUndated: 0,
      enquiries: [e({ lastOutcomeKey: "no_answer" }), e({ lastOutcomeKey: "no_answer", booked: true }), e({ lastOutcomeKey: "no_answer", stage: "lost" }), e({ lastOutcomeKey: "interested" })],
    });
    expect(r.kpis.noResponse).toBe(1);
  });

  it("an empty period is all zeros with a null rate, one row per day, and no invented breakdown rows", () => {
    const r = buildOperationsReport({ period, enquiries: [], appointments: [], followUps: [], procedures: [], completedUndated: 0 });
    expect(r.kpis.conversionRate).toBeNull();
    expect(Object.values(r.kpis).filter((v) => typeof v === "number" && v !== 0)).toEqual([]);
    expect(r.daily.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-02"]);
    expect([r.bySource, r.byOwner, r.byService]).toEqual([[], [], []]);
  });
});

describe.skipIf(!DEMO_PASSWORD)("operations report + Excel export (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  const get = (tt: TestTenant, role: Role, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: tt.cookie[role]! } });
  const phone = () => `+9196${String(52000000 + ++n * 31).padStart(8, "0")}`;

  // Two fixed past hospital days, so the report's numbers are exact whatever time the suite runs.
  const today = dayKeyIn(new Date(), IST);
  const D1 = addDays(today, -3);
  const D2 = addDays(today, -2);
  const at = (day: string, h: number, m = 0) => zonedWallTime(day, h, m, IST);
  const range = `range=custom&from=${D1}&to=${D2}`;
  const ids: Record<string, string> = {};

  async function lead(name: string, sourceKey: string) {
    const res = await app.inject({
      method: "POST", url: "/leads", cookies: { pulseos_session: t.cookie.FRONT_DESK! },
      payload: { phone: phone(), name, specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey, customFieldValues: {} },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }

  beforeAll(async () => {
    app = await buildApp();
    // Beta V1 — the report has no spend/ROAS and must work for the core edition.
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);

    const j1 = await lead("Report Converted", "google");
    const j2 = await lead("Report Midnight", "walk_in");
    const j3 = await lead("Report NoAnswer", "google");
    const j4 = await lead("Report Old", "google");
    Object.assign(ids, { j1: j1.journeyId, j2: j2.journeyId, j3: j3.journeyId, j4: j4.journeyId });
    // Lead creation may raise its own first-contact tasks; this test owns every task of the tenant.
    await db.delete(tasks).where(eq(tasks.tenantId, t.tenantId));

    const outcomes = (await get(t, "HOSPITAL_ADMIN", "/crm/outcomes")).json() as CrmOutcomeVm[];
    const noAnswer = outcomes.find((o) => o.key === "no_answer")!;
    await db.update(journeys).set({ createdAt: at(D1, 10), stage: "completed", contactedAt: at(D1, 11) }).where(eq(journeys.id, j1.journeyId));
    // 00:15 IST on D2 is still D1 in UTC — it must count on D2.
    await db.update(journeys).set({ createdAt: at(D2, 0, 15) }).where(eq(journeys.id, j2.journeyId));
    await db.update(journeys).set({ createdAt: at(D2, 12), stage: "contacted", contactedAt: at(D2, 12, 30), lastOutcomeId: noAnswer.id, lastOutcomeAt: at(D2, 12, 30) }).where(eq(journeys.id, j3.journeyId));
    await db.update(journeys).set({ createdAt: at(addDays(today, -10), 10) }).where(eq(journeys.id, j4.journeyId));

    const [doctor] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, t.tenantId), eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)));
    ids.doctor = doctor!.id;
    await db.insert(appointments).values([
      { tenantId: t.tenantId, patientId: j1.patientId, journeyId: j1.journeyId, branchId: t.branchId, resourceId: doctor!.id, status: "completed", scheduledAt: at(D2, 11), createdAt: at(D1, 12), completedAt: at(D2, 11, 30) },
      { tenantId: t.tenantId, patientId: j3.patientId, journeyId: j3.journeyId, branchId: t.branchId, resourceId: doctor!.id, status: "no_show", scheduledAt: at(D2, 15), createdAt: at(D2, 13), noShowAt: at(D2, 16) },
    ]);
    await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: j1.patientId, journeyId: j1.journeyId, treatmentLabel: "Cataract surgery", status: "COMPLETED", plannedDate: at(D2, 14), completedAt: at(D2, 14, 30) });
    // An older enquiry's procedure, completed in the period with no planned date: dated by its recorded completion time
    // (its payment on the same day is a separate fact).
    const [older] = await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: j4.patientId, journeyId: j4.journeyId, treatmentLabel: "YAG laser", status: "COMPLETED", completedAt: at(D1, 16, 45) }).returning({ id: treatmentOpportunities.id });
    await db.insert(revenueEvents).values({ tenantId: t.tenantId, patientId: j4.patientId, journeyId: j4.journeyId, treatmentOpportunityId: older!.id, amount: 12000, occurredAt: at(D1, 17) });
    await db.insert(tasks).values([
      { tenantId: t.tenantId, patientId: j3.patientId, journeyId: j3.journeyId, assignedTo: t.userIds.PATIENT_COORDINATOR!, type: "CALLBACK", status: "pending", dueAt: at(D2, 10) },
      { tenantId: t.tenantId, patientId: j1.patientId, journeyId: j1.journeyId, assignedTo: t.userIds.PATIENT_COORDINATOR!, type: "FOLLOW_UP", status: "completed", dueAt: at(D1, 15), completedAt: at(D1, 16) },
      { tenantId: t.tenantId, patientId: j2.patientId, journeyId: j2.journeyId, type: "CALLBACK", status: "pending", dueAt: new Date(Date.now() + 3 * 86_400_000) },
    ]);
  });

  afterAll(async () => {
    if (t) await destroyTestTenant(db, t);
    if (other) await destroyTestTenant(db, other);
    await app?.close();
    await queryClient.end();
  });

  const report = async (q = range, tt = t, role: Role = "HOSPITAL_ADMIN") => {
    const res = await get(tt, role, `/reports/operations?${q}`);
    expect(res.statusCode).toBe(200);
    return res.json() as OperationsReport;
  };

  it("counts the period's loop from the real rows, in hospital days", async () => {
    const r = await report();
    expect(r.period).toMatchObject({ range: "custom", from: D1, to: D2, days: 2, timezone: IST });
    expect(r.kpis).toEqual({
      // j3's last outcome is "No answer" but it went on to book a visit — it responded, so it is not "No response".
      newEnquiries: 3, uncontacted: 1, noResponse: 0,
      followUpsDue: 1, followUpsOverdue: 1, followUpsCompleted: 1,
      appointmentsBooked: 2, appointmentsScheduled: 2, appointmentsAttended: 1, appointmentsNoShow: 1, appointmentsCancelled: 0,
      proceduresScheduled: 1, proceduresCompleted: 2, proceduresCompletedUndated: 0, converted: 1, conversionRate: 1 / 3, consultationsCompleted: 1,
    });
    expect(r.daily).toEqual([
      { day: D1, enquiries: 1, appointmentsScheduled: 0, attended: 0, consultationsCompleted: 0, noShow: 0, cancelled: 0, followUpsDue: 0, followUpsCompleted: 1 },
      { day: D2, enquiries: 2, appointmentsScheduled: 2, attended: 1, consultationsCompleted: 1, noShow: 1, cancelled: 0, followUpsDue: 1, followUpsCompleted: 0 },
    ]);
  });

  it("the funnel never widens and adds up with the KPIs", async () => {
    const r = await report();
    expect(r.funnel.map((s) => [s.key, s.count])).toEqual([["enquiry", 3], ["contacted", 2], ["booked", 2], ["attended", 1], ["procedure", 1], ["converted", 1]]);
    for (let i = 1; i < r.funnel.length; i++) expect(r.funnel[i]!.count).toBeLessThanOrEqual(r.funnel[i - 1]!.count);
    expect(r.funnel[0]!.count).toBe(r.kpis.newEnquiries);
    expect(r.funnel.at(-1)!.count).toBe(r.kpis.converted);
  });

  it("breaks down by source, service and team member", async () => {
    const r = await report();
    const google = r.bySource.find((s) => s.bucket === "google")!;
    expect(google).toMatchObject({ enquiries: 2, contacted: 2, booked: 2, attended: 1, converted: 1, conversionRate: 0.5 });
    expect(r.bySource.find((s) => s.bucket === "walk_in")).toMatchObject({ enquiries: 1, contacted: 0 });
    expect(r.bySource.reduce((s, x) => s + x.enquiries, 0)).toBe(3);
    expect(r.byService).toEqual([{ service: "Cataract", enquiries: 3, booked: 2, attended: 1, converted: 1 }]);
    const coordinator = r.byOwner.find((o) => o.userId === t.userIds.PATIENT_COORDINATOR)!;
    expect(coordinator).toMatchObject({ followUpsDue: 1, followUpsOverdue: 1, followUpsCompleted: 1 });
  });

  it("filters apply on the server: source, doctor, owner, branch", async () => {
    const opts = (await get(t, "HOSPITAL_ADMIN", "/reports/filter-options")).json() as ReportFilterOptions;
    const googleId = r0(opts.sources.find((s) => s.label.toLowerCase().includes("google"))?.id);
    const bySource = await report(`${range}&sourceId=${googleId}`);
    expect(bySource.kpis.newEnquiries).toBe(2);
    expect(bySource.bySource.every((s) => s.sourceId === googleId)).toBe(true);

    const [stranger] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.tenantId, other.tenantId)).limit(1);
    const byOtherDoctor = await report(`${range}&doctorId=${stranger!.id}`);
    expect(byOtherDoctor.kpis.appointmentsScheduled).toBe(0);
    expect((await report(`${range}&doctorId=${ids.doctor}`)).kpis.appointmentsScheduled).toBe(2);

    const byOwner = await report(`${range}&ownerId=${t.userIds.PATIENT_COORDINATOR}`);
    expect(byOwner.kpis.followUpsDue).toBe(1);
    expect(byOwner.kpis.newEnquiries).toBe(0); // no journey is owned by the coordinator

    expect(opts.doctors.map((d) => d.id)).toContain(ids.doctor);
    expect(opts.services).toContain("Cataract");
  });
  const r0 = (v: string | undefined) => { expect(v).toBeTruthy(); return v!; };

  it("presets work and malformed queries are a 400, never a 500", async () => {
    for (const p of ["today", "yesterday", "7d", "30d", "this_month", "last_month"]) expect((await get(t, "HOSPITAL_ADMIN", `/reports/operations?range=${p}`)).statusCode).toBe(200);
    expect((await report("range=30d")).kpis.newEnquiries).toBe(4); // j4 is 10 days old: inside 30 days, outside the custom range
    for (const q of ["range=custom", "range=forever", `range=custom&from=${D2}&to=${D1}`, `range=custom&from=${D1}&to=${addDays(today, 2)}`, "branchId=not-a-uuid", "sourceId=1"]) {
      expect((await get(t, "HOSPITAL_ADMIN", `/reports/operations?${q}`)).statusCode, q).toBe(400);
    }
  });

  it("only the hospital-management roles may read it or export; signed out is a 401", async () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) {
      expect((await get(t, role, `/reports/operations?${range}`)).statusCode, role).toBe(403);
      expect((await get(t, role, `/reports/export?kind=enquiries&${range}`)).statusCode, role).toBe(403);
      expect((await get(t, role, "/reports/filter-options")).statusCode, role).toBe(403);
    }
    expect((await get(t, "SUPER_ADMIN", `/reports/operations?${range}`)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/reports/operations?${range}` })).statusCode).toBe(401);
  });

  it("is tenant-isolated: another hospital sees none of this, even when it passes this hospital's ids or a tenantId", async () => {
    const opts = (await get(t, "HOSPITAL_ADMIN", "/reports/filter-options")).json() as ReportFilterOptions;
    const theirs = await report(`${range}&tenantId=${t.tenantId}`, other);
    expect(theirs.kpis.newEnquiries).toBe(0);
    const withOurSource = await report(`${range}&sourceId=${opts.sources[0]!.id}&doctorId=${ids.doctor}`, other);
    expect(withOurSource.kpis).toMatchObject({ newEnquiries: 0, appointmentsScheduled: 0, followUpsDue: 0 });
    const theirOpts = (await get(other, "HOSPITAL_ADMIN", "/reports/filter-options")).json() as ReportFilterOptions;
    expect(theirOpts.doctors.map((d) => d.id)).not.toContain(ids.doctor);
    const xlsx = await get(other, "HOSPITAL_ADMIN", `/reports/export?kind=enquiries&${range}&tenantId=${t.tenantId}`);
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.toString("latin1")).not.toContain("Report Converted");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Enquiries")!.rowCount).toBe(1); // header only
  });

  async function workbook(kind: string, q = range) {
    const res = await get(t, "HOSPITAL_ADMIN", `/reports/export?kind=${kind}&${q}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["access-control-expose-headers"]).toBe("Content-Disposition"); // the browser may read the filename
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer); // a real OOXML workbook, not a renamed CSV
    return { wb, disposition: String(res.headers["content-disposition"]) };
  }
  const rows = (ws: ExcelJS.Worksheet) => {
    const out: string[][] = [];
    ws.eachRow((row) => out.push((row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? "" : String(v)))));
    return out;
  };

  it("exports the enquiries of the period with readable headers and hospital-time dates", async () => {
    const { wb, disposition } = await workbook("enquiries");
    expect(disposition).toMatch(new RegExp(`attachment; filename="pulseos-enquiries-.*-${D1}_to_${D2}\\.xlsx"`));
    const ws = wb.getWorksheet("Enquiries")!;
    const [header, ...body] = rows(ws);
    expect(header).toEqual(["Created", "Patient", "Phone", "Service", "Source", "Branch", "Team Member", "Stage", "Latest outcome", "Contacted", "Appointment booked", "Attended", "Converted"]);
    expect(body.map((r) => r[1]).sort()).toEqual(["Report Converted", "Report Midnight", "Report NoAnswer"]);
    const midnight = body.find((r) => r[1] === "Report Midnight")!;
    expect(midnight[0]).toMatch(/00:15/); // hospital time, not 18:45 UTC
    const about = rows(wb.getWorksheet("About")!);
    expect(about.find((r) => r[0] === "Timezone")?.[1]).toBe(IST);
    expect(about.find((r) => r[0] === "Filters")?.[1]).toMatch(/None/);
  });

  it("the summary workbook equals the on-screen report, and exports inherit the filters", async () => {
    const r = await report();
    const { wb } = await workbook("summary");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Day by day", "Funnel", "By source", "By service", "By team member", "About"]);
    const summary = Object.fromEntries(rows(wb.getWorksheet("Summary")!).slice(1).map((x) => [x[0], x[1]]));
    expect(Number(summary["New enquiries"])).toBe(r.kpis.newEnquiries);
    expect(Number(summary["Appointments attended"])).toBe(r.kpis.appointmentsAttended);
    expect(rows(wb.getWorksheet("Day by day")!).length - 1).toBe(r.daily.length);

    const appts = rows((await workbook("appointments", `${range}&doctorId=${ids.doctor}`)).wb.getWorksheet("Appointments")!);
    expect(appts.slice(1).map((x) => x[7]).sort()).toEqual(["Completed", "No-show"]);
    const fu = rows((await workbook("follow-ups")).wb.getWorksheet("Follow-ups")!);
    expect(fu.length - 1).toBe(2); // due in period + completed in period; the future one is not in it
    const filtered = rows((await workbook("enquiries", `${range}&sourceId=${(await report()).bySource.find((s) => s.bucket === "walk_in")!.sourceId}`)).wb.getWorksheet("Enquiries")!);
    expect(filtered.slice(1).map((x) => x[1])).toEqual(["Report Midnight"]);
  });

  it("refuses an unknown export kind and a bad period", async () => {
    expect((await get(t, "HOSPITAL_ADMIN", `/reports/export?kind=patients&${range}`)).statusCode).toBe(400);
    expect((await get(t, "HOSPITAL_ADMIN", "/reports/export?kind=summary&range=custom")).statusCode).toBe(400);
  });

  it("analytics pipeline: Enquiry → Appointment → Checked in → Consultation completed → Surgery scheduled, never widening", async () => {
    const r = await report();
    expect(r.pipeline.map((s) => [s.key, s.count])).toEqual([["enquiry", 3], ["booked", 2], ["checked_in", 1], ["consulted", 1], ["procedure", 1]]);
    for (let i = 1; i < r.pipeline.length; i++) expect(r.pipeline[i]!.count).toBeLessThanOrEqual(r.pipeline[i - 1]!.count);
    expect(r.pipeline[0]!.count).toBe(r.kpis.newEnquiries);
  });

  it("every day-by-day column sums to its KPI (one filter state, one set of rows)", async () => {
    for (const q of [range, `${range}&service=Cataract`, `range=custom&from=${D2}&to=${D2}`]) {
      const r = await report(q);
      const sum = (k: "enquiries" | "appointmentsScheduled" | "attended" | "consultationsCompleted" | "noShow" | "followUpsDue" | "followUpsCompleted") => r.daily.reduce((a, d) => a + d[k], 0);
      expect(sum("enquiries"), q).toBe(r.kpis.newEnquiries);
      expect(sum("appointmentsScheduled"), q).toBe(r.kpis.appointmentsScheduled);
      expect(sum("attended"), q).toBe(r.kpis.appointmentsAttended);
      expect(sum("consultationsCompleted"), q).toBe(r.kpis.consultationsCompleted);
      expect(sum("noShow"), q).toBe(r.kpis.appointmentsNoShow);
      expect(sum("followUpsDue"), q).toBe(r.kpis.followUpsDue);
      expect(sum("followUpsCompleted"), q).toBe(r.kpis.followUpsCompleted);
    }
  });

  it("department filter narrows enquiries, visits, follow-ups and procedures together; options list this hospital's departments only", async () => {
    const [dept] = await db.insert(departments).values({ tenantId: t.tenantId, key: "eye_test", displayName: "Eye Care" } as never).returning({ id: departments.id });
    const [foreign] = await db.insert(departments).values({ tenantId: other.tenantId, key: "eye_other", displayName: "Foreign Dept" } as never).returning({ id: departments.id });
    await db.update(journeys).set({ departmentId: dept!.id }).where(eq(journeys.id, ids.j1!));
    try {
      const r = await report(`${range}&departmentId=${dept!.id}`);
      expect(r.kpis).toMatchObject({ newEnquiries: 1, appointmentsScheduled: 1, consultationsCompleted: 1, proceduresScheduled: 1, followUpsCompleted: 1, appointmentsNoShow: 0, followUpsDue: 0 });
      expect(r.byService.map((x) => x.service)).toEqual(["Cataract"]);
      // Another hospital's department id matches nothing here — it never reveals or leaks rows.
      const leak = await report(`${range}&departmentId=${foreign!.id}`);
      expect(leak.kpis.newEnquiries).toBe(0);
      const opts = (await get(t, "HOSPITAL_ADMIN", "/reports/filter-options")).json() as ReportFilterOptions;
      expect(opts.departments).toEqual([{ id: dept!.id, name: "Eye Care" }]);
      expect((await get(t, "HOSPITAL_ADMIN", `/reports/operations?${range}&departmentId=not-a-uuid`)).statusCode).toBe(400);
    } finally {
      await db.update(journeys).set({ departmentId: null }).where(eq(journeys.id, ids.j1!));
      await db.delete(departments).where(eq(departments.tenantId, other.tenantId));
      await db.delete(departments).where(eq(departments.tenantId, t.tenantId));
    }
  });

  it("analytics data is for hospital management: Front Desk and Coordinator are refused, edition does not matter", async () => {
    expect((await get(t, "FRONT_DESK", `/reports/operations?${range}`)).statusCode).toBe(403);
    expect((await get(t, "PATIENT_COORDINATOR", `/reports/operations?${range}`)).statusCode).toBe(403);
    expect((await get(t, "DOCTOR", `/reports/filter-options`)).statusCode).toBe(403);
    expect((await get(t, "HOSPITAL_ADMIN", `/reports/operations?${range}`)).statusCode).toBe(200); // BETA_V1_CORE
  });
});
