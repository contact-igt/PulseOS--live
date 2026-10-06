import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type { IntegrationDetail, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { calls, connectorEvents, connectorSecrets, connectors, journeys, patients, tasks, timelineEvents } from "../db/schema.js";
import { encryptSecret } from "../domain/security/encryption.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// CCS Express IVR inbound webhook: authentication fails CLOSED, ingestion is idempotent and tenant-scoped, and no
// credential is ever stored, echoed or returned. Synthetic keys only.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const KEY_A = "synthetic-ccs-key-A-7f3a91c2";
const KEY_B = "synthetic-ccs-key-B-52d0e8b4";
const SECRET_NEEDLES = [KEY_A, KEY_B];

describe.skipIf(!DEMO_PASSWORD)("CCS IVR webhook (integration)", () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;
  let ccsA: string;
  let ccsB: string;

  const hook = (id: string, payload: unknown, headers: Record<string, string> = {}, query = "") =>
    app.inject({ method: "POST", url: `/webhooks/ccs/${id}${query}`, headers, payload: payload as object });
  const asRole = (t: TestTenant, role: Role, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: t.cookie[role]! } });
  let n = 0;
  const callPayload = (over: Record<string, unknown> = {}) => ({ call_id: `ccs-test-${Date.now()}-${++n}`, caller_number: "9810157258", agent_name: "Asha", status: "Answered", duration: "45", direction: "inbound", start_time: "2026-10-06 10:15:00", ...over });
  const callsFor = (tenantId: string, externalCallId: string) => db.select().from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.externalCallId, externalCallId)));

  async function setAuth(connectorId: string, secrets: Record<string, unknown> | null, status: "CONNECTING" | "DISABLED" = "CONNECTING") {
    await db.delete(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId));
    if (secrets) await db.insert(connectorSecrets).values({ connectorId, encryptedPayload: encryptSecret(secrets) });
    await db.update(connectors).set({ status }).where(eq(connectors.id, connectorId));
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    a = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    b = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const mk = async (t: TestTenant) => (await db.insert(connectors).values({ tenantId: t.tenantId, type: "TELEPHONY", provider: "ccs_ivr", displayName: "CCS IVR", capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"], configuration: {}, mode: "LIVE" }).returning({ id: connectors.id }))[0]!.id;
    ccsA = await mk(a);
    ccsB = await mk(b);
  });
  afterAll(async () => {
    for (const t of [a, b]) await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });
  beforeEach(async () => {
    await setAuth(ccsA, { apiKey: KEY_A });
    await setAuth(ccsB, { apiKey: KEY_B });
  });

  describe("authentication fails closed", () => {
    it("a configured key presented correctly is accepted (header, or in the webhook URL for a provider that cannot set headers)", async () => {
      const p1 = callPayload();
      const r1 = await hook(ccsA, p1, { "x-api-key": KEY_A });
      expect(r1.statusCode).toBe(200);
      expect(await callsFor(a.tenantId, p1.call_id)).toHaveLength(1);
      // A real, authenticated, processed report is what "last valid call report" means.
      const inbound = ((await asRole(a, "SUPER_ADMIN", "/integrations/hub/ccs_ivr")).json() as IntegrationDetail).inbound!;
      expect(inbound.lastValidEventAt).not.toBeNull();
      const p2 = callPayload();
      expect((await hook(ccsA, p2, {}, `?api_key=${KEY_A}`)).statusCode).toBe(200);
      expect(await callsFor(a.tenantId, p2.call_id)).toHaveLength(1);
    });

    it("a wrong key is refused and nothing is stored", async () => {
      const p = callPayload();
      const r = await hook(ccsA, p, { "x-api-key": "synthetic-wrong-key" });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "unauthorized" });
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
    });

    it("a missing key is refused (this used to be accepted)", async () => {
      const p = callPayload();
      expect((await hook(ccsA, p)).statusCode).toBe(401);
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
    });

    it("a connector with no authentication configured refuses events by default: no secrets row, or only blank values", async () => {
      for (const secrets of [null, {}, { apiKey: "", secretKey: "  ", integrationKey: null }]) {
        await setAuth(ccsA, secrets);
        const p = callPayload();
        for (const headers of [{} as Record<string, string>, { "x-api-key": "anything" }]) {
          const r = await hook(ccsA, p, headers);
          expect(r.statusCode, JSON.stringify(secrets)).toBe(401);
        }
        expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
      }
    });

    it("another hospital's key does not open this hospital's webhook, and an event never lands in the wrong tenant", async () => {
      const p = callPayload();
      expect((await hook(ccsA, p, { "x-api-key": KEY_B })).statusCode).toBe(401);
      expect((await hook(ccsB, p, { "x-api-key": KEY_A })).statusCode).toBe(401);
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
      expect(await callsFor(b.tenantId, p.call_id)).toHaveLength(0);
      // The right key at the right URL lands only in its own tenant.
      expect((await hook(ccsB, p, { "x-api-key": KEY_B })).statusCode).toBe(200);
      expect(await callsFor(b.tenantId, p.call_id)).toHaveLength(1);
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
    });

    it("a connector of another provider cannot be driven through the CCS route", async () => {
      const p = callPayload();
      const r = await hook(a.connectorId /* a Runo connector */, p, { "x-api-key": KEY_A });
      expect(r.statusCode).toBe(200); // ignored exactly like an unknown connector (no probing signal)
      expect(r.json()).toEqual({ ok: true });
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
    });

    it("a disabled or unknown connector stores nothing", async () => {
      await setAuth(ccsA, { apiKey: KEY_A }, "DISABLED");
      const p = callPayload();
      expect((await hook(ccsA, p, { "x-api-key": KEY_A })).statusCode).toBe(200);
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
      expect((await hook("00000000-0000-4000-8000-000000000000", p, { "x-api-key": KEY_A })).statusCode).toBe(200);
      expect(await callsFor(a.tenantId, p.call_id)).toHaveLength(0);
    });

    it("an authenticated but malformed payload is refused; an empty ping (a provider's setup check) is acknowledged and stores nothing", async () => {
      const before = (await db.select().from(connectorEvents).where(eq(connectorEvents.connectorId, ccsA))).length;
      const bad = await hook(ccsA, { call_id: "x", note: "no caller number here" }, { "x-api-key": KEY_A });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toEqual({ error: "invalid_payload" });
      const ping = await hook(ccsA, {}, { "x-api-key": KEY_A });
      expect(ping.statusCode).toBe(200);
      expect((await db.select().from(connectorEvents).where(eq(connectorEvents.connectorId, ccsA))).length).toBe(before);
      // Garbage JSON is refused by the framework before any of this.
      const garbage = await app.inject({ method: "POST", url: `/webhooks/ccs/${ccsA}`, headers: { "content-type": "application/json", "x-api-key": KEY_A }, payload: "{not json" });
      expect(garbage.statusCode).toBe(400);
    });

    it("no credential is ever echoed, stored with the event or call, or listed in the logs view", async () => {
      const p = callPayload({ recording_url: "pulseos-fixture://silence.wav?ccs-secret-check" });
      const bodies: string[] = [];
      for (const r of [await hook(ccsA, p, { "x-api-key": KEY_A }), await hook(ccsA, p, {}, `?api_key=${KEY_A}`), await hook(ccsA, p, { "x-api-key": "synthetic-wrong" }, `?api_key=${KEY_B}`)]) bodies.push(r.body);
      const stored = JSON.stringify([await db.select().from(connectorEvents).where(eq(connectorEvents.connectorId, ccsA)), await db.select().from(calls).where(eq(calls.tenantId, a.tenantId))]);
      const views = [(await asRole(a, "SUPER_ADMIN", "/integrations/logs")).body, (await asRole(a, "SUPER_ADMIN", "/integrations/hub/ccs_ivr")).body];
      for (const text of [...bodies, stored, ...views]) for (const needle of SECRET_NEEDLES) expect(text).not.toContain(needle);
    });
  });

  describe("call ingestion", () => {
    const send = (payload: Record<string, unknown>) => hook(ccsA, payload, { "x-api-key": KEY_A });
    const patientsByPhone = (e164: string) => db.select().from(patients).where(and(eq(patients.tenantId, a.tenantId), eq(patients.phoneE164, e164)));

    it("an inbound answered call: normalized phone, one patient, a phone-enquiry journey, the call, and a timeline line", async () => {
      const p = callPayload({ caller_number: "98101 57258", recording_url: "pulseos-fixture://silence.wav?ingest-1" });
      expect((await send(p)).statusCode).toBe(200);
      const [call] = await callsFor(a.tenantId, p.call_id);
      expect(call).toMatchObject({ direction: "inbound", status: "completed", durationSeconds: 45, agentName: "Asha", origin: "IVR", connectorId: ccsA });
      const patient = await patientsByPhone("+919810157258");
      expect(patient).toHaveLength(1);
      expect(call!.patientId).toBe(patient[0]!.id);
      expect(call!.journeyId).not.toBeNull();
      const [journey] = await db.select().from(journeys).where(eq(journeys.id, call!.journeyId!));
      expect(journey).toMatchObject({ journeyType: "Phone enquiry", patientId: patient[0]!.id });
      const line = await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityId, call!.id), eq(timelineEvents.eventType, "call_logged")));
      expect(line).toHaveLength(1);
      expect(call!.recordingUrl).toBe("pulseos-fixture://silence.wav?ingest-1"); // recording metadata kept server-side
    });

    it("the same caller in other formats is the same patient, and an existing open journey is reused, not duplicated", async () => {
      const p1 = callPayload({ caller_number: "+91 9810157258" });
      const p2 = callPayload({ caller_number: "9810157258" });
      await send(p1);
      await send(p2);
      expect(await patientsByPhone("+919810157258")).toHaveLength(1);
      const [c1] = await callsFor(a.tenantId, p1.call_id);
      const [c2] = await callsFor(a.tenantId, p2.call_id);
      expect(c2!.journeyId).toBe(c1!.journeyId);
      expect(await db.select().from(journeys).where(and(eq(journeys.tenantId, a.tenantId), eq(journeys.patientId, c1!.patientId!)))).toHaveLength(1);
    });

    it("the same call_id delivered twice, or replayed, is one logical call: one call, one timeline line, one event, one task", async () => {
      const p = callPayload({ caller_number: "9810199999", status: "Missed", duration: "0" });
      const responses = [await send(p), await send(p), await send({ ...p })];
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      const found = await callsFor(a.tenantId, p.call_id);
      expect(found).toHaveLength(1);
      expect(found[0]!.status).toBe("missed");
      expect(await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityId, found[0]!.id), eq(timelineEvents.eventType, "call_logged")))).toHaveLength(1);
      expect(await db.select().from(connectorEvents).where(and(eq(connectorEvents.connectorId, ccsA), eq(connectorEvents.externalEventId, `ccs:event:${p.call_id}`)))).toHaveLength(1);
      expect(await db.select().from(tasks).where(and(eq(tasks.tenantId, a.tenantId), eq(tasks.patientId, found[0]!.patientId!), eq(tasks.reason, "missed_follow_up")))).toHaveLength(1);
      expect(await patientsByPhone("+919810199999")).toHaveLength(1);
    });

    it("an outbound call is stored as outbound and does not open an enquiry journey", async () => {
      const p = callPayload({ caller_number: "9810188888", direction: "outbound", status: "Answered" });
      expect((await send(p)).statusCode).toBe(200);
      const [call] = await callsFor(a.tenantId, p.call_id);
      expect(call).toMatchObject({ direction: "outbound", status: "completed" });
      expect(call!.journeyId).toBeNull();
    });
  });

  describe("recordings and tenant isolation", () => {
    it("the provider's recording URL never reaches the Integrations screen's API; playback is permission- and tenant-gated", async () => {
      const p = callPayload({ caller_number: "9810177777", recording_url: "pulseos-fixture://silence.wav?rec-check" });
      await hook(ccsA, p, { "x-api-key": KEY_A });
      const [call] = await callsFor(a.tenantId, p.call_id);
      const detail = (await asRole(a, "HOSPITAL_ADMIN", "/integrations/hub/ccs_ivr")).json() as IntegrationDetail;
      const listed = detail.recentCalls!.find((c) => c.id === call!.id)!;
      expect(listed).toBeDefined();
      expect(listed).toMatchObject({ hasRecording: true });
      expect(JSON.stringify(detail)).not.toContain("rec-check");
      // Roles with VIEW_CALL_RECORDING can play it; others and other hospitals cannot.
      expect((await asRole(a, "HOSPITAL_ADMIN", `/calls/${call!.id}/recording`)).statusCode).toBe(200);
      expect((await asRole(a, "FRONT_DESK", `/calls/${call!.id}/recording`)).statusCode).toBe(403);
      expect((await asRole(b, "SUPER_ADMIN", `/calls/${call!.id}/recording`)).statusCode).toBe(404);
      // The other hospital's integration view shows none of A's calls.
      const bDetail = (await asRole(b, "SUPER_ADMIN", "/integrations/hub/ccs_ivr")).json() as IntegrationDetail;
      expect((bDetail.recentCalls ?? []).some((c) => c.id === call!.id)).toBe(false);
    });
  });
});
