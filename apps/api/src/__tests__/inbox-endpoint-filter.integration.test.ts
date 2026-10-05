import { createHmac } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, ConversationRow, CommunicationEndpointVm } from "@pulseos/types";

// Wave 3: the Inbox conversation LIST needs to filter by which hospital line
// (CommunicationEndpoint) a conversation came in on — see
// apps/web/app/(app)/inbox/page.tsx and listConversations in
// conversation.service.ts. This proves the new `communicationEndpointId`
// query param on GET /conversations actually narrows results to one line,
// using two distinct endpoints on the same WhatsApp connector (the same
// "N numbers per 1 connector" shape whatsapp-webhook.integration.test.ts
// already exercises for a single endpoint).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const APP_SECRET = "FIXTURE_TEST_APP_SECRET";

function sign(rawBody: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
}

function metaMessagePayload(opts: { wamid: string; from: string; body: string; name?: string; phoneNumberId: string }) {
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
              contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? "Test Contact" } }],
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

describe.skipIf(!DEMO_PASSWORD)("Inbox conversation list — filter by communication endpoint (line)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let connectorId: string;
  let endpointAId: string;
  let endpointBId: string;
  let convoAId: string;
  let convoBId: string;

  const suffix = Date.now();
  const providerRefA = `FIXTURE_ENDPOINT_FILTER_A_${suffix}`;
  const providerRefB = `FIXTURE_ENDPOINT_FILTER_B_${suffix}`;
  const patientNameA = `Endpoint Filter Patient A ${suffix}`;
  const patientNameB = `Endpoint Filter Patient B ${suffix}`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");

    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const whatsapp = (list.json() as ConnectorRow[]).find((c) => c.provider === "whatsapp_meta_cloud");
    connectorId = whatsapp!.id;

    const endpointA = await app.inject({
      method: "POST",
      url: `/connectors/${connectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "WHATSAPP", publicNumber: "+911234500001", providerRef: providerRefA, displayLabel: `Filter Test Line A ${suffix}` },
    });
    endpointAId = (endpointA.json() as CommunicationEndpointVm).id;

    const endpointB = await app.inject({
      method: "POST",
      url: `/connectors/${connectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "WHATSAPP", publicNumber: "+911234500002", providerRef: providerRefB, displayLabel: `Filter Test Line B ${suffix}` },
    });
    endpointBId = (endpointB.json() as CommunicationEndpointVm).id;

    const fromA = `919${String(Date.now()).slice(-9)}`;
    const payloadA = metaMessagePayload({ wamid: `wamid.FILTER_A_${suffix}`, from: fromA, body: "hello on line A", name: patientNameA, phoneNumberId: providerRefA });
    const rawBodyA = JSON.stringify(payloadA);
    await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${connectorId}`,
      payload: rawBodyA,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBodyA) },
    });

    const fromB = `919${String(Date.now() + 1).slice(-9)}`;
    const payloadB = metaMessagePayload({ wamid: `wamid.FILTER_B_${suffix}`, from: fromB, body: "hello on line B", name: patientNameB, phoneNumberId: providerRefB });
    const rawBodyB = JSON.stringify(payloadB);
    await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${connectorId}`,
      payload: rawBodyB,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBodyB) },
    });

    const conversations = await app.inject({ method: "GET", url: "/conversations?channel=WHATSAPP", cookies: { pulseos_session: adminCookie } });
    const rows = conversations.json() as ConversationRow[];
    const convoA = rows.find((c) => c.patientName === patientNameA);
    const convoB = rows.find((c) => c.patientName === patientNameB);
    convoAId = convoA!.id;
    convoBId = convoB!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("sanity check: both fixture conversations exist with distinct resolved endpoint labels, unfiltered", async () => {
    expect(convoAId).toBeTruthy();
    expect(convoBId).toBeTruthy();
    const conversations = await app.inject({ method: "GET", url: "/conversations?channel=WHATSAPP", cookies: { pulseos_session: adminCookie } });
    const rows = conversations.json() as ConversationRow[];
    const convoA = rows.find((c) => c.id === convoAId);
    const convoB = rows.find((c) => c.id === convoBId);
    expect(convoA!.endpointLabel).toBe(`Filter Test Line A ${suffix}`);
    expect(convoB!.endpointLabel).toBe(`Filter Test Line B ${suffix}`);
  });

  it("filtering by endpoint A's id returns conversation A but not conversation B", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/conversations?channel=WHATSAPP&communicationEndpointId=${endpointAId}`,
      cookies: { pulseos_session: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as ConversationRow[];
    expect(rows.some((c) => c.id === convoAId)).toBe(true);
    expect(rows.some((c) => c.id === convoBId)).toBe(false);
    for (const row of rows) {
      if (row.id === convoAId) expect(row.endpointLabel).toBe(`Filter Test Line A ${suffix}`);
    }
  });

  it("filtering by endpoint B's id returns conversation B but not conversation A", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/conversations?channel=WHATSAPP&communicationEndpointId=${endpointBId}`,
      cookies: { pulseos_session: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as ConversationRow[];
    expect(rows.some((c) => c.id === convoBId)).toBe(true);
    expect(rows.some((c) => c.id === convoAId)).toBe(false);
  });

  it("omitting the filter still returns both conversations", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations?channel=WHATSAPP", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as ConversationRow[];
    expect(rows.some((c) => c.id === convoAId)).toBe(true);
    expect(rows.some((c) => c.id === convoBId)).toBe(true);
  });
});
