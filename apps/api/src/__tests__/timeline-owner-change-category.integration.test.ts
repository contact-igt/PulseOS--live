import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { TimelineEventVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { journeys, tenants, timelineEvents } from "../db/schema.js";

// Integration test: requires a migrated + seeded DB and DEMO_PASSWORD.
// A journey ownership change is a coordination event (who is responsible next), so the Timeline
// files it with tasks/ownership rather than the catch-all "other" bucket.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("timeline category for journey_owner_changed (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let patientId: string;
  let eventId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "eye.coordinator@pulseos.local", password: DEMO_PASSWORD } });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const [{ id: tenantId }] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Ophthalmology Demo"));
    const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.specialtyKey, "CATARACT"))).limit(1);
    patientId = journey.patientId;
    const [event] = await db
      .insert(timelineEvents)
      .values({ tenantId, patientId, journeyId: journey.id, actorType: "user", eventType: "journey_owner_changed", title: "Journey owner changed (category test)" })
      .returning();
    eventId = event.id;
  });

  afterAll(async () => {
    await db.delete(timelineEvents).where(eq(timelineEvents.id, eventId));
    await app.close();
  });

  it("is categorised as tasks, not other", async () => {
    const res = await app.inject({ method: "GET", url: `/patients/${patientId}/timeline`, cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const event = (res.json() as TimelineEventVm[]).find((e) => e.id === eventId);
    expect(event?.category).toBe("tasks");
  });
});
