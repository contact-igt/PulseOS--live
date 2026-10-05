import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { journeys, patients, tasks, timelineEvents, treatmentOpportunities } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { TreatmentRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("treatments (integration)", () => {
  let app: FastifyInstance;
  let coordinatorCookie: string;
  let frontDeskCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
    frontDeskCookie = await loginAs(app, "gyn.frontdesk@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/treatments" });
    expect(res.statusCode).toBe(401);
  });

  it("front desk (no VIEW_TREATMENT) cannot view treatments", async () => {
    const res = await app.inject({ method: "GET", url: "/treatments", cookies: { pulseos_session: frontDeskCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("VIEW_TREATMENT");
  });

  it("coordinator sees the working queue with the full dense-table field set", async () => {
    const res = await app.inject({ method: "GET", url: "/treatments", cookies: { pulseos_session: coordinatorCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as TreatmentRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.patientName).toBeTruthy();
      expect(row.treatmentLabel).toBeTruthy();
      expect(typeof row.estimatedValue).toBe("number");
      expect(row.nextActionDueAt === null || typeof row.nextActionDueAt === "string").toBe(true);
      expect(row.lastContactAt === null || typeof row.lastContactAt === "string").toBe(true);
    }
  });

  it("filters by status", async () => {
    const res = await app.inject({ method: "GET", url: "/treatments?status=ADVISED", cookies: { pulseos_session: coordinatorCookie } });
    const rows = res.json() as TreatmentRow[];
    for (const row of rows) expect(row.status).toBe("ADVISED");
  });

  it("full lifecycle on one treatment: valid transition, rejected invalid transition, then acceptance creates a follow-up task and writes Timeline events", async () => {
    // Own fixture, not a seeded ADVISED treatment: consuming seed state made
    // this test fail on any second run without a reseed.
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: coordinatorCookie } });
    const tenantId = (session.json() as { user: { tenantId: string } }).user.tenantId;
    const [patient] = await db.insert(patients).values({ tenantId, name: "Lifecycle Test Patient", phone: `98${String(Date.now()).slice(-8)}`, marketingConsent: false }).returning();
    const [journey] = await db.insert(journeys).values({ tenantId, patientId: patient.id, journeyType: "Lifecycle Test", source: "walk_in", stage: "treatment_advised" }).returning();
    const [treatment] = await db.insert(treatmentOpportunities).values({ tenantId, patientId: patient.id, journeyId: journey.id, treatmentLabel: "Lifecycle Test Treatment", status: "ADVISED", estimatedValue: 10_000 }).returning();
    const target = { id: treatment.id, patientId: patient.id };

    try {

    const toDecisionPending = await app.inject({
      method: "PATCH", url: `/treatments/${target.id}/status`, cookies: { pulseos_session: coordinatorCookie }, payload: { status: "DECISION_PENDING" },
    });
    expect(toDecisionPending.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "PATCH", url: `/treatments/${target.id}/status`, cookies: { pulseos_session: coordinatorCookie }, payload: { status: "ADVISED" },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error).toBe("invalid_transition");

    const accept = await app.inject({
      method: "PATCH", url: `/treatments/${target.id}/status`, cookies: { pulseos_session: coordinatorCookie }, payload: { status: "ACCEPTED" },
    });
    expect(accept.statusCode).toBe(200);

    const myWork = await app.inject({ method: "GET", url: `/tasks?patientId=${target.patientId}`, cookies: { pulseos_session: coordinatorCookie } });
    const tasksForPatient = myWork.json() as { type: string }[];
    expect(tasksForPatient.some((t) => t.type === "TREATMENT_DECISION")).toBe(true);

    const timeline = await app.inject({ method: "GET", url: `/patients/${target.patientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes.filter((e) => e === "treatment_status_changed").length).toBeGreaterThanOrEqual(2);
    } finally {
      await db.delete(tasks).where(eq(tasks.journeyId, journey.id));
      await db.delete(timelineEvents).where(eq(timelineEvents.patientId, patient.id));
      await db.delete(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journey.id));
      await db.delete(journeys).where(eq(journeys.id, journey.id));
      await db.delete(patients).where(eq(patients.id, patient.id));
    }
  });
});
