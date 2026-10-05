import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hasPermission, type CallVm, type JourneyDetailVm, type Role, type TaskRow } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { callIntelligence, calls, journeys, leadSources, patients, tasks, timelineEvents, users } from "../db/schema.js";
import { persistInboundCall } from "../domain/connector/call-webhook.service.js";
import { MAX_ATTEMPTS, processDueCallIntelligence, transcriptToMessages, type IntelligenceDeps } from "../domain/call/call-intelligence.service.js";
import { FixtureTranscriber, getTranscriber } from "../domain/call/transcriber.js";
import { isSafeProviderUrl } from "../domain/call/recording.js";
import { FixtureSummarizer } from "../domain/conversation/summary/fixture-summarizer.js";
import { statusForManualCall } from "../domain/call/call.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const SECRET = "m4-test-shared-secret";
const SCRIPT = "Patient: Hello, I want to know about cataract surgery for my right eye.\nHospital: We can book a consultation. Saturday is available.\nPatient: Is Saturday morning possible? I will confirm after speaking with my family.\nHospital: Sure, we will call you on Friday.";

describe("call helpers (unit)", () => {
  it("a manual call's status follows direction and connection", () => {
    expect(statusForManualCall("inbound", true)).toBe("completed");
    expect(statusForManualCall("outbound", true)).toBe("completed");
    expect(statusForManualCall("inbound", false)).toBe("missed");
    expect(statusForManualCall("outbound", false)).toBe("no_answer");
  });

  it("splits a labelled transcript into speakers and keeps unlabelled text as one block", () => {
    const m = transcriptToMessages(SCRIPT, new Date());
    expect(m.map((x) => x.sender)).toEqual(["patient", "staff", "patient", "staff"]);
    expect(transcriptToMessages("just some text\nmore", new Date())).toEqual([expect.objectContaining({ sender: "system", body: "just some text more" })]);
  });

  it("only a FIXTURE connector gets a transcriber; the stand-in returns its own script or nothing, never invented text", async () => {
    expect(getTranscriber("LIVE", {})).toBeNull();
    expect(getTranscriber("SANDBOX", {})).toBeNull();
    expect(getTranscriber(null, {})).toBeNull();
    const t = getTranscriber("FIXTURE", {})!;
    expect(t).toBeInstanceOf(FixtureTranscriber);
    expect(await t.transcribe({ callId: "c", recordingRef: "r", metadata: { fixtureTranscript: SCRIPT } })).toBe(SCRIPT);
    expect(await t.transcribe({ callId: "c", recordingRef: "r", metadata: {} })).toBeNull();
  });

  it("recording URLs from a provider are only fetched when safe: https in production, never a private host", () => {
    const prod = { NODE_ENV: "production" };
    expect(isSafeProviderUrl("https://cdn.provider.com/a.mp3", prod)).toBe(true);
    for (const bad of ["http://cdn.provider.com/a.mp3", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.5/a", "https://192.168.1.2/a", "https://169.254.169.254/latest", "https://[::1]/a", "file:///etc/passwd", "ftp://x/a", "not a url"]) {
      expect(isSafeProviderUrl(bad, prod), bad).toBe(false);
    }
    expect(isSafeProviderUrl("http://127.0.0.1:9/a", { NODE_ENV: "test" })).toBe(true);
  });
});

describe.skipIf(!DEMO_PASSWORD)("calls: manual log, IVR, intelligence, recordings (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let live: TestTenant;
  let n = 0;
  let provider: Server;
  let providerUrl: string;
  const providerHits: { range?: string }[] = [];

  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const phone = () => `+9196${String(51000000 + ++n * 19).padStart(8, "0")}`;
  const post = (tt: TestTenant, role: Role, url: string, payload: object) => app.inject({ method: "POST", url, cookies: as(tt, role), payload });
  const get = (tt: TestTenant, role: Role, url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, cookies: as(tt, role), headers });
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  async function newLead(tt: TestTenant, extra: Record<string, unknown> = {}) {
    const res = await app.inject({ method: "POST", url: "/leads", cookies: as(tt, "FRONT_DESK"), payload: { phone: phone(), name: "Call Test", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "instagram", customFieldValues: {}, ...extra } });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  const journeyDetail = async (tt: TestTenant, role: Role, id: string) => (await get(tt, role, `/journeys/${id}`)).json() as JourneyDetailVm;
  const callRows = (journeyId: string) => db.select().from(calls).where(eq(calls.journeyId, journeyId));
  const runoPayload = (tt: TestTenant, o: { callId: string; phone: string; status?: string; direction?: string; recording?: string | null; transcript?: string; fixtureTranscript?: string }) => ({
    call_id: o.callId, phone_number: o.phone, customer_name: null, agent_name: "IVR Agent", direction: o.direction ?? "inbound", status: o.status ?? "completed", duration_seconds: 278,
    recording_url: o.recording === undefined ? `${providerUrl}/rec.mp3` : o.recording, started_at: new Date(Date.now() - 300_000).toISOString(), ended_at: new Date(Date.now() - 20_000).toISOString(),
    ...(o.transcript ? { transcript: o.transcript } : {}), ...(o.fixtureTranscript ? { fixture_transcript: o.fixtureTranscript } : {}),
  });
  const webhook = (tt: TestTenant, payload: object) => app.inject({ method: "POST", url: `/webhooks/runo/${tt.connectorId}`, payload, headers: { "x-api-key": SECRET } });
  const deps = (over: Partial<IntelligenceDeps> = {}): IntelligenceDeps => ({ transcriberFor: (mode) => getTranscriber(mode, {}), summarizer: new FixtureSummarizer(), ...over });
  const intel = async (callId: string) => (await db.select().from(callIntelligence).where(eq(callIntelligence.callId, callId)))[0];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!, { connectorMode: "FIXTURE", webhookSecret: SECRET });
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    live = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!, { connectorMode: "LIVE", webhookSecret: SECRET });
    await app.inject({ method: "POST", url: "/departments/install", cookies: as(t, "HOSPITAL_ADMIN"), payload: { templateKey: "ophthalmology" } });
    await app.inject({ method: "POST", url: "/departments/install", cookies: as(other, "HOSPITAL_ADMIN"), payload: { templateKey: "ophthalmology" } });
    // A tiny "provider" serving a recording with Range support, to prove streaming and Range forwarding.
    const body = Buffer.from("0123456789abcdefghij");
    provider = createServer((req, res) => {
      providerHits.push({ range: req.headers.range });
      if (req.url === "/missing.mp3") { res.statusCode = 404; res.end(); return; }
      if (req.url === "/page.html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<script>alert(1)</script>"); return; }
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
      if (m) {
        const start = Number(m[1]); const end = m[2] ? Number(m[2]) : body.length - 1;
        res.writeHead(206, { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1, "accept-ranges": "bytes" });
        res.end(body.subarray(start, end + 1));
      } else {
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": body.length, "accept-ranges": "bytes" });
        res.end(body);
      }
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    provider.close();
    for (const tt of [t, other, live]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  describe("manual Log Call", () => {
    it("records an incoming connected call from the Journey alone — no patient, phone, source or service to re-enter", async () => {
      const { journeyId, patientId } = await newLead(t);
      const res = await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, durationSeconds: 278, staffFeedback: "Patient will confirm after speaking with family." });
      expect(res.statusCode).toBe(201);
      const [row] = await callRows(journeyId);
      expect(row).toMatchObject({ origin: "MANUAL", direction: "inbound", status: "completed", durationSeconds: 278, connectorId: null, externalCallId: null, patientId, journeyId });
      expect(row!.phone).toBe((await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone);
      expect(row!.loggedByUserId).toBeTruthy();
    });

    it("records an outgoing call and a not-connected call with the right statuses; duration is dropped when nobody connected", async () => {
      const { journeyId } = await newLead(t);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "outbound", connected: true, durationSeconds: 60 })).statusCode).toBe(201);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "outbound", connected: false, durationSeconds: 99 })).statusCode).toBe(201);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: false })).statusCode).toBe(201);
      const rows = await callRows(journeyId);
      expect(rows.map((r) => [r.direction, r.status, r.durationSeconds]).sort()).toEqual([["inbound", "missed", null], ["outbound", "completed", 60], ["outbound", "no_answer", null]].sort());
    });

    it("appears in the one chronological timeline, with the manual-phone channel, as a call card with the staff's own words", async () => {
      const { journeyId, patientId } = await newLead(t);
      const earlier = new Date(Date.now() - 3 * 3_600_000).toISOString();
      await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "outbound", connected: true, durationSeconds: 90, occurredAt: earlier, staffFeedback: "Asked about Saturday timings." });
      const detail = await journeyDetail(t, "FRONT_DESK", journeyId);
      const ev = detail.timeline.find((e) => e.eventType === "call_logged")!;
      expect(ev.channel).toBe("MANUAL_CALL");
      expect(ev.occurredAt).toBe(earlier);
      expect(ev.call).toMatchObject({ origin: "MANUAL", direction: "outbound", connected: true, staffFeedback: "Asked about Saturday timings.", provider: "manual", hasRecording: false });
      expect(ev.call!.agentName).toBeTruthy();
      // timeline order is chronological, and the patient-level feed carries the same event
      const patientFeed = (await get(t, "FRONT_DESK", `/patients/${patientId}/timeline`)).json() as { eventType: string; call: CallVm | null }[];
      expect(patientFeed.find((e) => e.eventType === "call_logged")?.call?.staffFeedback).toBe("Asked about Saturday timings.");
    });

    it("a requested callback creates exactly one Task through the normal Task engine, owned by the Journey owner, linked from the call", async () => {
      const { journeyId } = await newLead(t, { ownerId: t.userIds.PATIENT_COORDINATOR });
      const dueAt = inHours(20);
      const res = await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, outcomeKey: "needs_callback", staffFeedback: "Call Friday 11 AM", callback: { dueAt, note: "Friday 11:00 AM" } });
      expect(res.statusCode).toBe(201);
      const taskId = res.json().callbackTaskId as string;
      expect(taskId).toBeTruthy();
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
      expect(task).toMatchObject({ type: "CALLBACK", status: "pending", journeyId, assignedTo: t.userIds.PATIENT_COORDINATOR, notes: "Friday 11:00 AM" });
      expect(task.dueAt.toISOString()).toBe(dueAt);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(1);
      // the owner sees it in My Work
      const mine = (await get(t, "PATIENT_COORDINATOR", "/tasks")).json() as TaskRow[];
      expect(mine.some((x) => x.id === taskId)).toBe(true);
      // the call card says a callback was created, and the journey's outcome moved
      const detail = await journeyDetail(t, "FRONT_DESK", journeyId);
      const call = detail.timeline.find((e) => e.eventType === "call_logged")!.call!;
      expect(call.callback).toMatchObject({ taskId, status: "pending" });
      expect(call.outcomeLabel).toBe("Needs callback");
      expect(detail.journey.lastOutcome?.label).toBe("Needs callback");
      expect(detail.journey.stage).toBe("contacted");
    });

    it("asking for a callback that cannot be honoured saves nothing at all — never a call without the callback it promised", async () => {
      const { journeyId } = await newLead(t);
      const before = (await callRows(journeyId)).length;
      const foreignUser = (await db.select().from(users).where(eq(users.tenantId, other.tenantId)).limit(1))[0]!;
      const bad = await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, callback: { dueAt: inHours(5), assignedTo: foreignUser.id } });
      expect(bad.statusCode).toBe(400);
      expect(await callRows(journeyId)).toHaveLength(before);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(0);
      // an outcome that requires a follow-up needs one
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, outcomeKey: "needs_callback" })).statusCode).toBe(422);
      // a callback in the past, a call in the future, a bad outcome, a bad direction
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, callback: { dueAt: inHours(-1) } })).statusCode).toBe(422);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, occurredAt: inHours(2) })).statusCode).toBe(422);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, outcomeKey: "nope" })).statusCode).toBe(400);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "sideways", connected: true })).statusCode).toBe(400);
      expect(await callRows(journeyId)).toHaveLength(before);
    });

    it("a double-tapped Save returns the first call: one call, one callback, even when the taps race", async () => {
      const { journeyId } = await newLead(t);
      const key = `idem-${Date.now()}-${n}`;
      const payload = { direction: "inbound", connected: true, outcomeKey: "needs_callback", callback: { dueAt: inHours(24) }, idempotencyKey: key };
      const results = await Promise.all(Array.from({ length: 5 }, () => post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, payload)));
      expect(results.every((r) => [200, 201].includes(r.statusCode))).toBe(true);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(new Set(results.map((r) => r.json().callId)).size).toBe(1);
      expect(await callRows(journeyId)).toHaveLength(1);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(1);
      expect((await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, payload)).json().duplicate).toBe(true);
    });

    it("who may log a call: Admin, Super Admin and Staff yes; Doctor no; signed-out no; another hospital's journey is a 404", async () => {
      const { journeyId } = await newLead(t);
      const body = { direction: "inbound", connected: true };
      for (const role of ["HOSPITAL_ADMIN", "SUPER_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR"] as Role[]) expect((await post(t, role, `/journeys/${journeyId}/calls`, body)).statusCode, role).toBe(201);
      const doctor = await post(t, "DOCTOR", `/journeys/${journeyId}/calls`, body);
      expect(doctor.statusCode).toBe(403);
      expect(doctor.json().requiredPermission).toBe("LOG_CALL");
      expect((await app.inject({ method: "POST", url: `/journeys/${journeyId}/calls`, payload: body })).statusCode).toBe(401);
      expect((await post(other, "FRONT_DESK", `/journeys/${journeyId}/calls`, body)).statusCode).toBe(404);
      expect(hasPermission("HOSPITAL_ADMIN", "MANAGE_INTEGRATION_SECRETS")).toBe(false); // logging calls grants no configuration power
    });

    it("call counts are derived from the call records: total, incoming, outgoing, connected, not connected", async () => {
      const { journeyId, patientId } = await newLead(t);
      expect((await journeyDetail(t, "FRONT_DESK", journeyId)).journey.callStats).toEqual({ total: 0, incoming: 0, outgoing: 0, connected: 0, notConnected: 0, lastCallAt: null });
      await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true });
      await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "outbound", connected: false });
      await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "outbound", connected: false });
      // an IVR call for the same patient lands on the same journey and is counted with the rest
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      expect((await webhook(t, runoPayload(t, { callId: `cnt-${Date.now()}`, phone: p }))).statusCode).toBe(200);
      const stats = (await journeyDetail(t, "FRONT_DESK", journeyId)).journey.callStats;
      expect(stats).toMatchObject({ total: 4, incoming: 2, outgoing: 2, connected: 2, notConnected: 2 });
      expect(stats.lastCallAt).toBeTruthy();
    });
  });

  describe("source is not channel", () => {
    it("original source stays Instagram whether the patient later phones in (IVR) or is called (manual); each call carries its own channel", async () => {
      const { journeyId, patientId } = await newLead(t, { sourceKey: "instagram" });
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await post(t, "FRONT_DESK", `/journeys/${journeyId}/calls`, { direction: "outbound", connected: true });
      await webhook(t, runoPayload(t, { callId: `src-${Date.now()}`, phone: p, recording: null }));
      const j = (await db.select().from(journeys).where(eq(journeys.id, journeyId)))[0]!;
      const insta = (await db.select().from(leadSources).where(and(eq(leadSources.tenantId, t.tenantId), eq(leadSources.key, "instagram"))))[0]!;
      expect(j.sourceId).toBe(insta.id);
      expect(j.source).toBe("meta");
      const channels = (await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, journeyId), eq(timelineEvents.eventType, "call_logged")))).map((e) => e.channel).sort();
      expect(channels).toEqual(["IVR_CALL", "MANUAL_CALL"]);
    });
  });

  describe("integrated IVR calls", () => {
    it("the webhook stores the call, a timeline call card, and keeps the provider URL server-side", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      const callId = `ivr-${Date.now()}`;
      expect((await webhook(t, runoPayload(t, { callId, phone: p }))).statusCode).toBe(200);
      const [row] = await db.select().from(calls).where(and(eq(calls.tenantId, t.tenantId), eq(calls.externalCallId, callId)));
      expect(row).toMatchObject({ origin: "IVR", journeyId, patientId, direction: "inbound", status: "completed", durationSeconds: 278 });
      const res = await get(t, "HOSPITAL_ADMIN", `/journeys/${journeyId}`);
      const ev = (res.json() as JourneyDetailVm).timeline.find((e) => e.relatedEntityId === row!.id)!;
      expect(ev).toMatchObject({ channel: "IVR_CALL" });
      expect(ev.call).toMatchObject({ origin: "IVR", hasRecording: true, connected: true });
      expect(res.body).not.toContain(providerUrl);
      for (const url of [`/patients/${patientId}/360`, `/patients/${patientId}/timeline`, `/journeys/${journeyId}`]) expect((await get(t, "FRONT_DESK", url)).body, url).not.toContain(providerUrl);
    });

    it("a missed call from a brand-new number opens a Phone enquiry Journey (source Phone, channel IVR) with ONE callback Task", async () => {
      const p = phone();
      const callId = `missed-${Date.now()}`;
      expect((await webhook(t, runoPayload(t, { callId, phone: p, status: "missed", recording: null }))).statusCode).toBe(200);
      const patient = (await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phone, p))))[0]!;
      expect(patient.name).toBeNull();
      const [j] = await db.select().from(journeys).where(eq(journeys.patientId, patient.id));
      expect(j).toMatchObject({ journeyType: "Phone enquiry", source: "phone", stage: "enquiry" });
      expect((await db.select().from(leadSources).where(eq(leadSources.id, j!.sourceId!)))[0]!.key).toBe("phone");
      const ts = await db.select().from(tasks).where(eq(tasks.patientId, patient.id));
      expect(ts).toHaveLength(1);
      expect(ts[0]).toMatchObject({ type: "CALLBACK", status: "pending", journeyId: j!.id, priority: "high" });
      const [c] = await db.select().from(calls).where(eq(calls.patientId, patient.id));
      expect(c).toMatchObject({ status: "missed", journeyId: j!.id });
    });

    it("a re-delivered call (same provider id) never duplicates the call, the timeline line or the missed-call Task", async () => {
      const p = phone();
      const payload = runoPayload(t, { callId: `retry-${Date.now()}`, phone: p, status: "missed", recording: null });
      for (let i = 0; i < 3; i++) expect((await webhook(t, payload)).statusCode).toBe(200);
      const patient = (await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phone, p))))[0]!;
      expect(await db.select().from(calls).where(eq(calls.patientId, patient.id))).toHaveLength(1);
      expect(await db.select().from(tasks).where(eq(tasks.patientId, patient.id))).toHaveLength(1);
      expect(await db.select().from(timelineEvents).where(and(eq(timelineEvents.patientId, patient.id), eq(timelineEvents.eventType, "call_logged")))).toHaveLength(1);
      // even when the provider reuses the call id under a fresh event id, the unique call id still guards the write
      const event = { externalEventId: "another-event-id", externalCallId: payload.call_id, phone: p, direction: "inbound" as const, status: "missed" as const, durationSeconds: null, recordingUrl: null, disposition: null, agentName: null, startedAt: new Date(), endedAt: new Date(), metadata: {} };
      await persistInboundCall(db, t.tenantId, t.connectorId, event);
      expect(await db.select().from(tasks).where(eq(tasks.patientId, patient.id))).toHaveLength(1);
    });

    it("an outgoing call to an unknown number does not invent an enquiry", async () => {
      const p = phone();
      await webhook(t, runoPayload(t, { callId: `out-${Date.now()}`, phone: p, direction: "outbound", recording: null }));
      const patient = (await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phone, p))))[0]!;
      expect(await db.select().from(journeys).where(eq(journeys.patientId, patient.id))).toHaveLength(0);
    });
  });

  describe("call intelligence: transcript and AI summary", () => {
    it("a provider-supplied transcript is stored as-is (PROVIDER), then summarized — labelled, and separate from staff feedback", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `prov-${Date.now()}`, phone: p, transcript: SCRIPT }));
      const [call] = await callRows(journeyId);
      expect((await intel(call!.id))).toMatchObject({ transcriptStatus: "COMPLETED", transcriptMode: "PROVIDER", summaryStatus: "PENDING", transcript: SCRIPT });

      // a human adds feedback BEFORE the machine summarizes
      const fb = await post(t, "FRONT_DESK", `/calls/${call!.id}/feedback`, { staffFeedback: "Family decides on Friday.", outcomeKey: "discussing_with_family", callback: { dueAt: inHours(30) } });
      expect(fb.statusCode).toBe(200);

      await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [call!.id] });
      const row = (await intel(call!.id))!;
      expect(row.summaryStatus).toBe("COMPLETED");
      expect(row.summaryMode).toBe("FIXTURE"); // never presented as AI
      expect(row.summary).toBeTruthy();

      const after = (await db.select().from(calls).where(eq(calls.id, call!.id)))[0]!;
      expect(after.staffFeedback).toBe("Family decides on Friday."); // the summary never touched the human's words
      expect(row.summary).not.toBe(after.staffFeedback);

      const card = (await journeyDetail(t, "HOSPITAL_ADMIN", journeyId)).timeline.find((e) => e.relatedEntityId === call!.id)!.call!;
      expect(card.staffFeedback).toBe("Family decides on Friday.");
      expect(card.intelligence?.summary).toMatchObject({ mode: "FIXTURE" });
      expect(card.intelligence?.summary?.text).not.toBe(card.staffFeedback);
      expect(card.intelligence).toMatchObject({ transcriptStatus: "COMPLETED", transcriptMode: "PROVIDER", hasTranscript: true });
      expect(JSON.stringify(card)).not.toContain("Saturday is available"); // transcript text is never in the card
    });

    it("on a FIXTURE connector the labelled stand-in transcribes and the pipeline runs end to end, idempotently", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `fix-${Date.now()}`, phone: p, fixtureTranscript: SCRIPT }));
      const [call] = await callRows(journeyId);
      expect((await intel(call!.id))).toMatchObject({ transcriptStatus: "PENDING", summaryStatus: "PENDING" });
      const first = await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [call!.id] });
      expect(first).toMatchObject({ transcribed: 1, summarized: 1 });
      const row = (await intel(call!.id))!;
      expect(row).toMatchObject({ transcriptStatus: "COMPLETED", transcriptMode: "FIXTURE", transcriptProvider: "fixture", summaryStatus: "COMPLETED" });
      const again = await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [call!.id] });
      expect(again).toMatchObject({ transcribed: 0, summarized: 0 });
      expect((await intel(call!.id))!.generatedAt?.getTime()).toBe(row.generatedAt?.getTime());
    });

    it("with no transcription provider (a LIVE connector) the recording is kept and the call says 'not configured' — nothing is faked", async () => {
      const { journeyId, patientId } = await newLead(live);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await app.inject({ method: "POST", url: `/webhooks/runo/${live.connectorId}`, payload: runoPayload(live, { callId: `live-${Date.now()}`, phone: p, fixtureTranscript: SCRIPT }), headers: { "x-api-key": SECRET } });
      const [call] = await callRows(journeyId);
      expect(call!.recordingUrl).toBeTruthy();
      expect(await intel(call!.id)).toMatchObject({ transcriptStatus: "NOT_CONFIGURED", summaryStatus: "NOT_CONFIGURED", transcript: null, summary: null });
      await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [call!.id] });
      expect(await intel(call!.id)).toMatchObject({ transcriptStatus: "NOT_CONFIGURED", transcript: null });
      const card = (await journeyDetail(live, "HOSPITAL_ADMIN", journeyId)).timeline.find((e) => e.relatedEntityId === call!.id)!.call!;
      expect(card).toMatchObject({ hasRecording: true });
      expect(card.intelligence).toMatchObject({ transcriptStatus: "NOT_CONFIGURED", hasTranscript: false, summary: null });
    });

    it("a transcription failure retries with backoff, then FAILED — and the call, recording and feedback stay fully usable; retry requeues", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `tfail-${Date.now()}`, phone: p, fixtureTranscript: SCRIPT }));
      const [call] = await callRows(journeyId);
      await post(t, "FRONT_DESK", `/calls/${call!.id}/feedback`, { staffFeedback: "Spoke to patient, will revisit." });
      const boom = deps({ transcriberFor: () => ({ provider: "broken", mode: "FIXTURE", transcribe: async () => { throw new Error("speech service unavailable"); } }) });
      let now = new Date();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await processDueCallIntelligence(db, now, boom, { onlyCallIds: [call!.id] });
        now = new Date(now.getTime() + 10 * 60_000);
      }
      expect(await intel(call!.id)).toMatchObject({ transcriptStatus: "FAILED", summaryStatus: "FAILED", attempts: MAX_ATTEMPTS });
      const card = (await journeyDetail(t, "FRONT_DESK", journeyId)).timeline.find((e) => e.relatedEntityId === call!.id)!.call!;
      expect(card).toMatchObject({ staffFeedback: "Spoke to patient, will revisit.", hasRecording: true, connected: true });
      expect(card.intelligence?.failed).toBe(true);
      expect(JSON.stringify(card)).not.toContain("speech service unavailable"); // diagnostics stay server-side
      expect((await get(t, "FRONT_DESK", `/journeys/${journeyId}`)).statusCode).toBe(200);

      // Admin retry: the failed stage returns to the queue and now succeeds
      expect((await post(t, "FRONT_DESK", `/calls/${call!.id}/intelligence/retry`, {})).statusCode).toBe(403);
      expect((await post(t, "HOSPITAL_ADMIN", `/calls/${call!.id}/intelligence/retry`, {})).statusCode).toBe(202);
      await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [call!.id] });
      expect(await intel(call!.id)).toMatchObject({ transcriptStatus: "COMPLETED", summaryStatus: "COMPLETED" });
      expect((await post(t, "HOSPITAL_ADMIN", `/calls/${call!.id}/intelligence/retry`, {})).statusCode).toBe(409); // nothing failed any more
    });

    it("a summary failure leaves the transcript intact and available; only the summary is retried", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `sfail-${Date.now()}`, phone: p, transcript: SCRIPT }));
      const [call] = await callRows(journeyId);
      const boom = deps({ summarizer: { provider: "broken", mode: "AI", summarize: async () => { throw new Error("model unavailable"); } } });
      let now = new Date();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await processDueCallIntelligence(db, now, boom, { onlyCallIds: [call!.id] });
        now = new Date(now.getTime() + 10 * 60_000);
      }
      expect(await intel(call!.id)).toMatchObject({ transcriptStatus: "COMPLETED", summaryStatus: "FAILED", transcript: SCRIPT, summary: null });
      expect(((await get(t, "HOSPITAL_ADMIN", `/calls/${call!.id}/transcript`)).json() as { text: string }).text).toBe(SCRIPT);
    });

    it("a worker that died mid-job does not strand the call: a stale claim is picked up again", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `stale-${Date.now()}`, phone: p, transcript: SCRIPT }));
      const [call] = await callRows(journeyId);
      await db.update(callIntelligence).set({ summaryStatus: "PROCESSING", claimedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(callIntelligence.callId, call!.id));
      await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [call!.id] });
      expect((await intel(call!.id))!.summaryStatus).toBe("COMPLETED");
    });

    it("concurrent workers never process the same call twice", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `conc-${Date.now()}`, phone: p, transcript: SCRIPT }));
      const [call] = await callRows(journeyId);
      let summarized = 0;
      const counting = deps({ summarizer: { provider: "counting", mode: "FIXTURE", summarize: async (m, o) => { summarized++; return new FixtureSummarizer().summarize(m, o); } } });
      await Promise.all(Array.from({ length: 4 }, () => processDueCallIntelligence(db, new Date(), counting, { onlyCallIds: [call!.id] })));
      expect(summarized).toBe(1);
    });
  });

  describe("recording and transcript access", () => {
    let callId: string;
    let journeyId: string;
    beforeAll(async () => {
      const lead = await newLead(t);
      journeyId = lead.journeyId;
      const p = (await db.select().from(patients).where(eq(patients.id, lead.patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `acc-${Date.now()}`, phone: p, transcript: SCRIPT }));
      callId = (await callRows(journeyId))[0]!.id;
    });

    it("Admin streams the provider's audio through PulseOS and can seek (Range is forwarded); the provider URL is never in a response", async () => {
      providerHits.length = 0;
      const play = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`);
      expect(play.statusCode).toBe(200);
      expect(play.rawPayload.toString()).toBe("0123456789abcdefghij");
      expect(play.headers["content-type"]).toBe("audio/mpeg");
      expect(play.headers["content-disposition"]).toBeUndefined();
      expect(JSON.stringify(play.headers)).not.toContain(providerUrl);
      const seek = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`, { range: "bytes=5-9" });
      expect(seek.statusCode).toBe(206);
      expect(seek.rawPayload.toString()).toBe("56789");
      expect(seek.headers["content-range"]).toBe("bytes 5-9/20");
      expect(providerHits.at(-1)?.range).toBe("bytes=5-9");
    });

    it("download is its own permission and sets Content-Disposition: attachment", async () => {
      const dl = await get(t, "SUPER_ADMIN", `/calls/${callId}/recording?download=1`);
      expect(dl.statusCode).toBe(200);
      expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="call-[0-9a-f]{8}\.mp3"$/);
      // playback and download are separate grants in the permission map
      expect(hasPermission("HOSPITAL_ADMIN", "VIEW_CALL_RECORDING")).toBe(true);
      expect(hasPermission("FRONT_DESK", "VIEW_CALL_RECORDING")).toBe(false);
    });

    it("Staff and Doctor can log calls but are refused the recording, its download and the transcript — server-side", async () => {
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) {
        const rec = await get(t, role, `/calls/${callId}/recording`);
        expect(rec.statusCode, role).toBe(403);
        expect(rec.json().requiredPermission).toBe("VIEW_CALL_RECORDING");
        expect((await get(t, role, `/calls/${callId}/recording?download=1`)).statusCode).toBe(403);
        const tr = await get(t, role, `/calls/${callId}/transcript`);
        expect(tr.statusCode, role).toBe(403);
        expect(tr.json().requiredPermission).toBe("VIEW_CALL_TRANSCRIPT");
      }
    });

    it("the call card tells each viewer only what they may open: transcript yes for Admin, no for Staff; the AI summary reaches both", async () => {
      await processDueCallIntelligence(db, new Date(), deps(), { onlyCallIds: [callId] });
      const card = async (role: Role) => (await journeyDetail(t, role, journeyId)).timeline.find((e) => e.relatedEntityId === callId)!.call!;
      expect((await card("HOSPITAL_ADMIN")).intelligence?.hasTranscript).toBe(true);
      const staff = await card("FRONT_DESK");
      expect(staff.intelligence?.hasTranscript).toBe(false);
      expect(staff.intelligence?.summary).toBeTruthy();
      expect(staff.hasRecording).toBe(true);
    });

    it("the transcript text comes only from its own endpoint, no-store, to a permitted role", async () => {
      const res = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/transcript`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.json()).toMatchObject({ status: "COMPLETED", mode: "PROVIDER", text: SCRIPT });
    });

    it("another hospital — even its Super Admin — gets 404 for this hospital's recording, transcript, feedback and retry", async () => {
      expect((await get(other, "SUPER_ADMIN", `/calls/${callId}/recording`)).statusCode).toBe(404);
      expect((await get(other, "SUPER_ADMIN", `/calls/${callId}/transcript`)).statusCode).toBe(404);
      expect((await post(other, "FRONT_DESK", `/calls/${callId}/feedback`, { staffFeedback: "hijack" })).statusCode).toBe(404);
      expect((await post(other, "SUPER_ADMIN", `/calls/${callId}/intelligence/retry`, {})).statusCode).toBe(404);
      expect((await db.select().from(calls).where(eq(calls.id, callId)))[0]!.staffFeedback).toBeNull();
    });

    it("a recording that cannot be fetched is a quiet 502 (never the URL); unknown / malformed ids are 404", async () => {
      await db.update(calls).set({ recordingUrl: `${providerUrl}/missing.mp3` }).where(eq(calls.id, callId));
      const missing = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`);
      expect(missing.statusCode).toBe(502);
      expect(missing.body).not.toContain(providerUrl);
      await db.update(calls).set({ recordingUrl: "ftp://nope/x.mp3" }).where(eq(calls.id, callId));
      expect((await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`)).statusCode).toBe(502);
      expect((await get(t, "HOSPITAL_ADMIN", "/calls/not-a-uuid/recording")).statusCode).toBe(404);
      expect((await get(t, "HOSPITAL_ADMIN", "/calls/00000000-0000-0000-0000-000000000000/recording")).statusCode).toBe(404);
      await db.update(calls).set({ recordingUrl: null }).where(eq(calls.id, callId));
      expect((await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`)).statusCode).toBe(404); // no recording
    });

    it("a provider that answers with something other than audio is never rendered by the browser: opaque type, nosniff, forced download", async () => {
      await db.update(calls).set({ recordingUrl: `${providerUrl}/page.html` }).where(eq(calls.id, callId));
      const res = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toContain("attachment");
    });

    it("only a plain single byte range is forwarded to the provider", async () => {
      await db.update(calls).set({ recordingUrl: `${providerUrl}/rec.mp3` }).where(eq(calls.id, callId));
      providerHits.length = 0;
      await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`, { range: "bytes=0-1,5-9" });
      await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`, { range: "garbage" });
      expect(providerHits.every((h) => h.range === undefined)).toBe(true);
    });

    it("the built-in fixture recording is a playable silent sample with Range support", async () => {
      await db.update(calls).set({ recordingUrl: "pulseos-fixture://silence.wav" }).where(eq(calls.id, callId));
      const full = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`);
      expect(full.statusCode).toBe(200);
      expect(full.headers["content-type"]).toBe("audio/wav");
      expect(full.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
      const part = await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`, { range: "bytes=0-99" });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.length).toBe(100);
      expect((await get(t, "HOSPITAL_ADMIN", `/calls/${callId}/recording`, { range: "bytes=99999999-" })).statusCode).toBe(416);
    });
  });

  describe("feedback on an existing call", () => {
    it("adds the human side only: feedback, outcome and one callback; a second callback is refused; the next view is persisted", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `fbk-${Date.now()}`, phone: p, recording: null }));
      const [call] = await callRows(journeyId);
      expect((await post(t, "FRONT_DESK", `/calls/${call!.id}/feedback`, {})).statusCode).toBe(400);
      const ok = await post(t, "FRONT_DESK", `/calls/${call!.id}/feedback`, { staffFeedback: "Wants Saturday.", outcomeKey: "needs_callback", callback: { dueAt: inHours(26), note: "Call before noon" } });
      expect(ok.statusCode).toBe(200);
      expect((await post(t, "FRONT_DESK", `/calls/${call!.id}/feedback`, { callback: { dueAt: inHours(40) } })).statusCode).toBe(409);
      const after = (await db.select().from(calls).where(eq(calls.id, call!.id)))[0]!;
      expect(after).toMatchObject({ staffFeedback: "Wants Saturday.", origin: "IVR" });
      expect(after.callbackTaskId).toBe(ok.json().callbackTaskId);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(1);
      const card = (await journeyDetail(t, "FRONT_DESK", journeyId)).timeline.find((e) => e.relatedEntityId === call!.id)!.call!;
      expect(card).toMatchObject({ staffFeedback: "Wants Saturday.", staffFeedbackBy: expect.any(String), outcomeLabel: "Needs callback", callback: { status: "pending" } });
    });

    it("the Doctor role cannot add feedback", async () => {
      const { journeyId, patientId } = await newLead(t);
      const p = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.phone;
      await webhook(t, runoPayload(t, { callId: `dfb-${Date.now()}`, phone: p, recording: null }));
      const [call] = await callRows(journeyId);
      expect((await post(t, "DOCTOR", `/calls/${call!.id}/feedback`, { staffFeedback: "x" })).statusCode).toBe(403);
    });
  });
});
