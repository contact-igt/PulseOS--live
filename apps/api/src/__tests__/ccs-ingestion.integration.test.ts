import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type { CommunicationEndpointVm, ConnectorAgentMappingVm, PerformanceDashboard, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, calls, connectorSecrets, connectors, departments, journeys, patients, tasks, timelineEvents } from "../db/schema.js";
import { encryptSecret } from "../domain/security/encryption.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// CCS call -> the real Patient / Journey / Call / Task workflow. Synthetic data only.
// Provider field names are CANDIDATES (no real CCS payload has been captured yet); these tests pin PulseOS's behaviour.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const KEY = "synthetic-ccs-ingest-key-3e91";
const CAMP_LINE = "079 4000 1234";
const MAIN_LINE = "08040005678";

// CCS shows India local time without an offset.
const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

/** The shape of the structured CCS diagnostics lines (names and booleans only). */
interface LogLine {
  msg?: string;
  ccs: { fieldNames: { recognised: string[]; unrecognised: string[] }; presentedHeaders: string[]; presentedParams: string[] } & Record<string, unknown>;
}

describe.skipIf(!DEMO_PASSWORD)("CCS call ingestion into the patient journey (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let x: TestTenant;
  let ccs: string;
  let ccsX: string;
  let campSourceId: string;
  let departmentId: string;
  let campEndpoint: CommunicationEndpointVm;
  let mainEndpoint: CommunicationEndpointVm;
  let seq = 0;
  let phoneSeq = 0;

  const api = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `98${String(70000000 + ++phoneSeq * 137).padStart(8, "0")}`;
  const send = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/webhooks/ccs/${ccs}`, headers: { "x-api-key": KEY }, payload });
  const report = (over: Record<string, unknown> = {}) => ({ call_id: `ccs-ing-${Date.now()}-${++seq}`, caller_number: phone(), called_number: CAMP_LINE, agent_name: "Shivi", status: "Answered", duration: "86", direction: "inbound", start_time: ist(new Date()), circle: "Karnataka", call_group: "Reception", ...over });
  const callRow = async (id: unknown) => (await db.select().from(calls).where(and(eq(calls.tenantId, t.tenantId), eq(calls.externalCallId, String(id)))))[0]!;
  const patientOf = async (call: { patientId: string | null }) => (await db.select().from(patients).where(eq(patients.id, call.patientId!)))[0]!;
  const journeyOf = async (call: { journeyId: string | null }) => (await db.select().from(journeys).where(eq(journeys.id, call.journeyId!)))[0]!;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    x = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const mk = async (tt: TestTenant) => {
      const [c] = await db.insert(connectors).values({ tenantId: tt.tenantId, type: "TELEPHONY", provider: "ccs_ivr", displayName: "CCS IVR", capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"], configuration: {}, mode: "LIVE", status: "CONNECTING" }).returning({ id: connectors.id });
      await db.insert(connectorSecrets).values({ connectorId: c!.id, encryptedPayload: encryptSecret({ apiKey: KEY }) });
      return c!.id;
    };
    ccs = await mk(t);
    ccsX = await mk(x);

    const src = await api(t, "SUPER_ADMIN", "POST", "/lead-sources", { label: "Free Health Camp", bucket: "other" });
    expect(src.statusCode).toBe(201);
    campSourceId = src.json().id;
    const [dep] = await db.insert(departments).values({ tenantId: t.tenantId, key: "cataract", displayName: "Cataract" }).returning();
    departmentId = dep!.id;

    const camp = await api(t, "SUPER_ADMIN", "POST", `/connectors/${ccs}/endpoints`, { type: "PHONE", publicNumber: CAMP_LINE, providerRef: "ivr-camp", displayLabel: "Health camp line", branchId: t.branchId, leadSourceId: campSourceId, sourceDetail: "Dhanbad camp, Oct", departmentId });
    expect(camp.statusCode).toBe(201);
    campEndpoint = camp.json();
    const main = await api(t, "SUPER_ADMIN", "POST", `/connectors/${ccs}/endpoints`, { type: "PHONE", publicNumber: MAIN_LINE, providerRef: "ivr-main", displayLabel: "Main reception", branchId: t.branchId });
    expect(main.statusCode).toBe(201);
    mainEndpoint = main.json();

    const map = await api(t, "SUPER_ADMIN", "PUT", `/connectors/${ccs}/agent-mappings`, { externalAgent: "Shivi", userId: t.userIds.FRONT_DESK });
    expect(map.statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const tt of [t, x]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  describe("a new caller on a line the hospital mapped (a free health camp)", () => {
    const rep = report({ circle: "Karnataka" });
    it("creates a Patient (name unknown, never invented) and a Journey that inherits the line's attribution", async () => {
      expect((await send(rep)).statusCode).toBe(200);
      const call = await callRow(rep.call_id);
      const patient = await patientOf(call);
      expect(patient.phoneE164).toBe(`+91${rep.caller_number}`);
      expect(patient.name).toBeNull();
      expect(patient.branchId).toBe(t.branchId);
      const j = await journeyOf(call);
      expect(j).toMatchObject({ sourceId: campSourceId, source: "other", sourceDetail: "Dhanbad camp, Oct", departmentId, journeyType: "Phone enquiry", patientId: patient.id });
      expect(call.communicationEndpointId).toBe(campEndpoint.id);
    });
    it("keeps the telecom circle as provider metadata only: it is never the patient's location", async () => {
      const call = await callRow(rep.call_id);
      expect(call.metadata).toMatchObject({ circle: "Karnataka", callGroup: "Reception", calledLine: CAMP_LINE, provider: "ccs_ivr" });
      expect(JSON.stringify(await patientOf(call))).not.toContain("Karnataka");
    });
    it("stores no credential and no recording URL in the call's metadata", async () => {
      const r = report({ recording_url: "https://ccs.example.test/rec/abc.mp3?token=zzz", api_key: KEY });
      await app.inject({ method: "POST", url: `/webhooks/ccs/${ccs}`, headers: { "x-api-key": KEY }, payload: r });
      const call = await callRow(r.call_id);
      expect(JSON.stringify(call.metadata)).not.toMatch(new RegExp(`${KEY}|rec/abc|token=zzz`));
      expect(call.recordingUrl).toContain("rec/abc.mp3"); // kept for the protected store, never returned by the Integrations API
    });
  });

  describe("attribution when no mapping says otherwise", () => {
    it("a mapped line without a source, and an unknown line, fall back to Phone with the provider as the detail", async () => {
      const a = report({ called_number: MAIN_LINE });
      const b = report({ called_number: "09999999999" });
      const noLine = report({ called_number: undefined });
      for (const r of [a, b, noLine]) await send(r);
      const [ca, cb] = [await callRow(a.call_id), await callRow(b.call_id)];
      expect(ca.communicationEndpointId).toBe(mainEndpoint.id);
      expect(cb.communicationEndpointId).toBeNull(); // a reported line that matches nothing is never guessed
      for (const c of [ca, cb, await callRow(noLine.call_id)]) {
        expect(await journeyOf(c)).toMatchObject({ source: "phone", sourceDetail: "CCS Express IVR", departmentId: null });
      }
    });
    it("matches the line however it is written", async () => {
      for (const written of ["+91 79 4000 1234", "07940001234", "91-79-4000-1234"]) {
        const r = report({ called_number: written });
        await send(r);
        expect((await callRow(r.call_id)).communicationEndpointId, written).toBe(campEndpoint.id);
      }
    });
  });

  describe("repeat callers", () => {
    it("the same number in any format is one Patient; the active Journey is reused; answering never reassigns it", async () => {
      const num = phone();
      const first = report({ caller_number: num, agent_name: "Unmapped Agent" });
      await send(first);
      const c1 = await callRow(first.call_id);
      const j1 = await journeyOf(c1);
      const second = report({ caller_number: `+91 ${num.slice(0, 5)} ${num.slice(5)}`, agent_name: "shivi" });
      const third = report({ caller_number: `0${num}`, agent_name: "SHIVI " });
      await send(second);
      await send(third);
      for (const r of [second, third]) {
        const c = await callRow(r.call_id);
        expect(c.patientId).toBe(c1.patientId);
        expect(c.journeyId).toBe(c1.journeyId);
      }
      expect(await db.select().from(journeys).where(eq(journeys.patientId, c1.patientId!))).toHaveLength(1);
      expect((await journeyOf(c1)).ownerUserId).toBe(j1.ownerUserId); // Assigned Team Member untouched
    });
    it("a closed Journey is not reopened: the next call starts a new one for the same Patient", async () => {
      const num = phone();
      const first = report({ caller_number: num });
      await send(first);
      const c1 = await callRow(first.call_id);
      await db.update(journeys).set({ stage: "lost" }).where(eq(journeys.id, c1.journeyId!));
      const again = report({ caller_number: num });
      await send(again);
      const c2 = await callRow(again.call_id);
      expect(c2.patientId).toBe(c1.patientId);
      expect(c2.journeyId).not.toBe(c1.journeyId);
      expect(await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, `+91${num}`)))).toHaveLength(1);
    });
    it("an international number is not forced into India", async () => {
      const r = report({ caller_number: "+971501234567" });
      await send(r);
      const p = await patientOf(await callRow(r.call_id));
      expect(p).toMatchObject({ phoneE164: "+971501234567", phoneCountry: "AE" });
    });
  });

  describe("answered calls", () => {
    it("log one call with duration and 'Answered by <agent>'; the agent is recorded as who HANDLED it", async () => {
      const r = report({ duration: "86", agent_name: "Shivi" });
      await send(r);
      const call = await callRow(r.call_id);
      expect(call).toMatchObject({ direction: "inbound", status: "completed", durationSeconds: 86, agentName: "Shivi", handledByUserId: t.userIds.FRONT_DESK });
      const [line] = await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityId, call.id), eq(timelineEvents.eventType, "call_logged")));
      expect(line!.title).toBe("Incoming IVR call · Answered by Shivi");
      expect(line!.description).toContain("Duration · 1m 26s");
      expect(line!.description).toContain("Health camp line");
    });
    it("answered is not attended: no appointment, no stage change, no contacted-at", async () => {
      const r = report();
      await send(r);
      const call = await callRow(r.call_id);
      const j = await journeyOf(call);
      expect(j.stage).toBe("enquiry");
      expect(j.contactedAt).toBeNull();
      expect(await db.select().from(appointments).where(eq(appointments.patientId, call.patientId!))).toHaveLength(0);
    });
    it("an agent with no mapping is recorded by name only", async () => {
      const r = report({ agent_name: "Someone Else" });
      await send(r);
      expect(await callRow(r.call_id)).toMatchObject({ agentName: "Someone Else", handledByUserId: null });
    });
  });

  describe("missed calls", () => {
    it("'No Answer' on an inbound call is a missed call with exactly one callback task, even if CCS retries", async () => {
      const r = report({ status: "No Answer", duration: "0", agent_name: undefined });
      for (let i = 0; i < 3; i++) expect((await send(r)).statusCode).toBe(200);
      const call = await callRow(r.call_id);
      expect(call.status).toBe("missed");
      const [line] = await db.select().from(timelineEvents).where(and(eq(timelineEvents.relatedEntityId, call.id), eq(timelineEvents.eventType, "call_logged")));
      expect(line!.title).toBe("Missed IVR call");
      const found = await db.select().from(tasks).where(and(eq(tasks.tenantId, t.tenantId), eq(tasks.patientId, call.patientId!)));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ type: "CALLBACK", reason: "missed_follow_up", status: "pending" });
      expect(await db.select().from(appointments).where(eq(appointments.patientId, call.patientId!))).toHaveLength(0); // no fake visit
    });
    it("a new enquiry nobody owns lands in the team's unassigned queue", async () => {
      const r = report({ status: "Missed", duration: "0" });
      await send(r);
      const call = await callRow(r.call_id);
      const queue = (await api(t, "HOSPITAL_ADMIN", "GET", "/tasks?view=unassigned")).json() as { id: string }[];
      const mine = await db.select().from(tasks).where(and(eq(tasks.patientId, call.patientId!), eq(tasks.reason, "missed_follow_up")));
      expect(queue.some((q) => q.id === mine[0]!.id)).toBe(true);
    });
    it("on a Journey someone owns, the callback is in that person's My Work", async () => {
      const num = phone();
      const first = report({ caller_number: num });
      await send(first);
      const j = await journeyOf(await callRow(first.call_id));
      await db.update(journeys).set({ ownerUserId: t.userIds.FRONT_DESK }).where(eq(journeys.id, j.id));
      const missed = report({ caller_number: num, status: "No Answer", duration: "0" });
      await send(missed);
      const mine = (await api(t, "FRONT_DESK", "GET", "/tasks")).json() as { id: string; patientId: string }[];
      const patientId = (await callRow(missed.call_id)).patientId;
      expect(mine.some((m) => m.patientId === patientId)).toBe(true);
    });
    it("an outbound call nobody picked up is recorded but creates no 'missed call' work", async () => {
      const r = report({ direction: "outbound", status: "No Answer", duration: "0" });
      await send(r);
      const call = await callRow(r.call_id);
      expect(call).toMatchObject({ direction: "outbound", status: "no_answer" });
      expect(await db.select().from(tasks).where(eq(tasks.patientId, call.patientId!))).toHaveLength(0);
    });
  });

  describe("idempotency without a provider call id", () => {
    it("a retried report with no id is still one call", async () => {
      const r = report({ call_id: undefined, start_time: ist(new Date(Date.now() - 600_000)) });
      for (let i = 0; i < 3; i++) await send(r);
      const found = await db.select().from(calls).where(and(eq(calls.tenantId, t.tenantId), eq(calls.phone, r.caller_number as string)));
      expect(found).toHaveLength(1);
    });
  });

  describe("configuration is Super Admin only and tenant-scoped", () => {
    it("an Admin cannot set attribution or agent mappings; refused, not stripped", async () => {
      expect((await api(t, "HOSPITAL_ADMIN", "PATCH", `/connectors/${ccs}/endpoints/${mainEndpoint.id}`, { leadSourceId: campSourceId })).statusCode).toBe(403);
      expect((await api(t, "HOSPITAL_ADMIN", "PUT", `/connectors/${ccs}/agent-mappings`, { externalAgent: "Zed", userId: t.userIds.DOCTOR })).statusCode).toBe(403);
      expect((await api(t, "HOSPITAL_ADMIN", "GET", `/connectors/${ccs}/agent-mappings`)).statusCode).toBe(403);
      // An Admin may still change non-attribution settings, as before.
      expect((await api(t, "HOSPITAL_ADMIN", "PATCH", `/connectors/${ccs}/endpoints/${mainEndpoint.id}`, { displayLabel: "Main reception desk" })).statusCode).toBe(200);
    });
    it("another hospital cannot reference this hospital's sources, departments, users or connector", async () => {
      expect((await api(x, "SUPER_ADMIN", "POST", `/connectors/${ccsX}/endpoints`, { type: "PHONE", publicNumber: "08011112222", providerRef: "x1", displayLabel: "X", leadSourceId: campSourceId })).statusCode).toBe(404);
      expect((await api(x, "SUPER_ADMIN", "POST", `/connectors/${ccsX}/endpoints`, { type: "PHONE", publicNumber: "08011112223", providerRef: "x2", displayLabel: "X", departmentId })).statusCode).toBe(404);
      expect((await api(x, "SUPER_ADMIN", "PUT", `/connectors/${ccsX}/agent-mappings`, { externalAgent: "Shivi", userId: t.userIds.FRONT_DESK })).statusCode).toBe(404);
      expect((await api(x, "SUPER_ADMIN", "PUT", `/connectors/${ccs}/agent-mappings`, { externalAgent: "Shivi", userId: x.userIds.FRONT_DESK })).statusCode).toBe(404);
      expect((await api(x, "SUPER_ADMIN", "GET", `/connectors/${ccs}/agent-mappings`)).json()).toEqual([]);
      expect((await api(x, "SUPER_ADMIN", "PATCH", `/connectors/${ccs}/endpoints/${campEndpoint.id}`, { sourceDetail: "hijack" })).statusCode).toBe(404);
    });
    it("the team-member picker lists only this hospital's people, to a Super Admin only", async () => {
      const mine = (await api(t, "SUPER_ADMIN", "GET", `/connectors/${ccs}/agent-mapping-options`)).json() as { id: string; role: string }[];
      expect(mine.map((u) => u.id).sort()).toEqual(Object.values(t.userIds).sort());
      expect(mine.every((u) => !("email" in u) && !("passwordHash" in u))).toBe(true);
      const theirs = (await api(x, "SUPER_ADMIN", "GET", `/connectors/${ccsX}/agent-mapping-options`)).json() as { id: string }[];
      expect(theirs.some((u) => Object.values(t.userIds).includes(u.id))).toBe(false);
      expect((await api(t, "HOSPITAL_ADMIN", "GET", `/connectors/${ccs}/agent-mapping-options`)).statusCode).toBe(403);
    });
    it("agent mappings list, re-point and delete", async () => {
      const list = (await api(t, "SUPER_ADMIN", "GET", `/connectors/${ccs}/agent-mappings`)).json() as ConnectorAgentMappingVm[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ externalAgent: "Shivi", userId: t.userIds.FRONT_DESK });
      const repoint = await api(t, "SUPER_ADMIN", "PUT", `/connectors/${ccs}/agent-mappings`, { externalAgent: "  SHIVI ", userId: t.userIds.PATIENT_COORDINATOR });
      expect(repoint.statusCode).toBe(200);
      expect(((await api(t, "SUPER_ADMIN", "GET", `/connectors/${ccs}/agent-mappings`)).json() as unknown[]).length).toBe(1);
      expect((await api(t, "SUPER_ADMIN", "PUT", `/connectors/${ccs}/agent-mappings`, { externalAgent: "Shivi", userId: t.userIds.FRONT_DESK })).statusCode).toBe(200);
      const extra = (await api(t, "SUPER_ADMIN", "PUT", `/connectors/${ccs}/agent-mappings`, { externalAgent: "Temp", userId: t.userIds.DOCTOR })).json() as ConnectorAgentMappingVm;
      expect((await api(t, "SUPER_ADMIN", "DELETE", `/connectors/${ccs}/agent-mappings/${extra.id}`)).statusCode).toBe(204);
      expect((await api(t, "SUPER_ADMIN", "DELETE", `/connectors/${ccs}/agent-mappings/${extra.id}`)).statusCode).toBe(404);
    });
  });

  describe("source analytics: the call's origin follows the Journey to its outcomes", () => {
    it("Owner Performance counts the enquiry under the mapped source, then its visit once one happens", async () => {
      const perf = async () => ((await api(t, "SUPER_ADMIN", "GET", "/dashboard/performance?range=30d")).json() as PerformanceDashboard).sources.find((s) => s.label === "Free Health Camp");
      const r = report({ called_number: CAMP_LINE });
      await send(r);
      const before = await perf();
      expect(before).toBeDefined();
      expect(before!.enquiries).toBeGreaterThanOrEqual(1);
      const call = await callRow(r.call_id);
      const attendedBefore = before!.attended;
      await db.insert(appointments).values({ tenantId: t.tenantId, patientId: call.patientId!, journeyId: call.journeyId!, branchId: t.branchId, doctorUserId: t.userIds.DOCTOR!, scheduledAt: new Date(Date.now() - 3_600_000), status: "completed", checkedInAt: new Date(), completedAt: new Date() });
      const after = await perf();
      expect(after!.attended).toBe(attendedBefore + 1);
      expect(after!.enquiries).toBe(before!.enquiries);
    });
  });
  describe("what staff and the Super Admin see", () => {
    it("Recent calls say who called, how it went, who handled it, where it came from, and what is next", async () => {
      const num = phone();
      // Dated slightly ahead so they are the newest rows however many calls earlier tests created in the same second.
      const ahead = ist(new Date(Date.now() + 120_000));
      const missed = report({ caller_number: num, status: "No Answer", duration: "0", agent_name: undefined, start_time: ahead });
      await send(missed);
      const answered = report({ caller_number: phone(), agent_name: "Shivi", recording_url: "pulseos-fixture://silence.wav?recent-1", start_time: ahead });
      await send(answered);
      const detail = (await api(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/ccs_ivr")).json() as { recentCalls: Record<string, unknown>[] };
      const m = detail.recentCalls.find((c) => c.phone === `+91${num}` || c.phone === num)!;
      const a = detail.recentCalls.find((c) => c.hasRecording === true)!;
      expect(m).toMatchObject({ direction: "inbound", status: "missed", sourceLabel: "Free Health Camp", lineLabel: "Health camp line" });
      expect((m.nextAction as { type: string } | null)?.type).toBe("CALLBACK");
      expect(a).toMatchObject({ status: "completed", handledByName: expect.stringContaining("frontdesk"), hasRecording: true, durationSeconds: 86 });
      expect(JSON.stringify(detail)).not.toContain("recent-1");
    });

    it("a simulated test call is flagged as a test in the list and the detail; a real call is not", async () => {
      expect((await api(t, "SUPER_ADMIN", "POST", "/integrations/hub/ccs_ivr/test-event")).statusCode).toBe(200);
      const real = report({ start_time: ist(new Date(Date.now() + 180_000)) });
      await send(real);
      const [simulated] = await db.select().from(calls).where(and(eq(calls.tenantId, t.tenantId), eq(calls.agentName, "IVR Test Agent")));
      const realId = (await callRow(real.call_id)).id;
      const detailOf = async (id: string) => (await api(t, "HOSPITAL_ADMIN", "GET", `/integrations/hub/ccs_ivr/calls/${id}`)).json() as { isTest: boolean };
      expect((await detailOf(simulated!.id)).isTest).toBe(true);
      expect((await detailOf(realId)).isTest).toBe(false);
      const list = (await api(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/ccs_ivr")).json() as { recentCalls: { id: string; isTest: boolean }[] };
      expect(list.recentCalls.find((c) => c.id === realId)).toMatchObject({ isTest: false });
    });

    it("one call opens as a detail with provider context, source attribution and the next action, and no secret", async () => {
      const r = report({ call_group: "Camp desk", ivr_key: "2", answer_time: ist(new Date()), recording_url: "pulseos-fixture://silence.wav?detail-1" });
      await send(r);
      const call = await callRow(r.call_id);
      const res = await api(t, "HOSPITAL_ADMIN", "GET", `/integrations/hub/ccs_ivr/calls/${call.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: call.id, providerCallId: r.call_id, direction: "inbound", status: "completed", calledLine: CAMP_LINE, lineLabel: "Health camp line", callGroup: "Camp desk", circle: "Karnataka",
        ivrSelection: "2", sourceLabel: "Free Health Camp", sourceDetail: "Dhanbad camp, Oct", providerLabel: "CCS Express IVR", journeyId: call.journeyId, hasRecording: true,
      });
      expect(res.body).not.toMatch(new RegExp(`detail-1|${KEY}`));
    });

    it("the call detail is tenant-scoped: another hospital, or a role without integration access, gets nothing", async () => {
      const r = report();
      await send(r);
      const call = await callRow(r.call_id);
      expect((await api(x, "SUPER_ADMIN", "GET", `/integrations/hub/ccs_ivr/calls/${call.id}`)).statusCode).toBe(404);
      expect((await api(t, "FRONT_DESK", "GET", `/integrations/hub/ccs_ivr/calls/${call.id}`)).statusCode).toBe(403);
      expect((await api(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/ccs_ivr/calls/not-a-uuid")).statusCode).toBe(404);
    });

    it("the Super Admin can see which field names real CCS reports carry (names and status-like values, never phones or secrets)", async () => {
      await send(report({ campaign_tag: "diwali-camp", call_status: "Answered" }));
      const res = await api(t, "SUPER_ADMIN", "GET", "/integrations/hub/ccs_ivr/payload-shapes");
      expect(res.statusCode).toBe(200);
      const shapes = res.json() as { events: number; fields: { name: string; seen: number; recognised: boolean }[]; values: Record<string, string[]> };
      expect(shapes.events).toBeGreaterThan(0);
      const byName = Object.fromEntries(shapes.fields.map((f) => [f.name, f]));
      expect(byName.caller_number).toMatchObject({ recognised: true });
      expect(byName.campaign_tag).toMatchObject({ recognised: false }); // exactly the fields that still need mapping
      expect(shapes.values.call_status ?? shapes.values.status).toContain("Answered");
      expect(res.body).not.toMatch(/98\d{8}|synthetic-ccs-ingest-key/);
      expect((await api(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/ccs_ivr/payload-shapes")).statusCode).toBe(403);
      expect((await api(t, "SUPER_ADMIN", "GET", "/integrations/hub/google_ads/payload-shapes")).statusCode).toBe(404);
    });

    it("an unreachable or expired provider recording fails safely: no provider URL, no secret in the response", async () => {
      const r = report({ recording_url: "http://127.0.0.1:1/recordings/expired-9.mp3" });
      await send(r);
      const call = await callRow(r.call_id);
      const res = await api(t, "HOSPITAL_ADMIN", "GET", `/calls/${call.id}/recording`);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toMatch(/127\.0\.0\.1|expired-9/);
    });
  });
  describe("first-real-call diagnostics: what is logged, and what never is", () => {
    const PRIVATE_PHONE = `98${String(70000000 + ++phoneSeq * 977 + 123).padStart(8, "0")}`;
    const lines: string[] = [];
    let logged: FastifyInstance;
    const parsed = () => lines.flatMap((l) => l.split(/\r?\n/)).filter(Boolean).map((l) => { try { return JSON.parse(l) as LogLine; } catch { return null; } }).filter((x): x is LogLine => !!x);
    const post = (payload: Record<string, unknown>, headers: Record<string, string> = { "x-api-key": KEY }, query = "") => logged.inject({ method: "POST", url: `/webhooks/ccs/${ccs}${query}`, headers, payload });

    beforeAll(async () => {
      logged = await buildApp({ logStream: { write: (m: string) => void lines.push(m) } });
      await logged.ready();
    });
    afterAll(async () => {
      await logged.close();
    });

    it("a new answered call logs the field names, the line/source resolution and the match/create outcomes, as safe structured facts", async () => {
      lines.length = 0;
      const r = report({ caller_number: PRIVATE_PHONE, customer_name: "Secret Patient Name", recording_url: "https://ccs.example.test/rec/private-9.mp3?token=zzz", campaign_tag: "diwali" });
      expect((await post(r, {}, `?api_key=${KEY}`)).statusCode).toBe(200);
      const logs = parsed();
      const received = logs.find((l) => l.msg === "ccs call report received")!;
      expect(received.ccs).toMatchObject({ connectorId: ccs, events: 1 });
      expect(received.ccs.fieldNames.recognised).toEqual(expect.arrayContaining(["call_id", "caller_number", "called_number", "status", "duration", "recording_url"]));
      expect(received.ccs.fieldNames.unrecognised).toEqual(["campaign_tag"]);
      const done = logs.find((l) => l.msg === "ccs call ingested")!;
      expect(done.ccs).toMatchObject({ connectorId: ccs, direction: "inbound", outcome: "completed", patient: "created", journey: "created", callSaved: true, duplicate: false, taskCreated: false, lineResolved: true, sourceMapped: true, recordingAvailable: true, idDerived: false });
    });

    it("never logs the phone number, the name, the recording URL, any credential, or a payload value", async () => {
      const everything = lines.join("");
      for (const secret of [PRIVATE_PHONE, "Secret Patient Name", "private-9", "token=zzz", KEY, "diwali", "Dhanbad"]) expect(everything, secret).not.toContain(secret);
      expect(everything).toContain("api_key=[redacted]"); // the request line, with the key redacted
    });

    it("a retry logs as a duplicate with the patient matched, and a missed call logs that its callback task was created", async () => {
      lines.length = 0;
      const r = report({ caller_number: PRIVATE_PHONE, status: "No Answer", duration: "0" });
      await post(r);
      await post(r);
      const done = parsed().filter((l) => l.msg === "ccs call ingested").map((l) => l.ccs);
      expect(done).toHaveLength(2);
      expect(done[0]).toMatchObject({ outcome: "missed", patient: "matched", journey: "reused", callSaved: true, taskCreated: true });
      expect(done[1]).toMatchObject({ callSaved: false, duplicate: true, taskCreated: false });
    });

    it("a refused request logs which kinds of credential were PRESENTED and which are saved (names only), so a 401 can be diagnosed without a secret", async () => {
      lines.length = 0;
      const res = await post(report(), { "x-wrong-header": "synthetic-leak-check", authorization: "Bearer synthetic-bearer", "user-agent": "CCS-Webhook/1.0" }, "?token=synthetic-token-value");
      expect(res.statusCode).toBe(401);
      const rejected = parsed().find((l) => l.msg === "CCS IVR webhook authentication rejected")!;
      expect(rejected.ccs).toMatchObject({ connectorId: ccs, savedKeyKinds: ["apiKey"], userAgent: "CCS-Webhook/1.0" });
      expect(rejected.ccs.presentedHeaders).toEqual(expect.arrayContaining(["authorization"]));
      expect(rejected.ccs.presentedParams).toEqual(expect.arrayContaining(["token"]));
      const everything = lines.join("");
      for (const secret of ["synthetic-leak-check", "synthetic-bearer", "synthetic-token-value", KEY]) expect(everything, secret).not.toContain(secret);
    });

    it("a report that cannot be read as a call logs the field names it had, so the real shape can be mapped", async () => {
      lines.length = 0;
      expect((await post({ call_id: "x", note: "no caller", weird_field: "v" })).statusCode).toBe(422);
      const l = parsed().find((x) => x.msg === "ccs call report not normalized")!;
      expect(l.ccs.fieldNames.unrecognised).toEqual(expect.arrayContaining(["note", "weird_field"]));
      expect(lines.join("")).not.toContain("no caller");
    });
  });
});
