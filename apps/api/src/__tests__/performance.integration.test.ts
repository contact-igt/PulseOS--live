import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PerformanceDashboard, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, calls, consultationOutcomes, journeys, patients, tasks, treatmentOpportunities } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The owner's Performance view, counted from rows we create here: a known set of journeys, each at a known step.
describe.skipIf(!DEMO_PASSWORD)("owner performance dashboard (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  const ids: Record<string, string> = {};

  const get = (tt: TestTenant, role: Role, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: tt.cookie[role]! } });
  const perf = async (query = "range=30d") => (await get(t, "SUPER_ADMIN", `/dashboard/performance?${query}`)).json() as PerformanceDashboard;

  async function journey(tenant: TestTenant, name: string, over: Partial<typeof journeys.$inferInsert> = {}) {
    const [p] = await db.insert(patients).values({ tenantId: tenant.tenantId, name, phone: "+91 90000 00000", phoneE164: `+9188${Math.floor(10000000 + Math.random() * 89999999)}` }).returning();
    const [j] = await db.insert(journeys).values({ tenantId: tenant.tenantId, patientId: p!.id, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", stage: "enquiry", ...over }).returning();
    return { patientId: p!.id, journeyId: j!.id, tenant };
  }
  async function visit(x: { patientId: string; journeyId: string; tenant: TestTenant }, status: typeof appointments.$inferInsert.status, over: Partial<typeof appointments.$inferInsert> = {}) {
    const [a] = await db.insert(appointments).values({ tenantId: x.tenant.tenantId, patientId: x.patientId, journeyId: x.journeyId, branchId: x.tenant.branchId, doctorUserId: x.tenant.userIds.DOCTOR!, scheduledAt: new Date(Date.now() - 3_600_000), status, ...over }).returning();
    return a!;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const now = new Date();

    // A - all the way: contacted, booked, attended, consulted (with outcome), procedure scheduled.
    const a = await journey(t, "A Scheduled", { stage: "scheduled", contactedAt: now, ownerUserId: t.userIds.FRONT_DESK });
    const aAppt = await visit(a, "completed", { checkedInAt: now, completedAt: now });
    const [aOutcome] = await db.insert(consultationOutcomes).values({ tenantId: t.tenantId, patientId: a.patientId, journeyId: a.journeyId, appointmentId: aAppt.id, outcome: "TREATMENT_ADVISED", recordedBy: t.userIds.DOCTOR! }).returning();
    await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: a.patientId, journeyId: a.journeyId, consultationOutcomeId: aOutcome!.id, treatmentLabel: "Cataract Surgery", status: "SCHEDULED", estimatedValue: 0 });
    // B - contacted only.
    await journey(t, "B Contacted", { stage: "contacted", contactedAt: now, ownerUserId: t.userIds.FRONT_DESK });
    // C - nobody has contacted this enquiry.
    await journey(t, "C Uncontacted", { source: "meta" });
    // D - booked, did not come.
    const d = await journey(t, "D No-show", { stage: "booked", contactedAt: now, source: "meta", ownerUserId: t.userIds.PATIENT_COORDINATOR });
    await visit(d, "no_show");
    // E - closed as lost.
    await journey(t, "E Lost", { stage: "lost" });
    // F - consultation completed, no outcome recorded; a walk-in who was never phoned.
    const f = await journey(t, "F No outcome", { stage: "consulted", source: "walk_in", journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY" });
    await visit(f, "completed", { checkedInAt: now, completedAt: now });
    // G - seen, advised, and the patient is still deciding after over a week.
    const g = await journey(t, "G Undecided", { stage: "treatment_advised", contactedAt: now });
    const gAppt = await visit(g, "completed", { checkedInAt: now, completedAt: now });
    await db.insert(consultationOutcomes).values({ tenantId: t.tenantId, patientId: g.patientId, journeyId: g.journeyId, appointmentId: gAppt.id, outcome: "DECISION_PENDING", recordedBy: t.userIds.DOCTOR! });
    await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: g.patientId, journeyId: g.journeyId, treatmentLabel: "LASIK", status: "DECISION_PENDING", estimatedValue: 0, createdAt: new Date(Date.now() - 9 * 86_400_000) });
    // H - the whole way: seen, advised, and the procedure is DONE (not merely scheduled).
    const h = await journey(t, "H Done", { stage: "completed", contactedAt: now, ownerUserId: null });
    const hAppt = await visit(h, "completed", { checkedInAt: now, completedAt: now });
    const [hOutcome] = await db.insert(consultationOutcomes).values({ tenantId: t.tenantId, patientId: h.patientId, journeyId: h.journeyId, appointmentId: hAppt.id, outcome: "TREATMENT_ADVISED", recordedBy: t.userIds.DOCTOR! }).returning();
    await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: h.patientId, journeyId: h.journeyId, consultationOutcomeId: hOutcome!.id, treatmentLabel: "Cataract Surgery", status: "COMPLETED", estimatedValue: 0 });
    // I - the phone call was ANSWERED but the patient never came: a connected call is not a visit.
    const i = await journey(t, "I Call only", { stage: "contacted", contactedAt: now });
    await db.insert(calls).values({ tenantId: t.tenantId, origin: "MANUAL", patientId: i.patientId, journeyId: i.journeyId, phone: "+91 90000 00000", direction: "inbound", status: "completed", durationSeconds: 90, loggedByUserId: t.userIds.FRONT_DESK!, startedAt: now, endedAt: now });
    // An overdue follow-up for the coordinator, and a call logged by the front desk.
    await db.insert(tasks).values({ tenantId: t.tenantId, patientId: d.patientId, journeyId: d.journeyId, assignedTo: t.userIds.PATIENT_COORDINATOR!, type: "FOLLOW_UP", status: "pending", reason: "manual_task", dueAt: new Date(Date.now() - 86_400_000) });
    await db.insert(calls).values({ tenantId: t.tenantId, origin: "MANUAL", patientId: a.patientId, journeyId: a.journeyId, phone: "+91 90000 00000", direction: "outbound", status: "completed", durationSeconds: 60, loggedByUserId: t.userIds.FRONT_DESK!, startedAt: now, endedAt: now });
    ids.aJourney = a.journeyId;

    // Another hospital's data must never appear.
    const o = await journey(other, "Other Hospital", { contactedAt: now });
    await visit(o, "completed", { checkedInAt: now });
  });
  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("counts the funnel from the journeys opened in the period, each at the furthest step it reached", async () => {
    const p = await perf();
    expect(p.funnel.map((s) => [s.key, s.count])).toEqual([
      ["enquiries", 9], ["booked", 5], ["attended", 4], ["consulted", 4], ["advised", 3], ["scheduled", 2], ["done", 1],
    ]);
    // No "Contacted" stage anywhere in the funnel.
    expect(p.funnel.some((s) => /contact/i.test(s.key) || /contact/i.test(s.label))).toBe(false);
    expect(p.kpis).toMatchObject({ enquiries: 9, noShows: 1, advised: 3, scheduled: 2, done: 1, attendanceRate: 80, consultationCompletionRate: 100, conversionRate: 11 });
  });

  it("a SCHEDULED procedure is never counted as done, and an answered call is never counted as a visit", async () => {
    const p = await perf();
    const by = Object.fromEntries(p.funnel.map((s) => [s.key, s.count]));
    expect(by.scheduled).toBeGreaterThan(by.done!); // A is only scheduled
    expect(by.done).toBe(1); // only H, whose treatment is COMPLETED
    expect(by.attended).toBe(4); // journey I had a connected call but never arrived: not a visit
  });

  it("states rule-based findings in plain words, each with where to act", async () => {
    const p = await perf();
    const by = Object.fromEntries(p.insights.map((i) => [i.key, i]));
    expect(by.uncontacted).toMatchObject({ count: 1, message: "1 enquiry has not yet been contacted" });
    expect(by.no_shows).toMatchObject({ count: 1 });
    expect(by.no_outcome).toMatchObject({ count: 1, message: "1 completed consultation has no outcome recorded" });
    expect(by.undecided).toMatchObject({ count: 1 });
    expect(by.overdue_followups).toMatchObject({ count: 1 });
    expect(by.lost).toMatchObject({ count: 1 });
    for (const i of p.insights) expect(i.href).toMatch(/^\//);
  });

  it("breaks it down by original source, by service and by team member", async () => {
    const p = await perf();
    expect(p.sources.find((s) => s.label === "Google")).toMatchObject({ enquiries: 6, scheduled: 2, done: 1 });
    expect(p.sources.find((s) => s.label === "Walk-in")).toMatchObject({ enquiries: 1, attended: 1, consulted: 1 });
    expect(p.services.map((s) => [s.label, s.enquiries])).toEqual([["Cataract", 8], ["Oculoplasty", 1]]);
    const fd = p.staff.find((s) => s.userId === t.userIds.FRONT_DESK)!;
    expect(fd).toMatchObject({ owned: 2, contacted: 2, callsLogged: 2 });
    const co = p.staff.find((s) => s.userId === t.userIds.PATIENT_COORDINATOR)!;
    expect(co).toMatchObject({ owned: 1, booked: 1, overdueNow: 1 });
  });

  it("carries no revenue figure of any kind and never calls its alert AI", async () => {
    const body = JSON.stringify(await perf());
    expect(body).not.toMatch(/revenue|roas|spend|\"amount\"/i);
    const p = await perf();
    if (p.alert) expect(p.alert.label).toBe("Rule-based alert");
  });

  it("follows the shared filters: service, and an empty window", async () => {
    const onlyOculo = await perf("range=30d&journeyType=Oculoplasty");
    expect(onlyOculo.funnel[0]!.count).toBe(1);
    const nothing = await perf("range=custom&from=2020-01-01&to=2020-01-31");
    expect(nothing.funnel.every((s) => s.count === 0)).toBe(true);
    expect(nothing.insights.some((i) => i.key === "uncontacted")).toBe(false);
  });

  it("is for owners and admins only, and shows only this hospital", async () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await get(t, role, "/dashboard/performance?range=30d")).statusCode, role).toBe(403);
    expect((await get(t, "HOSPITAL_ADMIN", "/dashboard/performance?range=30d")).statusCode).toBe(200);
    expect((await get(t, "SUPER_ADMIN", "/dashboard/performance")).statusCode).toBe(200); // no period = all time
    const theirs = (await get(other, "SUPER_ADMIN", "/dashboard/performance?range=30d")).json() as PerformanceDashboard;
    expect(theirs.funnel[0]!.count).toBe(1);
    expect((await app.inject({ method: "GET", url: "/dashboard/performance?range=30d" })).statusCode).toBe(401);
  });

  it("rejects a malformed period", async () => {
    expect((await get(t, "SUPER_ADMIN", "/dashboard/performance?range=forever")).statusCode).toBe(400);
  });

  it("keeps the same answer when asked twice (no hidden state)", async () => {
    expect(await perf()).toEqual(await perf());
  });
});
