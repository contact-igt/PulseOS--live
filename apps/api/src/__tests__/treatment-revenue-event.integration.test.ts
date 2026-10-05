import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { journeys, patients, revenueEvents, tasks, tenants, timelineEvents, treatmentOpportunities, users } from "../db/schema.js";
import { updateTreatmentStatus } from "../domain/treatment/treatment.service.js";

// Integration test: requires DATABASE_URL pointed at a migrated + SEEDED
// PulseOS dev DB (needs a real tenant/user row for actorId).
//
// Audit finding (docs/audits/2026-09-28-pulseos-central-platform-readiness-audit.md):
// revenueEvents had NO real production write path — only apps/api/src/seed/seed.ts
// ever inserted a row. Completing a Treatment in the real app produced no revenue
// attribution event at all. This file locks down the fix: completing a treatment
// (SCHEDULED -> COMPLETED) must write exactly one revenueEvents row carrying the
// treatment's real journey/patient attribution, exactly once, even under retries
// or concurrent duplicate requests — and non-completion transitions must never
// write one.

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("Treatment Completed -> revenue event write path — integration", () => {
  let tenantId: string;
  let actorId: string;
  let patientId: string;
  let journeyId: string;

  beforeAll(async () => {
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Gynecology Demo")).limit(1);
    tenantId = tenant.id;
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId)).limit(1);
    actorId = user.id;

    const [patient] = await db.insert(patients).values({ tenantId, name: "Revenue Event Test Patient", phone: "+919876500066", marketingConsent: false }).returning();
    patientId = patient.id;
    const [journey] = await db.insert(journeys).values({ tenantId, patientId, journeyType: "Revenue Event Test", source: "walk_in", stage: "treatment_advised" }).returning();
    journeyId = journey.id;
  });

  afterAll(async () => {
    await db.delete(revenueEvents).where(eq(revenueEvents.journeyId, journeyId));
    await db.delete(tasks).where(eq(tasks.journeyId, journeyId));
    await db.delete(timelineEvents).where(eq(timelineEvents.journeyId, journeyId));
    await db.delete(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journeyId));
    await db.delete(journeys).where(eq(journeys.id, journeyId));
    await db.delete(patients).where(eq(patients.id, patientId));
    await queryClient.end();
  });

  async function freshTreatment(status: "SCHEDULED" | "ADVISED", estimatedValue: number, label: string) {
    const [t] = await db.insert(treatmentOpportunities).values({ tenantId, patientId, journeyId, treatmentLabel: label, status, estimatedValue }).returning();
    return t;
  }

  it("completing a treatment creates exactly one revenueEvents row with the right amount/type/journeyId/patientId", async () => {
    const treatment = await freshTreatment("SCHEDULED", 45_000, "Cycle A");

    const result = await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED");
    expect(result.ok).toBe(true);

    const rows = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatment.id));
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(45_000);
    expect(rows[0].type).toBe("treatment_payment");
    expect(rows[0].journeyId).toBe(journeyId);
    expect(rows[0].patientId).toBe(patientId);
    expect(rows[0].tenantId).toBe(tenantId);
  });

  it("completing an already-COMPLETED treatment again is rejected by the state machine and does not create a second revenue event", async () => {
    const treatment = await freshTreatment("SCHEDULED", 30_000, "Cycle B");
    const first = await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED");
    expect(first.ok).toBe(true);

    const second = await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("invalid_transition");

    const rows = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatment.id));
    expect(rows.length).toBe(1);
  });

  it("two concurrent completion attempts on the same treatment produce at most one revenue event, and the loser fails cleanly", async () => {
    const treatment = await freshTreatment("SCHEDULED", 60_000, "Cycle C — race");

    const [r1, r2] = await Promise.all([
      updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED"),
      updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED"),
    ]);

    const results = [r1, r2];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    // The loser must fail cleanly with a recognizable reason, not throw.
    if (!losers[0].ok) expect(["conflict", "invalid_transition"]).toContain(losers[0].reason);

    const rows = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatment.id));
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(60_000);

    const [row] = await db.select({ status: treatmentOpportunities.status }).from(treatmentOpportunities).where(eq(treatmentOpportunities.id, treatment.id));
    expect(row.status).toBe("COMPLETED");
  });

  it("a treatment that transitions to DECLINED never creates a revenue event", async () => {
    const treatment = await freshTreatment("ADVISED", 20_000, "Cycle D — declined");
    const result = await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "DECLINED");
    expect(result.ok).toBe(true);

    const rows = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatment.id));
    expect(rows.length).toBe(0);
  });

  it("a treatment that transitions to CANCELLED never creates a revenue event", async () => {
    const treatment = await freshTreatment("SCHEDULED", 20_000, "Cycle E — cancelled");
    const result = await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "CANCELLED");
    expect(result.ok).toBe(true);

    const rows = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatment.id));
    expect(rows.length).toBe(0);
  });

  it("the revenue event's journeyId attribution matches the treatment's own journey exactly", async () => {
    const treatment = await freshTreatment("SCHEDULED", 15_000, "Cycle F");
    await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED");

    const [row] = await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, treatment.id));
    expect(row.journeyId).toBe(treatment.journeyId);
    expect(row.journeyId).toBe(journeyId);
  });

  it("verifies the row is visible to downstream revenue readers via a plain tenant+journey query (dashboard/campaign query shape)", async () => {
    const treatment = await freshTreatment("SCHEDULED", 12_000, "Cycle G");
    await updateTreatmentStatus(db, tenantId, treatment.id, actorId, "COMPLETED");

    const rows = await db.select({ amount: revenueEvents.amount }).from(revenueEvents).where(and(eq(revenueEvents.tenantId, tenantId), eq(revenueEvents.journeyId, journeyId)));
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(total).toBeGreaterThanOrEqual(12_000);
  });
});
