import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { TreatmentDefinitionVm, TreatmentRow } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { appointments, consultationOutcomes, journeys, tenants, timelineEvents, tasks, treatmentDefinitions, treatmentOpportunities, users } from "../db/schema.js";

// Integration test: requires a migrated + seeded DB (both demo tenants) and DEMO_PASSWORD.
// The treatment catalog is tenant configuration data: every tenant sees only its own
// procedures, and a consultation outcome may reference a catalog entry only from the
// caller's own tenant, and only while it is active.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

const EYE_PROCEDURES = ["Cataract Surgery", "LASIK", "SMILE", "PRK", "Corneal Cross-Linking (CXL)", "Ptosis Correction", "DCR / Tear Duct Procedure", "Squint Surgery"];

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  expect(res.statusCode, `login as ${email}`).toBe(200);
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("treatment catalog (integration)", () => {
  let app: FastifyInstance;
  let eye: { coordinator: string; doctor: string; frontdesk: string };
  let gynCoordinator: string;
  let eyeTenantId: string;
  let gynTenantId: string;
  let eyeCatalog: TreatmentDefinitionVm[];
  let gynCatalog: TreatmentDefinitionVm[];
  const createdAppointmentIds: string[] = [];
  const createdJourneyIds: string[] = [];
  const originalStage = new Map<string, (typeof journeys.$inferSelect)["stage"]>();

  const get = <T>(url: string, cookie: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } }).then((r) => ({ status: r.statusCode, body: r.json() as T }));

  // A fresh completed, outcome-less appointment on a real eye journey, so nothing here depends on
  // which seeded appointments already carry an outcome.
  async function freshEyeAppointment(): Promise<{ appointmentId: string; journeyId: string }> {
    const [doctor] = await db.select().from(users).where(eq(users.email, "eye.doctor@pulseos.local"));
    // Its own journey (on a real eye patient): advising a procedure that is already open on a journey reuses it (by design),
    // so a shared seeded journey would make these cases depend on each other. Removed again in afterAll.
    const [base] = await db.select().from(journeys).where(and(eq(journeys.tenantId, eyeTenantId), eq(journeys.specialtyKey, "LASER_VISION_CORRECTION"))).limit(1);
    const [journey] = await db.insert(journeys).values({ tenantId: eyeTenantId, patientId: base.patientId, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "walk_in", stage: "attended" }).returning();
    createdJourneyIds.push(journey.id);
    const [appt] = await db
      .insert(appointments)
      .values({
        tenantId: eyeTenantId, patientId: journey.patientId, journeyId: journey.id, branchId: doctor.branchId!, doctorUserId: doctor.id,
        status: "completed", scheduledAt: new Date(), reason: "Catalog test consultation",
      })
      .returning();
    createdAppointmentIds.push(appt.id);
    return { appointmentId: appt.id, journeyId: journey.id };
  }

  const recordOutcome = (appointmentId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/appointments/${appointmentId}/outcome`, cookies: { pulseos_session: eye.doctor }, payload });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    eye = {
      coordinator: await loginAs(app, "eye.coordinator@pulseos.local"),
      doctor: await loginAs(app, "eye.doctor@pulseos.local"),
      frontdesk: await loginAs(app, "eye.frontdesk@pulseos.local"),
    };
    gynCoordinator = await loginAs(app, "gyn.coordinator@pulseos.local");
    [{ id: eyeTenantId }] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Ophthalmology Demo"));
    [{ id: gynTenantId }] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Gynecology Demo"));
    eyeCatalog = (await get<TreatmentDefinitionVm[]>("/treatment-catalog", eye.coordinator)).body;
    gynCatalog = (await get<TreatmentDefinitionVm[]>("/treatment-catalog", gynCoordinator)).body;
  });

  afterAll(async () => {
    // Remove what these tests recorded, so seeded content assertions elsewhere stay exact.
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
    if (createdJourneyIds.length > 0) {
      // An outcome may have made its follow-up task (and the Timeline line for it) on the journey: they go first.
      await db.delete(tasks).where(inArray(tasks.journeyId, createdJourneyIds));
      await db.delete(timelineEvents).where(inArray(timelineEvents.journeyId, createdJourneyIds));
      await db.delete(journeys).where(inArray(journeys.id, createdJourneyIds));
    }
    for (const [id, stage] of originalStage) await db.update(journeys).set({ stage }).where(eq(journeys.id, id));
    await app.close();
  });

  describe("GET /treatment-catalog", () => {
    it("requires authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/treatment-catalog" });
      expect(res.statusCode).toBe(401);
    });

    it("every role can read the tenant's active catalog (needed to record an outcome)", async () => {
      for (const cookie of [eye.doctor, eye.frontdesk, eye.coordinator]) {
        const res = await get<TreatmentDefinitionVm[]>("/treatment-catalog", cookie);
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
      }
    });

    it("the Ophthalmology catalog holds the eight procedures, in a stable order, with demo default values", () => {
      expect(eyeCatalog.map((t) => t.label)).toEqual(EYE_PROCEDURES);
      for (const t of eyeCatalog) {
        expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(t.key).toBeTruthy();
        expect(t.specialtyKey).toBeTruthy();
        expect(t.defaultEstimatedValue === null || t.defaultEstimatedValue > 0).toBe(true);
      }
    });

    it("procedures are attached to their specialty and can be filtered by it", async () => {
      expect(eyeCatalog.find((t) => t.key === "CXL")?.specialtyKey).toBe("KERATOCONUS");
      const laser = await get<TreatmentDefinitionVm[]>("/treatment-catalog?specialtyKey=LASER_VISION_CORRECTION", eye.coordinator);
      expect(laser.body.map((t) => t.label)).toEqual(["LASIK", "SMILE", "PRK"]);
      const none = await get<TreatmentDefinitionVm[]>("/treatment-catalog?specialtyKey=GENERAL_EYE_CONSULTATION", eye.coordinator);
      expect(none.body).toEqual([]);
    });

    it("is tenant-isolated: the Gynecology catalog never contains eye procedures and vice versa", async () => {
      expect(gynCatalog.length).toBeGreaterThan(0);
      const gynLabels = gynCatalog.map((t) => t.label);
      expect(gynLabels).toEqual(expect.arrayContaining(["IVF Cycle 1", "IUI Cycle"]));
      expect(gynLabels.filter((l) => EYE_PROCEDURES.includes(l))).toEqual([]);
      const eyeIds = new Set(eyeCatalog.map((t) => t.id));
      expect(gynCatalog.some((t) => eyeIds.has(t.id))).toBe(false);
      expect(eyeCatalog.map((t) => t.label).filter((l) => gynLabels.includes(l))).toEqual([]);
      // A specialty key from the other tenant filters to nothing rather than leaking rows.
      const leak = await get<TreatmentDefinitionVm[]>("/treatment-catalog?specialtyKey=KERATOCONUS", gynCoordinator);
      expect(leak.body).toEqual([]);
    });

    it("hides inactive procedures", async () => {
      const prk = eyeCatalog.find((t) => t.key === "PRK")!;
      await db.update(treatmentDefinitions).set({ isActive: false }).where(eq(treatmentDefinitions.id, prk.id));
      try {
        const res = await get<TreatmentDefinitionVm[]>("/treatment-catalog", eye.coordinator);
        expect(res.body.map((t) => t.key)).not.toContain("PRK");
      } finally {
        await db.update(treatmentDefinitions).set({ isActive: true }).where(eq(treatmentDefinitions.id, prk.id));
      }
    });
  });

  describe("consultation outcome with a catalog treatment", () => {
    it("a valid definition sets the treatment's definition id and label from the catalog, and defaults the value", async () => {
      const { appointmentId, journeyId } = await freshEyeAppointment();
      const prk = eyeCatalog.find((t) => t.key === "PRK")!;
      const res = await recordOutcome(appointmentId, { outcome: "TREATMENT_ADVISED", treatmentDefinitionId: prk.id, treatmentLabel: "ignored free text" });
      expect(res.statusCode).toBe(200);
      const t = res.json().treatmentOpportunity;
      expect(t).toMatchObject({ treatmentLabel: "PRK", treatmentDefinitionId: prk.id, status: "ADVISED", estimatedValue: prk.defaultEstimatedValue });
      expect(t.journeyId).toBe(journeyId);
    });

    it("an explicit estimated value overrides the catalog default", async () => {
      const { appointmentId } = await freshEyeAppointment();
      const lasik = eyeCatalog.find((t) => t.key === "LASIK")!;
      const res = await recordOutcome(appointmentId, { outcome: "DECISION_PENDING", treatmentDefinitionId: lasik.id, estimatedValue: 81_000 });
      expect(res.statusCode).toBe(200);
      expect(res.json().treatmentOpportunity).toMatchObject({ treatmentLabel: "LASIK", estimatedValue: 81_000, status: "DECISION_PENDING" });
    });

    it("free-text-only callers keep working, with no catalog link", async () => {
      const { appointmentId } = await freshEyeAppointment();
      const res = await recordOutcome(appointmentId, { outcome: "TREATMENT_ADVISED", treatmentLabel: "Custom Procedure", estimatedValue: 12_000 });
      expect(res.statusCode).toBe(200);
      expect(res.json().treatmentOpportunity).toMatchObject({ treatmentLabel: "Custom Procedure", treatmentDefinitionId: null });
    });

    it("rejects another tenant's definition with 422 and writes nothing", async () => {
      const { appointmentId } = await freshEyeAppointment();
      const ivf = gynCatalog[0];
      const res = await recordOutcome(appointmentId, { outcome: "TREATMENT_ADVISED", treatmentDefinitionId: ivf.id });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("invalid_treatment_definition");
      const outcomes = await db.select().from(consultationOutcomes).where(eq(consultationOutcomes.appointmentId, appointmentId));
      expect(outcomes).toEqual([]);
    });

    it("rejects an inactive definition with 422", async () => {
      const { appointmentId } = await freshEyeAppointment();
      const ptosis = eyeCatalog.find((t) => t.key === "PTOSIS_CORRECTION")!;
      await db.update(treatmentDefinitions).set({ isActive: false }).where(eq(treatmentDefinitions.id, ptosis.id));
      try {
        const res = await recordOutcome(appointmentId, { outcome: "TREATMENT_ADVISED", treatmentDefinitionId: ptosis.id });
        expect(res.statusCode).toBe(422);
      } finally {
        await db.update(treatmentDefinitions).set({ isActive: true }).where(eq(treatmentDefinitions.id, ptosis.id));
      }
    });

    it("rejects an unknown or malformed definition id", async () => {
      const { appointmentId } = await freshEyeAppointment();
      const unknown = await recordOutcome(appointmentId, { outcome: "TREATMENT_ADVISED", treatmentDefinitionId: "00000000-0000-4000-8000-000000000000" });
      expect(unknown.statusCode).toBe(422);
      const malformed = await recordOutcome(appointmentId, { outcome: "TREATMENT_ADVISED", treatmentDefinitionId: "not-a-uuid" });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe("GET /treatments", () => {
    let rows: TreatmentRow[];

    beforeAll(async () => {
      rows = (await get<TreatmentRow[]>("/treatments", eye.coordinator)).body;
    });

    it("rows carry the service (journey type) and the catalog link, and still carry the journey id", () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.journeyId).toBeTruthy();
        expect(typeof r.service === "string" || r.service === null).toBe(true);
        expect("treatmentDefinitionId" in r).toBe(true);
      }
      const cxl = rows.find((r) => r.treatmentLabel.startsWith("Corneal Cross-Linking"))!;
      expect(cxl.service).toBe("Keratoconus");
      expect(cxl.treatmentDefinitionId).toBe(eyeCatalog.find((t) => t.key === "CXL")!.id);
    });

    it("filters by treatmentDefinitionId", async () => {
      const prk = eyeCatalog.find((t) => t.key === "PRK")!;
      const res = await get<TreatmentRow[]>(`/treatments?treatmentDefinitionId=${prk.id}`, eye.coordinator);
      expect(res.body.length).toBeGreaterThan(0);
      for (const r of res.body) expect(r.treatmentDefinitionId).toBe(prk.id);
    });

    it("filters by service", async () => {
      const res = await get<TreatmentRow[]>("/treatments?service=Squint", eye.coordinator);
      expect(res.body.length).toBeGreaterThan(0);
      for (const r of res.body) expect(r.service).toBe("Squint");
      expect(res.body.length).toBeLessThan(rows.length);
    });

    it("filters by doctorId (the doctor who saw the journey)", async () => {
      const [shalini] = await db.select().from(users).where(eq(users.email, "eye.doctor2@pulseos.local"));
      const res = await get<TreatmentRow[]>(`/treatments?doctorId=${shalini.id}`, eye.coordinator);
      expect(res.body.length).toBeGreaterThan(0);
      for (const r of res.body) expect(r.doctorName).toBe("Dr. Shalini Bhat");
      expect(res.body.length).toBeLessThan(rows.length);
    });

    it("filters by ownerId", async () => {
      const [coordinator] = await db.select().from(users).where(eq(users.email, "eye.coordinator@pulseos.local"));
      const res = await get<TreatmentRow[]>(`/treatments?ownerId=${coordinator.id}`, eye.coordinator);
      expect(res.body.length).toBeGreaterThan(0);
      for (const r of res.body) expect(r.ownerName).toBe(coordinator.name);
    });

    it("combines filters and rejects malformed ids with 400", async () => {
      const bad = await app.inject({ method: "GET", url: "/treatments?doctorId=nope", cookies: { pulseos_session: eye.coordinator } });
      expect(bad.statusCode).toBe(400);
      const none = await get<TreatmentRow[]>("/treatments?service=Squint&status=COMPLETED&treatmentDefinitionId=00000000-0000-4000-8000-000000000000", eye.coordinator);
      expect(none.body).toEqual([]);
    });

    it("another tenant's definition id in the filter never surfaces this tenant's rows or theirs", async () => {
      const res = await get<TreatmentRow[]>(`/treatments?treatmentDefinitionId=${gynCatalog[0].id}`, eye.coordinator);
      expect(res.body).toEqual([]);
    });
  });

  it("catalog rows belong to their own tenant in the database", async () => {
    const rows = await db.select().from(treatmentDefinitions).where(eq(treatmentDefinitions.tenantId, gynTenantId));
    expect(rows.every((r) => !EYE_PROCEDURES.includes(r.label))).toBe(true);
    const eyeRows = await db.select().from(treatmentDefinitions).where(eq(treatmentDefinitions.tenantId, eyeTenantId));
    expect(eyeRows).toHaveLength(EYE_PROCEDURES.length);
  });
});
