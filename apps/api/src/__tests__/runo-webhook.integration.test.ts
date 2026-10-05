import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, Patient360 } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Endpoint providerRefs are unique per connector and never cleaned up, so fixed values would 409 on the second run against the same DB.
const RUN = Date.now().toString(36);
const SHARED_SECRET = "pulseos-fixture-runo-secret";

function runoCallPayload(opts: { callId: string; phone: string; status?: string; disposition?: string | null; name?: string | null }) {
  return {
    call_id: opts.callId,
    phone_number: opts.phone,
    customer_name: opts.name ?? null,
    agent_name: "Test Agent",
    direction: "inbound",
    status: opts.status ?? "completed",
    duration_seconds: 120,
    recording_url: "https://fixture.example/recording.mp3",
    disposition: opts.disposition ?? null,
    started_at: new Date(Date.now() - 130_000).toISOString(),
    ended_at: new Date().toISOString(),
  };
}

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("Runo webhook (integration, fixture mode)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let connectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const runo = (list.json() as ConnectorRow[]).find((c) => c.provider === "runo");
    connectorId = runo!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects a call event with a missing/wrong x-api-key", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-noauth-1", phone: "919100000001" }),
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correctly authenticated call, persists it, resolves a Patient, and writes a Timeline event", async () => {
    const phone = "919100000002";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-fixture-1", phone, name: "Runo Fixture Caller" }),
      headers: { "x-api-key": SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Fixture Caller")}`, cookies: { pulseos_session: adminCookie } });
    const rows = patients.json() as { id: string; name: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const patient = rows[0];

    const timeline = await app.inject({ method: "GET", url: `/patients/${patient.id}/timeline`, cookies: { pulseos_session: adminCookie } });
    const events = timeline.json() as { eventType: string; relatedEntityType: string | null; relatedEntityId: string | null; channel: string | null }[];
    const callEvent = events.find((e) => e.eventType === "call_logged");
    expect(callEvent).toBeDefined();

    // The `calls` table had been write-only since its introduction — no API
    // route ever read it back. This is the read path's first real proof:
    // the call must actually surface on Patient 360, not just exist as an
    // orphaned DB row.
    const patient360 = await app.inject({ method: "GET", url: `/patients/${patient.id}/360`, cookies: { pulseos_session: adminCookie } });
    expect(patient360.statusCode).toBe(200);
    const { calls } = patient360.json() as Patient360;
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      provider: "runo",
      direction: "inbound",
      status: "completed",
      durationSeconds: 120,
      hasRecording: true,
      agentName: "Test Agent",
    });
    // The provider URL never rides along in a patient payload; it is fetched through the permission-gated endpoint.
    expect(patient360.body).not.toContain("fixture.example/recording.mp3");

    // The Timeline event must be traceable back to its own `calls` row, not
    // just tagged with a type and no id.
    expect(callEvent!.relatedEntityType).toBe("call");
    expect(callEvent!.relatedEntityId).toBe(calls[0].id);
    // How it happened (an IVR call) — a channel, not a source.
    expect(callEvent!.channel).toBe("IVR_CALL");
  });

  it("a duplicate delivery of the same call_id is idempotent — only one Timeline event is written", async () => {
    const phone = "919100000003";
    const payload = runoCallPayload({ callId: "call-fixture-dup", phone, name: "Runo Dup Caller" });

    const first = await app.inject({ method: "POST", url: `/webhooks/runo/${connectorId}`, payload, headers: { "x-api-key": SHARED_SECRET } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/webhooks/runo/${connectorId}`, payload, headers: { "x-api-key": SHARED_SECRET } });
    expect(second.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Dup Caller")}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];
    const timeline = await app.inject({ method: "GET", url: `/patients/${patient.id}/timeline`, cookies: { pulseos_session: adminCookie } });
    const callEvents = (timeline.json() as { eventType: string }[]).filter((e) => e.eventType === "call_logged");
    expect(callEvents.length).toBe(1);
  });

  it("a missed call creates a CALLBACK task even with no disposition — previously created nothing at all", async () => {
    const phone = "919100000005";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-fixture-missed", phone, name: "Runo Missed Caller", status: "missed" }),
      headers: { "x-api-key": SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Missed Caller")}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];

    const taskRes = await app.inject({ method: "GET", url: `/tasks?patientId=${patient.id}`, cookies: { pulseos_session: adminCookie } });
    const taskRows = taskRes.json() as { type: string; status: string; notes: string | null }[];
    const callbackTask = taskRows.find((t) => t.type === "CALLBACK" && /missed call/i.test(t.notes ?? ""));
    expect(callbackTask).toBeDefined();
    expect(callbackTask!.status).toBe("pending");
    expect(callbackTask!.notes).toMatch(/missed call/i);
  });

  it("a missed call with a (nonsensical but possible) disposition still only creates the missed-call task, not also a disposition-mapped one", async () => {
    const phone = "919100000006";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-fixture-missed-disp", phone, name: "Runo Missed Disp Caller", status: "missed", disposition: "CALL_BACK_LATER" }),
      headers: { "x-api-key": SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Missed Disp Caller")}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];

    const taskRes = await app.inject({ method: "GET", url: `/tasks?patientId=${patient.id}`, cookies: { pulseos_session: adminCookie } });
    const taskRows = taskRes.json() as { type: string; notes: string | null }[];
    // Other suites may add unrelated manual tasks to a shared demo patient: assert on the tasks THIS call produces.
    const callbackTasks = taskRows.filter((t) => t.type === "CALLBACK" && /missed call|disposition/i.test(t.notes ?? ""));
    expect(callbackTasks.length).toBe(1);
    expect(callbackTasks[0].notes).toMatch(/missed call/i);
    expect(callbackTasks[0].notes).not.toMatch(/disposition/i);
  });

  it("a CALL_BACK_LATER disposition creates a CALLBACK task (deterministic disposition mapping)", async () => {
    const phone = "919100000004";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-fixture-cb", phone, name: "Runo Callback Caller", disposition: "CALL_BACK_LATER" }),
      headers: { "x-api-key": SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Callback Caller")}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];

    const tasks = await app.inject({ method: "GET", url: `/tasks?patientId=${patient.id}`, cookies: { pulseos_session: adminCookie } });
    const taskRows = tasks.json() as { type: string }[];
    expect(taskRows.some((t) => t.type === "CALLBACK")).toBe(true);
  });

  it("resolves a call's endpoint when the connector has exactly one active endpoint configured", async () => {
    // Other test files (e.g. communication-endpoints.integration.test.ts)
    // also create endpoints on this same seeded Runo connector — when the
    // full suite runs together, leftover active ones from those files would
    // break this test's "exactly one" precondition regardless of execution
    // order. Deactivate whatever is already there first so this test proves
    // its own claim rather than depending on suite ordering.
    const existing = await app.inject({ method: "GET", url: `/connectors/${connectorId}/endpoints`, cookies: { pulseos_session: adminCookie } });
    for (const e of existing.json() as { id: string; isActive: boolean }[]) {
      if (e.isActive) {
        await app.inject({ method: "PATCH", url: `/connectors/${connectorId}/endpoints/${e.id}`, cookies: { pulseos_session: adminCookie }, payload: { isActive: false } });
      }
    }

    const created = await app.inject({
      method: "POST",
      url: `/connectors/${connectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100099001", providerRef: `runo-sole-line-${RUN}`, displayLabel: "Runo Sole Line" },
    });
    expect(created.statusCode).toBe(201);

    const phone = "919100000007";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-fixture-endpoint-sole", phone, name: "Runo Sole Endpoint Caller" }),
      headers: { "x-api-key": SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Sole Endpoint Caller")}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];
    const patient360 = await app.inject({ method: "GET", url: `/patients/${patient.id}/360`, cookies: { pulseos_session: adminCookie } });
    const { calls } = patient360.json() as Patient360;
    expect(calls[0].endpointLabel).toBe("Runo Sole Line");
  });

  it("does not guess an endpoint when the connector has more than one — ambiguous stays null", async () => {
    const second = await app.inject({
      method: "POST",
      url: `/connectors/${connectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100099002", providerRef: `runo-second-line-${RUN}`, displayLabel: "Runo Second Line" },
    });
    expect(second.statusCode).toBe(201);

    const phone = "919100000008";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/runo/${connectorId}`,
      payload: runoCallPayload({ callId: "call-fixture-endpoint-ambiguous", phone, name: "Runo Ambiguous Endpoint Caller" }),
      headers: { "x-api-key": SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Runo Ambiguous Endpoint Caller")}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];
    const patient360 = await app.inject({ method: "GET", url: `/patients/${patient.id}/360`, cookies: { pulseos_session: adminCookie } });
    const { calls } = patient360.json() as Patient360;
    expect(calls[0].endpointLabel).toBeNull();
  });
});
