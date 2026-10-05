import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, branches, journeys, tenants, users } from "../db/schema.js";
import type { FastifyInstance } from "fastify";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded PulseOS dev DB
// and DEMO_PASSWORD matching the seed run. Proves the most important behavior in this
// checkpoint: doctor consultation outcome -> TreatmentOpportunity -> Timeline ->
// Journey stage -> Admin dashboard attribution numbers, end to end.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("doctor outcome -> journey -> dashboard feedback loop (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let doctorCookie: string;
  let testAppointmentId: string;
  let testJourneyId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const adminLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    adminCookie = adminLogin.cookies.find((c) => c.name === "pulseos_session")!.value;

    const doctorLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.doctor@pulseos.local", password: DEMO_PASSWORD } });
    doctorCookie = doctorLogin.cookies.find((c) => c.name === "pulseos_session")!.value;

    // Set up a fresh completed-but-no-outcome-yet appointment on a real seeded journey,
    // so this test doesn't depend on which exact seeded rows already have outcomes.
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, "PulseOS Gynecology Demo")).limit(1);
    const [doctor] = await db.select().from(users).where(eq(users.email, "gyn.doctor@pulseos.local")).limit(1);
    const [branch] = await db.select().from(branches).where(eq(branches.tenantId, tenant.id)).limit(1);
    const [someJourney] = await db.select().from(journeys).where(eq(journeys.tenantId, tenant.id)).limit(1);
    testJourneyId = someJourney.id;

    const [appt] = await db
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        patientId: someJourney.patientId,
        journeyId: someJourney.id,
        branchId: branch.id,
        doctorUserId: doctor.id,
        status: "completed",
        scheduledAt: new Date(),
        reason: "Test consultation",
      })
      .returning();
    testAppointmentId = appt.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an outcome recorded by a non-doctor role", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/appointments/${testAppointmentId}/outcome`,
      cookies: { pulseos_session: adminCookie },
      payload: { outcome: "CONSULTED" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("doctor recording TREATMENT_ADVISED creates a TreatmentOpportunity and advances the journey stage", async () => {
    const before = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: adminCookie } });
    const consultationsBefore = before.json().consultations;

    const res = await app.inject({
      method: "POST",
      url: `/appointments/${testAppointmentId}/outcome`,
      cookies: { pulseos_session: doctorCookie },
      payload: { outcome: "TREATMENT_ADVISED", treatmentLabel: "Test Procedure", estimatedValue: 40000, notes: "Advised after consult" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome.outcome).toBe("TREATMENT_ADVISED");
    expect(body.treatmentOpportunity.status).toBe("ADVISED");
    expect(body.treatmentOpportunity.estimatedValue).toBe(40000);

    const [journey] = await db.select().from(journeys).where(eq(journeys.id, testJourneyId)).limit(1);
    expect(journey.stage).toBe("treatment_advised");

    const after = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: adminCookie } });
    expect(after.json().consultations).toBe(consultationsBefore + 1);
  });

  it("refuses to record a second outcome for the same appointment", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/appointments/${testAppointmentId}/outcome`,
      cookies: { pulseos_session: doctorCookie },
      payload: { outcome: "CONSULTED" },
    });
    expect(res.statusCode).toBe(409);
  });
});
