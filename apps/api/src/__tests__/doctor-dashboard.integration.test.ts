import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DoctorDashboard, TreatmentDefinitionVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { appointments, consultationOutcomes, journeys, tenants, timelineEvents, treatmentOpportunities, users } from "../db/schema.js";

// Integration test: requires a migrated + seeded DB (both demo tenants) and DEMO_PASSWORD.
// Doctor Home records outcomes from the dashboard's own rows, so each row must carry what the
// screen needs to (a) offer the right slice of the treatment catalog and (b) open Patient 360.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("doctor dashboard read model (integration)", () => {
  let app: FastifyInstance;
  let doctorCookie: string;
  let eyeTenantId: string;
  const createdAppointmentIds: string[] = [];
  const originalStage = new Map<string, (typeof journeys.$inferSelect)["stage"]>();

  async function loginAs(email: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
    expect(res.statusCode, `login as ${email}`).toBe(200);
    return res.cookies.find((c) => c.name === "pulseos_session")!.value;
  }
  const dashboard = async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/doctor", cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as DoctorDashboard;
  };

  async function freshLaserAppointment(status: "completed" | "scheduled") {
    const [doctor] = await db.select().from(users).where(eq(users.email, "eye.doctor@pulseos.local"));
    const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, eyeTenantId), eq(journeys.specialtyKey, "LASER_VISION_CORRECTION"))).limit(1);
    originalStage.set(journey.id, journey.stage);
    const [appt] = await db
      .insert(appointments)
      .values({ tenantId: eyeTenantId, patientId: journey.patientId, journeyId: journey.id, branchId: doctor.branchId!, doctorUserId: doctor.id, status, scheduledAt: new Date(), reason: "Dashboard read-model test" })
      .returning();
    createdAppointmentIds.push(appt.id);
    return { appointmentId: appt.id, journeyId: journey.id, patientId: journey.patientId };
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    doctorCookie = await loginAs("eye.doctor@pulseos.local");
    [{ id: eyeTenantId }] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Ophthalmology Demo"));
  });

  afterAll(async () => {
    if (createdAppointmentIds.length > 0) {
      const outcomes = await db.select({ id: consultationOutcomes.id }).from(consultationOutcomes).where(inArray(consultationOutcomes.appointmentId, createdAppointmentIds));
      const outcomeIds = outcomes.map((o) => o.id);
      if (outcomeIds.length > 0) {
        const treatments = await db.select({ id: treatmentOpportunities.id }).from(treatmentOpportunities).where(inArray(treatmentOpportunities.consultationOutcomeId, outcomeIds));
        const treatmentIds = treatments.map((t) => t.id);
        if (treatmentIds.length > 0) {
          await db.delete(timelineEvents).where(inArray(timelineEvents.relatedEntityId, treatmentIds));
          await db.delete(treatmentOpportunities).where(inArray(treatmentOpportunities.id, treatmentIds));
        }
        await db.delete(timelineEvents).where(inArray(timelineEvents.relatedEntityId, outcomeIds));
        await db.delete(consultationOutcomes).where(inArray(consultationOutcomes.id, outcomeIds));
      }
      await db.delete(appointments).where(inArray(appointments.id, createdAppointmentIds));
    }
    for (const [id, stage] of originalStage) await db.update(journeys).set({ stage }).where(eq(journeys.id, id));
    await app.close();
  });

  it("awaiting-outcome rows carry the journey specialty, service, patient and journey ids", async () => {
    const { appointmentId, journeyId, patientId } = await freshLaserAppointment("completed");
    const row = (await dashboard()).awaitingOutcome.find((r) => r.appointmentId === appointmentId);
    expect(row).toMatchObject({ specialtyKey: "LASER_VISION_CORRECTION", journeyType: "Laser Vision Correction", journeyId, patientId });
  });

  it("the specialty key on an awaiting row is enough to narrow the tenant catalog to that service's procedures", async () => {
    const { appointmentId } = await freshLaserAppointment("completed");
    const row = (await dashboard()).awaitingOutcome.find((r) => r.appointmentId === appointmentId)!;
    const catalog = await app.inject({ method: "GET", url: "/treatment-catalog", cookies: { pulseos_session: doctorCookie } });
    const forRow = (catalog.json() as TreatmentDefinitionVm[]).filter((d) => d.specialtyKey === row.specialtyKey).map((d) => d.label);
    expect(forRow).toEqual(["LASIK", "SMILE", "PRK"]);
  });

  it("every queue row (today, follow-ups, post-care) exposes patientId and journeyId for Patient 360 / Journey links", async () => {
    await freshLaserAppointment("scheduled");
    const d = await dashboard();
    expect(d.today.length).toBeGreaterThan(0);
    for (const r of [...d.today, ...d.awaitingOutcome, ...d.treatmentFollowUps, ...d.postCare]) {
      expect(r.patientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.journeyId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof r.journeyType).toBe("string");
    }
  });

  it("nextPatient exposes patientId and journeyId", async () => {
    await freshLaserAppointment("scheduled");
    const { nextPatient } = await dashboard();
    expect(nextPatient).not.toBeNull();
    expect(nextPatient!.patientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(nextPatient!.journeyId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("recent patients carry patientId so each can open Patient 360", async () => {
    const { recentPatients } = await dashboard();
    for (const r of recentPatients) expect(r.patientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a recorded outcome removes the row from awaitingOutcome", async () => {
    const { appointmentId } = await freshLaserAppointment("completed");
    const res = await app.inject({ method: "POST", url: `/appointments/${appointmentId}/outcome`, cookies: { pulseos_session: doctorCookie }, payload: { outcome: "CONSULTED" } });
    expect(res.statusCode).toBe(200);
    expect((await dashboard()).awaitingOutcome.map((r) => r.appointmentId)).not.toContain(appointmentId);
  });
});
