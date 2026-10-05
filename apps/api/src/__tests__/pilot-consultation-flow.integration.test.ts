import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, journeys, tasks, treatmentOpportunities, users } from "../db/schema.js";
import { hashPassword } from "../domain/auth/auth.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The arrival -> consultation -> treatment-outcome path of the Namokar pilot, with its roles: Front Desk checks in, moves to
// waiting and sends to the doctor; the doctor (or authorised staff) completes the consultation; the doctor records ONE simple
// operational outcome that creates or reuses the follow-up / treatment record. No prescriptions, no clinical notes.
describe.skipIf(!DEMO_PASSWORD)("pilot consultation + treatment outcome flow (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let otherDoctorId: string;
  let otherDoctorCookie: string;

  const call = (role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });

  async function journeyWith(status: "with_doctor" | "completed" | "scheduled" | "no_show", opts: { doctorUserId?: string } = {}) {
    const [journey] = await db.insert(journeys).values({ tenantId: t.tenantId, patientId: t.patientId, journeyType: "Cataract", specialtyKey: "CATARACT", source: "walk_in", stage: "attended" }).returning();
    const [appt] = await db
      .insert(appointments)
      .values({ tenantId: t.tenantId, patientId: t.patientId, journeyId: journey!.id, branchId: t.branchId, doctorUserId: opts.doctorUserId ?? t.userIds.DOCTOR!, scheduledAt: new Date(Date.now() - 30 * 60_000), status, checkedInAt: new Date(Date.now() - 50 * 60_000), consultationStartedAt: status === "with_doctor" || status === "completed" ? new Date(Date.now() - 20 * 60_000) : null, completedAt: status === "completed" ? new Date() : null })
      .returning();
    return { journeyId: journey!.id, appointmentId: appt!.id };
  }
  const openTasks = (journeyId: string) => db.select().from(tasks).where(and(eq(tasks.journeyId, journeyId), eq(tasks.status, "pending")));
  const treatmentsOf = (journeyId: string) => db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journeyId));
  const stageOf = async (journeyId: string) => (await db.select({ s: journeys.stage }).from(journeys).where(eq(journeys.id, journeyId)))[0]!.s;
  const outcome = (role: Role, appointmentId: string, body: object) => call(role, "POST", `/appointments/${appointmentId}/outcome`, body);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const email = `doctor-two-${t.tenantId.slice(0, 8)}@edition-test.local`;
    const [d2] = await db.insert(users).values({ tenantId: t.tenantId, branchId: t.branchId, name: "Second Doctor", email, passwordHash: await hashPassword(DEMO_PASSWORD!), role: "DOCTOR" }).returning({ id: users.id });
    otherDoctorId = d2!.id;
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
    otherDoctorCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.id, otherDoctorId)).catch(() => undefined);
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  describe("who may move the visit", () => {
    it("Front Desk completes a consultation; the doctor cannot check anyone in", async () => {
      const a = await journeyWith("with_doctor");
      expect((await call("DOCTOR", "PATCH", `/appointments/${a.appointmentId}/action`, { action: "check_in" })).statusCode).toBe(403);
      const done = await call("FRONT_DESK", "PATCH", `/appointments/${a.appointmentId}/complete`, { next: { kind: "none" } });
      expect(done.statusCode).toBe(200);
      expect((await db.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, a.appointmentId)))[0]!.s).toBe("completed");
    });

    it("the doctor completes THEIR OWN consultation, and only theirs", async () => {
      const mine = await journeyWith("with_doctor");
      const theirs = await journeyWith("with_doctor", { doctorUserId: otherDoctorId });
      const forbidden = await call("DOCTOR", "PATCH", `/appointments/${theirs.appointmentId}/complete`, { next: { kind: "none" } });
      expect(forbidden.statusCode).toBe(403);
      expect((await db.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, theirs.appointmentId)))[0]!.s).toBe("with_doctor");
      const ok = await call("DOCTOR", "PATCH", `/appointments/${mine.appointmentId}/complete`, { next: { kind: "none" } });
      expect(ok.statusCode).toBe(200);
      // The other doctor can complete theirs.
      const ok2 = await app.inject({ method: "PATCH", url: `/appointments/${theirs.appointmentId}/complete`, cookies: { pulseos_session: otherDoctorCookie }, payload: { next: { kind: "none" } } });
      expect(ok2.statusCode).toBe(200);
    });

    it("a doctor may not schedule a surgery while completing (that stays with authorised staff)", async () => {
      const a = await journeyWith("with_doctor");
      const res = await call("DOCTOR", "PATCH", `/appointments/${a.appointmentId}/complete`, { next: { kind: "surgery", surgery: { treatmentDefinitionId: "00000000-0000-4000-8000-000000000000", scheduledAt: "2099-01-01T10:00", resourceId: "00000000-0000-4000-8000-000000000000", branchId: t.branchId } } });
      expect(res.statusCode).toBe(403);
      expect((await db.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, a.appointmentId)))[0]!.s).toBe("with_doctor");
    });

    it("a visit that is not with the doctor cannot be completed", async () => {
      const a = await journeyWith("scheduled");
      expect((await call("FRONT_DESK", "PATCH", `/appointments/${a.appointmentId}/complete`, { next: { kind: "none" } })).statusCode).toBe(409);
    });
  });

  describe("the treatment outcome", () => {
    it("No treatment needed: the consultation is closed with nothing further created", async () => {
      const a = await journeyWith("completed");
      const res = await outcome("DOCTOR", a.appointmentId, { outcome: "NO_TREATMENT_REQUIRED" });
      expect(res.statusCode).toBe(200);
      expect(await openTasks(a.journeyId)).toHaveLength(0);
      expect(await treatmentsOf(a.journeyId)).toHaveLength(0);
      expect(await stageOf(a.journeyId)).toBe("consulted");
    });

    it("Review / follow-up: creates ONE follow-up task, and a second outcome on the journey reuses it", async () => {
      const first = await journeyWith("completed");
      const res = await outcome("DOCTOR", first.appointmentId, { outcome: "FOLLOW_UP_REQUIRED" });
      expect(res.statusCode).toBe(200);
      const created = await openTasks(first.journeyId);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ type: "FOLLOW_UP", status: "pending" });
      expect(created[0]!.followUpTypeId).not.toBeNull();
      expect(res.json().followUpTask.id).toBe(created[0]!.id);

      // A second completed visit on the SAME journey asks for follow-up again: the open one is reused, not duplicated.
      const [again] = await db
        .insert(appointments)
        .values({ tenantId: t.tenantId, patientId: t.patientId, journeyId: first.journeyId, branchId: t.branchId, doctorUserId: t.userIds.DOCTOR!, scheduledAt: new Date(Date.now() - 10 * 60_000), status: "completed", completedAt: new Date() })
        .returning();
      const res2 = await outcome("DOCTOR", again!.id, { outcome: "FOLLOW_UP_REQUIRED" });
      expect(res2.statusCode).toBe(200);
      expect(await openTasks(first.journeyId)).toHaveLength(1);
      expect(res2.json().followUpTask.id).toBe(created[0]!.id);
    });

    it("Surgery / procedure advised: creates a Treatment Opportunity (ADVISED) and moves the stage; a repeat reuses it", async () => {
      const first = await journeyWith("completed");
      const res = await outcome("DOCTOR", first.appointmentId, { outcome: "TREATMENT_ADVISED", treatmentLabel: "Cataract Surgery — Right Eye" });
      expect(res.statusCode).toBe(200);
      const rows = await treatmentsOf(first.journeyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "ADVISED", treatmentLabel: "Cataract Surgery — Right Eye" });
      expect(await stageOf(first.journeyId)).toBe("treatment_advised");

      const [again] = await db
        .insert(appointments)
        .values({ tenantId: t.tenantId, patientId: t.patientId, journeyId: first.journeyId, branchId: t.branchId, doctorUserId: t.userIds.DOCTOR!, scheduledAt: new Date(Date.now() - 5 * 60_000), status: "completed", completedAt: new Date() })
        .returning();
      const res2 = await outcome("DOCTOR", again!.id, { outcome: "TREATMENT_ADVISED", treatmentLabel: "Cataract Surgery — Right Eye" });
      expect(res2.statusCode).toBe(200);
      expect(await treatmentsOf(first.journeyId)).toHaveLength(1);
      expect(res2.json().treatmentOpportunity.id).toBe(rows[0]!.id);
    });

    it("Patient is deciding: records the decision AND creates one treatment-decision follow-up (reused, never doubled)", async () => {
      const a = await journeyWith("completed");
      const res = await outcome("DOCTOR", a.appointmentId, { outcome: "DECISION_PENDING", treatmentLabel: "LASIK" });
      expect(res.statusCode).toBe(200);
      expect((await treatmentsOf(a.journeyId))[0]).toMatchObject({ status: "DECISION_PENDING" });
      const open = await openTasks(a.journeyId);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ type: "TREATMENT_DECISION" });
      expect(res.json().followUpTask.id).toBe(open[0]!.id);
    });

    it("Declined treatment: the open treatment is DECLINED, no follow-up is invented and the journey is not silently lost", async () => {
      const a = await journeyWith("completed");
      await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: t.patientId, journeyId: a.journeyId, treatmentLabel: "Cataract Surgery", status: "ADVISED", estimatedValue: 0 });
      const res = await outcome("DOCTOR", a.appointmentId, { outcome: "TREATMENT_DECLINED", treatmentLabel: "Cataract Surgery" });
      expect(res.statusCode).toBe(200);
      const rows = await treatmentsOf(a.journeyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "DECLINED" });
      expect(await openTasks(a.journeyId)).toHaveLength(0);
      expect(await stageOf(a.journeyId)).toBe("consulted");
    });

    it("Declined with no prior treatment still records the declined procedure so the decision is not lost", async () => {
      const a = await journeyWith("completed");
      const res = await outcome("DOCTOR", a.appointmentId, { outcome: "TREATMENT_DECLINED", treatmentLabel: "LASIK" });
      expect(res.statusCode).toBe(200);
      expect(await treatmentsOf(a.journeyId)).toEqual([expect.objectContaining({ status: "DECLINED", treatmentLabel: "LASIK" })]);
    });

    it("an outcome is recorded once, only for a COMPLETED visit, and only by the doctor the visit is with", async () => {
      const a = await journeyWith("completed");
      expect((await outcome("DOCTOR", a.appointmentId, { outcome: "CONSULTED" })).statusCode).toBe(200);
      expect((await outcome("DOCTOR", a.appointmentId, { outcome: "CONSULTED" })).statusCode).toBe(409);

      const notDone = await journeyWith("with_doctor");
      const early = await outcome("DOCTOR", notDone.appointmentId, { outcome: "CONSULTED" });
      expect(early.statusCode).toBe(409);
      expect(early.json().error).toBe("appointment_not_completed");

      const theirs = await journeyWith("completed", { doctorUserId: otherDoctorId });
      expect((await outcome("DOCTOR", theirs.appointmentId, { outcome: "CONSULTED" })).statusCode).toBe(403);
    });

    it("front desk and coordinators cannot record a clinical outcome", async () => {
      const a = await journeyWith("completed");
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "HOSPITAL_ADMIN"] as Role[]) expect((await outcome(role, a.appointmentId, { outcome: "CONSULTED" })).statusCode, role).toBe(403);
    });

    it("an unknown outcome is refused", async () => {
      const a = await journeyWith("completed");
      expect((await outcome("DOCTOR", a.appointmentId, { outcome: "PRESCRIBED_MEDICATION" })).statusCode).toBe(400);
    });
  });
});
