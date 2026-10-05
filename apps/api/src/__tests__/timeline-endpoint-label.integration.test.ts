import { createHmac } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, TimelineEventVm } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const APP_SECRET = "FIXTURE_TEST_APP_SECRET";

function sign(rawBody: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
}

function metaMessagePayload(opts: { wamid: string; from: string; body: string; name: string; phoneNumberId: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "FIXTURE_WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: opts.phoneNumberId },
              contacts: [{ wa_id: opts.from, profile: { name: opts.name } }],
              messages: [{ id: opts.wamid, from: opts.from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: opts.body } }],
            },
          },
        ],
      },
    ],
  };
}

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

// Wave 3: the Timeline's "Communication" view interleaves calls and WhatsApp
// messages chronologically, but until now a TimelineEventVm carried no way
// to tell which hospital line/number handled a given communication — that
// context existed only on the CallVm/ConversationRow read models (Calls
// card, Conversations list), never on the Timeline event itself, even
// though both the `calls` and `conversations` tables already stamp a
// resolved communicationEndpointId at write time. This proves the Timeline
// event now surfaces that same, already-resolved label — not a new
// resolution path, just exposing what was already known.
describe.skipIf(!DEMO_PASSWORD)("Timeline endpointLabel (integration, fixture mode)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let connectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const whatsapp = (list.json() as ConnectorRow[]).find((c) => c.provider === "whatsapp_meta_cloud");
    connectorId = whatsapp!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("surfaces the resolved communication endpoint's display label on the conversation's Timeline line", async () => {
    // Unique per run — this connector's endpoint set is shared with other
    // suites/agents running concurrently against this dev DB, so a fixed
    // providerRef could collide with one they already created.
    const suffix = Date.now();
    const providerRef = `FIXTURE_TIMELINE_PHONE_${suffix}`;
    const displayLabel = `Timeline Fixture Line ${suffix}`;

    const createdEndpoint = await app.inject({
      method: "POST",
      url: `/connectors/${connectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "WHATSAPP", publicNumber: `+91910${String(suffix).slice(-7)}`, providerRef, displayLabel },
    });
    expect(createdEndpoint.statusCode).toBe(201);

    const wamid = `wamid.TIMELINE_FIXTURE_${suffix}`;
    const from = `919${String(suffix).slice(-9)}`;
    const name = `Timeline Endpoint Fixture ${suffix}`;
    const payload = metaMessagePayload({ wamid, from, body: "asking about the timeline endpoint label", name, phoneNumberId: providerRef });
    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${connectorId}`,
      payload: rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent(name)}`, cookies: { pulseos_session: adminCookie } });
    const rows = patients.json() as { id: string; name: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const patient = rows[0];

    const timeline = await app.inject({ method: "GET", url: `/patients/${patient.id}/timeline`, cookies: { pulseos_session: adminCookie } });
    expect(timeline.statusCode).toBe(200);
    const events = timeline.json() as TimelineEventVm[];
    // One concise line per conversation session — no per-message events.
    expect(events.filter((e) => e.eventType === "whatsapp_message")).toHaveLength(0);
    const messageEvent = events.find((e) => e.eventType === "whatsapp_conversation");
    expect(messageEvent).toBeDefined();
    expect(messageEvent!.endpointLabel).toBe(displayLabel);
  });

  it("leaves endpointLabel null on a Timeline event whose related conversation has no resolved endpoint", async () => {
    const suffix = Date.now() + 1;
    const wamid = `wamid.TIMELINE_NOENDPOINT_${suffix}`;
    const from = `919${String(suffix).slice(-9)}`;
    const name = `Timeline No Endpoint Fixture ${suffix}`;
    const payload = metaMessagePayload({ wamid, from, body: "no endpoint configured for this number", name, phoneNumberId: `UNREGISTERED_${suffix}` });
    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${connectorId}`,
      payload: rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) },
    });
    expect(res.statusCode).toBe(200);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent(name)}`, cookies: { pulseos_session: adminCookie } });
    const patient = (patients.json() as { id: string }[])[0];

    const timeline = await app.inject({ method: "GET", url: `/patients/${patient.id}/timeline`, cookies: { pulseos_session: adminCookie } });
    const events = timeline.json() as TimelineEventVm[];
    const messageEvent = events.find((e) => e.eventType === "whatsapp_conversation");
    expect(messageEvent).toBeDefined();
    expect(messageEvent!.endpointLabel).toBeNull();
  });
});
