import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { calls, connectorEvents, connectorSecrets, connectors, journeys, leadSources, patients, tasks, timelineEvents } from "../db/schema.js";
import { encryptSecret } from "../domain/security/encryption.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const API_KEY = "ccs-flow-api-key";

// The CCS Express IVR call flow end to end, through the real webhook route: authentication, caller normalisation,
// Patient / Journey creation and reuse, the Call and its Timeline line, exactly one missed-call follow-up, idempotent
// re-delivery, the phone source, the agent who handled it, and recordings kept behind the tenant's permissions.
// Every run uses fresh random numbers and call ids, so repeated runs on one database are independent.

describe.skipIf(!DEMO_PASSWORD)("CCS IVR call flow (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let connectorId: string;
  const local = `98${String(randomInt(10_000_000, 99_999_999))}`; // a 10-digit Indian mobile
  const e164 = `+91${local}`;
  const tag = randomUUID().slice(0, 8);
  const missedId = `ccs-missed-${tag}`;
  const answeredId = `ccs-answered-${tag}`;
  const recordingUrl = `https://recordings.ccs.example/${tag}.mp3`;

  const post = (payload: object, headers: Record<string, string> = { "x-api-key": API_KEY }) => app.inject({ method: "POST", url: `/webhooks/ccs/${connectorId}`, headers, payload });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const [c] = await db.insert(connectors).values({ tenantId: t.tenantId, type: "TELEPHONY", provider: "ccs_ivr", displayName: "CCS IVR", capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"], status: "CONNECTED", mode: "LIVE", configuration: {} }).returning();
    connectorId = c!.id;
    await db.insert(connectorSecrets).values({ connectorId, encryptedPayload: encryptSecret({ apiKey: API_KEY }) });
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("refuses a webhook with the wrong key and stores nothing", async () => {
    const res = await post({ uniqueid: `ccs-forged-${tag}`, caller: local, dialstatus: "Missed" }, { "x-api-key": "not-the-key" });
    expect(res.statusCode).toBe(401);
    expect(await db.select().from(calls).where(eq(calls.externalCallId, `ccs-forged-${tag}`))).toHaveLength(0);
  });

  it("a missed call: normalised caller, a new Patient and phone-sourced Journey, the Call, its Timeline line and exactly one follow-up", async () => {
    const res = await post({ uniqueid: missedId, caller: `0${local}`, dialstatus: "Missed", agent_name: "Reception Desk", start_time: new Date(Date.now() - 120_000).toISOString() });
    expect(res.statusCode).toBe(200);

    const [call] = await db.select().from(calls).where(and(eq(calls.connectorId, connectorId), eq(calls.externalCallId, missedId)));
    expect(call).toMatchObject({ status: "missed", direction: "inbound", origin: "IVR", agentName: "Reception Desk" });
    const [patient] = await db.select().from(patients).where(eq(patients.id, call!.patientId!));
    expect(patient!.phoneE164).toBe(e164);
    expect(patient!.tenantId).toBe(t.tenantId);

    const [journey] = await db.select().from(journeys).where(eq(journeys.id, call!.journeyId!));
    expect(journey).toMatchObject({ patientId: patient!.id, source: "phone", stage: "enquiry" });
    const [source] = await db.select().from(leadSources).where(eq(leadSources.id, journey!.sourceId!));
    expect(source!.key).toBe("phone");

    const line = await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityType, "call"), eq(timelineEvents.relatedEntityId, call!.id)));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ eventType: "call_logged", channel: "IVR_CALL", journeyId: journey!.id });
    expect(line[0]!.title).toContain("Reception Desk");

    const followUps = await db.select().from(tasks).where(and(eq(tasks.journeyId, journey!.id), eq(tasks.reason, "missed_follow_up")));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ type: "CALLBACK", status: "pending", priority: "high" });
  });

  it("a re-delivered event is idempotent: no second Call, Timeline line or follow-up", async () => {
    const again = await post({ uniqueid: missedId, caller: `0${local}`, dialstatus: "Missed", agent_name: "Reception Desk" });
    expect(again.statusCode).toBe(200);
    const stored = await db.select().from(calls).where(and(eq(calls.connectorId, connectorId), eq(calls.externalCallId, missedId)));
    expect(stored).toHaveLength(1);
    const events = await db.select().from(connectorEvents).where(and(eq(connectorEvents.connectorId, connectorId), eq(connectorEvents.externalEventId, `ccs:event:${missedId}`)));
    // The provider event is recorded once; the re-delivery is recognised as a duplicate, never processed again.
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("processed");
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.journeyId, stored[0]!.journeyId!), eq(tasks.reason, "missed_follow_up")));
    expect(n).toBe(1);
    const lines = await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityType, "call"), eq(timelineEvents.relatedEntityId, stored[0]!.id)));
    expect(lines).toHaveLength(1);
  });

  it("the same caller calls back (another number format): the Patient and the open Journey are reused, no new follow-up", async () => {
    const res = await post({ uniqueid: answeredId, caller: `+91 ${local.slice(0, 5)} ${local.slice(5)}`, dialstatus: "ANSWERED", duration: "95", agent_name: "Kavita", recording_url: recordingUrl, start_time: new Date(Date.now() - 60_000).toISOString() });
    expect(res.statusCode).toBe(200);
    const [missed] = await db.select().from(calls).where(eq(calls.externalCallId, missedId));
    const [answered] = await db.select().from(calls).where(eq(calls.externalCallId, answeredId));
    expect(answered).toMatchObject({ status: "completed", agentName: "Kavita", patientId: missed!.patientId, journeyId: missed!.journeyId });
    expect(await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, e164)))).toHaveLength(1);
    expect(await db.select().from(journeys).where(eq(journeys.patientId, missed!.patientId!))).toHaveLength(1);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.journeyId, missed!.journeyId!), eq(tasks.reason, "missed_follow_up")));
    expect(n).toBe(1);
  });

  it("the recording stays behind the tenant's permissions and is never handed to a role without them", async () => {
    const [answered] = await db.select().from(calls).where(eq(calls.externalCallId, answeredId));
    for (const role of ["FRONT_DESK", "DOCTOR"] as const) {
      const res = await app.inject({ method: "GET", url: `/calls/${answered!.id}/recording`, cookies: { pulseos_session: t.cookie[role]! } });
      expect(res.statusCode, role).toBe(403);
      const journey = await app.inject({ method: "GET", url: `/journeys/${answered!.journeyId}`, cookies: { pulseos_session: t.cookie[role]! } });
      expect(journey.body, `${role} journey view`).not.toContain(recordingUrl);
    }
    // Another hospital can never reach it.
    const other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    expect((await app.inject({ method: "GET", url: `/calls/${answered!.id}/recording`, cookies: { pulseos_session: other.cookie.SUPER_ADMIN! } })).statusCode).toBe(404);
  });
});
