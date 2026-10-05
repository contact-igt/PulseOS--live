import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { conversionFeedbackEvents, journeys, patients, revenueEvents, tasks, tenants, timelineEvents, treatmentOpportunities } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { TreatmentRow, TreatmentStatus } from "@pulseos/types";

// Treatments Pipeline board contract: the board only ever offers the moves in
// BOARD_MOVES (mirrors apps/web/components/treatments/pipeline.ts). Every one
// of them must be accepted by PATCH /treatments/:id/status, and the moves the
// board hides must be rejected by the server (409) with the status unchanged —
// the server stays the authority. A role without MANAGE_TREATMENT (Doctor)
// gets a read-only board: it can list, never move.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

const BOARD_MOVES: [TreatmentStatus, TreatmentStatus][] = [
  ["ADVISED", "DECISION_PENDING"],
  ["ADVISED", "ACCEPTED"],
  ["DECISION_PENDING", "ACCEPTED"],
  ["ACCEPTED", "SCHEDULED"],
  ["SCHEDULED", "COMPLETED"],
];
const HIDDEN_MOVES: [TreatmentStatus, TreatmentStatus][] = [
  ["ADVISED", "SCHEDULED"],
  ["ADVISED", "COMPLETED"],
  ["DECISION_PENDING", "ADVISED"],
  ["ACCEPTED", "DECISION_PENDING"],
  ["SCHEDULED", "ACCEPTED"],
  ["COMPLETED", "SCHEDULED"],
  ["DECLINED", "ACCEPTED"],
];

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("treatment views — pipeline board moves (integration)", () => {
  let app: FastifyInstance;
  let admin: string;
  let doctor: string;
  let tenantId = "";
  let patientId = "";
  let journeyId = "";
  const treatmentIds: string[] = [];

  async function fixture(status: TreatmentStatus): Promise<string> {
    const [t] = await db
      .insert(treatmentOpportunities)
      .values({ tenantId, patientId, journeyId, treatmentLabel: `P3 board fixture ${status}`, status, estimatedValue: 1_000 })
      .returning();
    treatmentIds.push(t.id);
    return t.id;
  }

  async function statusOf(id: string): Promise<TreatmentStatus> {
    const [row] = await db.select({ status: treatmentOpportunities.status }).from(treatmentOpportunities).where(eq(treatmentOpportunities.id, id));
    return row.status;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await loginAs(app, "eye.admin@pulseos.local");
    doctor = await loginAs(app, "eye.doctor@pulseos.local");
    const [eye] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Ophthalmology Demo"));
    tenantId = eye.id;
    const [patient] = await db.insert(patients).values({ tenantId, name: "P3 Board Test Patient", phone: `97${String(Date.now()).slice(-8)}`, marketingConsent: false }).returning();
    const [journey] = await db.insert(journeys).values({ tenantId, patientId: patient.id, journeyType: "P3 Board Test", source: "walk_in", stage: "treatment_advised" }).returning();
    patientId = patient.id;
    journeyId = journey.id;
  });

  afterAll(async () => {
    if (journeyId) {
      await db.delete(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.journeyId, journeyId));
      await db.delete(revenueEvents).where(eq(revenueEvents.journeyId, journeyId));
      await db.delete(tasks).where(eq(tasks.journeyId, journeyId));
      await db.delete(timelineEvents).where(eq(timelineEvents.journeyId, journeyId));
      if (treatmentIds.length) await db.delete(treatmentOpportunities).where(inArray(treatmentOpportunities.id, treatmentIds));
      await db.delete(journeys).where(eq(journeys.id, journeyId));
      await db.delete(patients).where(eq(patients.id, patientId));
    }
    await app.close();
    await queryClient.end();
  });

  it.each(BOARD_MOVES)("board move %s -> %s is accepted and persists", async (from, to) => {
    const id = await fixture(from);
    const res = await app.inject({ method: "PATCH", url: `/treatments/${id}/status`, payload: { status: to }, cookies: { pulseos_session: admin } });
    expect(res.statusCode).toBe(200);
    expect(await statusOf(id)).toBe(to);
  });

  it.each(HIDDEN_MOVES)("hidden move %s -> %s is rejected (409 invalid_transition) and the status is unchanged", async (from, to) => {
    const id = await fixture(from);
    const res = await app.inject({ method: "PATCH", url: `/treatments/${id}/status`, payload: { status: to }, cookies: { pulseos_session: admin } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await statusOf(id)).toBe(from);
  });

  it("a stale board (card moved elsewhere first) is rejected by the server, not silently applied", async () => {
    const id = await fixture("ADVISED");
    await app.inject({ method: "PATCH", url: `/treatments/${id}/status`, payload: { status: "DECLINED" }, cookies: { pulseos_session: admin } });
    const res = await app.inject({ method: "PATCH", url: `/treatments/${id}/status`, payload: { status: "ACCEPTED" }, cookies: { pulseos_session: admin } });
    expect(res.statusCode).toBe(409);
    expect(await statusOf(id)).toBe("DECLINED");
  });

  it("Doctor (VIEW_TREATMENT, no MANAGE_TREATMENT) can list the board's rows but cannot move a card", async () => {
    const id = await fixture("ADVISED");
    const list = await app.inject({ method: "GET", url: "/treatments", cookies: { pulseos_session: doctor } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as TreatmentRow[]).some((r) => r.id === id)).toBe(true);
    const res = await app.inject({ method: "PATCH", url: `/treatments/${id}/status`, payload: { status: "ACCEPTED" }, cookies: { pulseos_session: doctor } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("MANAGE_TREATMENT");
    expect(await statusOf(id)).toBe("ADVISED");
  });
});
