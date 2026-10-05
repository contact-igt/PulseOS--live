import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { treatmentOpportunities } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { JourneyListRow, SessionUser, TaskRow, TreatmentRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

describe.skipIf(!DEMO_PASSWORD)("post-care / recall (integration)", () => {
  let app: FastifyInstance;
  let coordinatorCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("completing a scheduled treatment deterministically generates a post-care call task and a review recall task", async () => {
    // A test-local SCHEDULED treatment, not a shared seeded one: the seed's finite pool of
    // SCHEDULED treatments is a one-time resource, and this test permanently consumes
    // whichever one it completes (that's the real behavior under test — a completed
    // treatment never goes back to SCHEDULED). Relying on `/treatments?status=SCHEDULED`
    // rows[0] worked only on a freshly-seeded DB and failed on every subsequent run of the
    // same suite once the pool was exhausted. Inserting our own fixture here makes the test
    // repeatable indefinitely, independent of suite run order or how many times it's rerun.
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: coordinatorCookie } });
    const { user } = session.json() as { user: SessionUser };
    const journeys = await app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: coordinatorCookie } });
    const journey = (journeys.json() as JourneyListRow[])[0];

    const [treatment] = await db
      .insert(treatmentOpportunities)
      .values({
        tenantId: user.tenantId,
        patientId: journey.patientId,
        journeyId: journey.id,
        treatmentLabel: "Post-care test fixture",
        status: "SCHEDULED",
        estimatedValue: 50_000,
        plannedDate: new Date(),
      })
      .returning();
    const target = { id: treatment.id, patientId: treatment.patientId };

    const complete = await app.inject({
      method: "PATCH", url: `/treatments/${target.id}/status`, cookies: { pulseos_session: coordinatorCookie }, payload: { status: "COMPLETED" },
    });
    expect(complete.statusCode).toBe(200);

    const tasksRes = await app.inject({ method: "GET", url: `/tasks?patientId=${target.patientId}`, cookies: { pulseos_session: coordinatorCookie } });
    const tasksForPatient = tasksRes.json() as TaskRow[];

    const postCareCall = tasksForPatient.find((t) => t.type === "POST_CARE");
    expect(postCareCall).toBeTruthy();
    expect(new Date(postCareCall!.dueAt).toDateString()).toBe(daysFromNow(1).toDateString());

    const reviewRecall = tasksForPatient.find((t) => t.type === "RECALL");
    expect(reviewRecall).toBeTruthy();
    expect(new Date(reviewRecall!.dueAt).toDateString()).toBe(daysFromNow(7).toDateString());

    const timeline = await app.inject({ method: "GET", url: `/patients/${target.patientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes).toContain("treatment_status_changed");
  });

  it("rejects completing a treatment that was already completed (no re-generation of post-care tasks)", async () => {
    const list = await app.inject({ method: "GET", url: "/treatments?status=COMPLETED", cookies: { pulseos_session: coordinatorCookie } });
    const rows = list.json() as TreatmentRow[];
    expect(rows.length).toBeGreaterThan(0);
    const target = rows[0];

    const res = await app.inject({
      method: "PATCH", url: `/treatments/${target.id}/status`, cookies: { pulseos_session: coordinatorCookie }, payload: { status: "COMPLETED" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
  });
});
