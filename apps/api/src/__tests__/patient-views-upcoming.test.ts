import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { tasks, treatmentOpportunities } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { CreateLeadResult, Lookups, PatientUpcoming, SessionUser, TaskRow } from "@pulseos/types";

// Patient 360 "Upcoming": a read-only projection of data that already exists
// for ONE patient (future appointments, open tasks, scheduled treatments),
// across every journey the patient has (Patient != Journey), time-ordered,
// tenant-scoped from the session and permission-trimmed per item kind.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("GET /patients/:id/upcoming (integration)", () => {
  let app: FastifyInstance;
  let admin: string;
  let doctor: string;
  let frontDesk: string;
  let otherTenantAdmin: string;
  let patientId: string;
  let journeyA: string;
  let journeyB: string;
  let doctorId: string;
  let adminId: string;
  const ids: Record<string, string> = {};

  const get = (cookie: string, id = patientId) => app.inject({ method: "GET", url: `/patients/${id}/upcoming`, cookies: { pulseos_session: cookie } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await loginAs(app, "gyn.admin@pulseos.local");
    doctor = await loginAs(app, "gyn.doctor@pulseos.local");
    frontDesk = await loginAs(app, "gyn.frontdesk@pulseos.local");
    otherTenantAdmin = await loginAs(app, "eye.admin@pulseos.local");
    const cookies = { pulseos_session: admin };

    const lookups = (await app.inject({ method: "GET", url: "/lookups", cookies })).json() as Lookups;
    const branchId = lookups.branches[0].id;
    doctorId = (await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: doctor } })).json<{ user: SessionUser }>().user.id;
    adminId = (await app.inject({ method: "GET", url: "/auth/session", cookies })).json<{ user: SessionUser }>().user.id;

    // Two journeys for the same patient: same phone resolves to one identity.
    const phone = `98${String(Date.now()).slice(-8)}`;
    const a = (await app.inject({ method: "POST", url: "/leads", cookies, payload: { name: "Upcoming Test Patient", phone, specialtyKey: "GYNECOLOGY", branchId, source: "website", journeyType: "Gynecology Consultation" } })).json() as CreateLeadResult;
    const b = (await app.inject({ method: "POST", url: "/leads", cookies, payload: { name: "Upcoming Test Patient", phone, specialtyKey: "GYNECOLOGY", branchId, source: "phone", journeyType: "Pregnancy Care" } })).json() as CreateLeadResult;
    expect(a.patientId).toBe(b.patientId);
    patientId = a.patientId;
    journeyA = a.journeyId;
    journeyB = b.journeyId;

    const now = Date.now();
    const appt = async (journeyId: string, at: number) =>
      (await app.inject({ method: "POST", url: "/appointments", cookies, payload: { patientId, journeyId, branchId, doctorId, scheduledAt: new Date(at).toISOString() } })).json<{ id: string }>().id;
    const task = async (journeyId: string | undefined, at: number, assignedTo?: string) =>
      (await app.inject({ method: "POST", url: "/tasks", cookies, payload: { patientId, journeyId, type: "CALLBACK", dueAt: new Date(at).toISOString(), assignedTo } })).json<TaskRow>().id;

    ids.futureAppt = await appt(journeyA, now + 3 * DAY);
    ids.pastAppt = await appt(journeyA, now - 3 * DAY);
    ids.cancelledAppt = await appt(journeyB, now + 4 * DAY);
    await app.inject({ method: "PATCH", url: `/appointments/${ids.cancelledAppt}/action`, cookies, payload: { action: "cancel", reasonCode: "patient_requested" } });

    ids.taskB = await task(journeyB, now + 1 * DAY, adminId);
    ids.overdueTask = await task(journeyA, now - 2 * DAY, adminId);
    ids.doctorTask = await task(journeyB, now + 2 * DAY, doctorId);
    ids.doneTask = await task(journeyA, now + 5 * DAY, adminId);
    await app.inject({ method: "PATCH", url: `/tasks/${ids.doneTask}/complete`, cookies });

    const [tenantRow] = await db.select({ tenantId: tasks.tenantId }).from(tasks).where(eq(tasks.id, ids.taskB));
    const [treatment] = await db
      .insert(treatmentOpportunities)
      .values({ tenantId: tenantRow.tenantId, patientId, journeyId: journeyB, treatmentLabel: "Upcoming Test Procedure", status: "SCHEDULED", plannedDate: new Date(now + 6 * DAY) })
      .returning({ id: treatmentOpportunities.id });
    ids.treatment = treatment.id;
    const [advised] = await db
      .insert(treatmentOpportunities)
      .values({ tenantId: tenantRow.tenantId, patientId, journeyId: journeyA, treatmentLabel: "Only Advised", status: "ADVISED", plannedDate: new Date(now + 7 * DAY) })
      .returning({ id: treatmentOpportunities.id });
    ids.advised = advised.id;
  });

  afterAll(async () => {
    // The fixture patient (two journeys, an appointment, tasks, treatments) is removed with
    // everything attached, so repeated runs never accumulate rows in the demo tenant.
    if (patientId) {
      for (const table of ["revenue_events", "conversion_feedback_events", "treatment_opportunities", "consultation_outcomes", "campaign_touchpoints", "timeline_events", "tasks", "appointments", "journeys"]) {
        await db.execute(sql`delete from ${sql.identifier(table)} where patient_id = ${patientId}`);
      }
      await db.execute(sql`delete from patients where id = ${patientId}`);
    }
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: `/patients/${patientId}/upcoming` });
    expect(res.statusCode).toBe(401);
  });

  it("lists future appointments, open tasks and scheduled treatments across both journeys, time-ordered, in the hospital timezone", async () => {
    const res = await get(admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as PatientUpcoming;
    expect(body.timezone).toBe("Asia/Kolkata");
    const got = body.items.map((i) => i.id);
    for (const key of ["futureAppt", "taskB", "overdueTask", "doctorTask", "treatment"]) expect(got).toContain(ids[key]);
    for (const key of ["pastAppt", "cancelledAppt", "doneTask", "advised"]) expect(got).not.toContain(ids[key]);

    const times = body.items.map((i) => new Date(i.at).getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));

    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(ids.futureAppt)).toMatchObject({ kind: "appointment", journeyId: journeyA, journeyType: "Gynecology Consultation", overdue: false });
    expect(byId.get(ids.taskB)).toMatchObject({ kind: "task", journeyId: journeyB, journeyType: "Pregnancy Care", label: "CALLBACK", overdue: false });
    expect(byId.get(ids.overdueTask)).toMatchObject({ kind: "task", overdue: true });
    expect(byId.get(ids.treatment)).toMatchObject({ kind: "treatment", journeyId: journeyB, label: "Upcoming Test Procedure", status: "SCHEDULED" });
  });

  it("never leaks across tenants: another tenant's admin gets 404", async () => {
    const res = await get(otherTenantAdmin);
    expect(res.statusCode).toBe(404);
  });

  it("keeps task permissions: a VIEW_TASKS-only Doctor sees only their own tasks", async () => {
    const res = await get(doctor);
    expect(res.statusCode).toBe(200);
    const items = (res.json() as PatientUpcoming).items;
    const taskIds = items.filter((i) => i.kind === "task").map((i) => i.id);
    expect(taskIds).toEqual([ids.doctorTask]);
    expect(items.map((i) => i.id)).toContain(ids.futureAppt);
  });

  it("keeps treatment permissions: Front Desk (no VIEW_TREATMENT) gets no treatment items", async () => {
    const res = await get(frontDesk);
    expect(res.statusCode).toBe(200);
    const items = (res.json() as PatientUpcoming).items;
    expect(items.some((i) => i.kind === "treatment")).toBe(false);
    expect(items.map((i) => i.id)).toContain(ids.taskB);
  });
});
