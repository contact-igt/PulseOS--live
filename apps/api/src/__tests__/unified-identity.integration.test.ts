import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { patients } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, CreateLeadResult, CreatePatientResult, Lookups } from "@pulseos/types";

// Group D: manual Add Patient, manual Add Lead, and the WhatsApp webhook all
// resolve identity through the one shared path (identity.service.ts). This
// suite proves that end to end across all three real entry points, not just
// unit-testing normalizePhone in isolation — the same real person, contacted
// through three different formats/channels, must resolve to exactly one
// Patient row.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const APP_SECRET = "FIXTURE_TEST_APP_SECRET";

function sign(rawBody: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
}

function metaMessagePayload(opts: { wamid: string; from: string; body: string; name?: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "FIXTURE_WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "FIXTURE_PHONE_NUMBER_ID" },
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

describe.skipIf(!DEMO_PASSWORD)("unified identity resolution across entry points (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let branchId: string;
  let tenantId: string;
  let whatsappConnectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");

    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: adminCookie } });
    branchId = (lookups.json() as Lookups).branches[0].id;

    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const whatsapp = (list.json() as ConnectorRow[]).find((c) => c.provider === "whatsapp_meta_cloud")!;
    whatsappConnectorId = whatsapp.id;

    // Tenant comes from the session, never a global connector lookup — more than one tenant owns a WhatsApp connector.
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: adminCookie } });
    tenantId = (session.json() as { user: { tenantId: string } }).user.tenantId;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("the same phone number in three different formats, across Add Patient / Add Lead / WhatsApp webhook, resolves to one Patient", async () => {
    // A fresh, random 10-digit Indian mobile number so this test never
    // collides with seed data or a prior run.
    const digits = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    const formatA = digits; // as Add Patient would receive it: bare digits
    const formatB = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`; // as Add Lead would receive it: spaced, with country code
    const formatC = `91${digits}`; // as the WhatsApp webhook sends it: E.164 digits, no "+"

    const patientRes = await app.inject({
      method: "POST",
      url: "/patients",
      cookies: { pulseos_session: adminCookie },
      payload: { name: "Unified Identity Test Subject", phone: formatA, branchId },
    });
    expect(patientRes.statusCode).toBe(201);
    const created = patientRes.json() as CreatePatientResult;
    expect(created.isNewPatient).toBe(true);

    const leadRes = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: adminCookie },
      payload: {
        name: "Unified Identity Test Subject (lead form)",
        phone: formatB,
        specialtyKey: "GYNECOLOGY",
        branchId,
        source: "website",
        journeyType: "Gynecology Consultation",
      },
    });
    expect(leadRes.statusCode).toBe(201);
    const lead = leadRes.json() as CreateLeadResult;
    // The critical assertion: a different phone format through a completely
    // different entry point must NOT create a second Patient.
    expect(lead.isNewPatient).toBe(false);
    expect(lead.patientId).toBe(created.patientId);

    const webhookBody = JSON.stringify(metaMessagePayload({ wamid: `wamid.unified-identity-${digits}`, from: formatC, body: "Hi, I have a question" }));
    const webhookRes = await app.inject({
      method: "POST",
      url: `/webhooks/whatsapp/${whatsappConnectorId}`,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(webhookBody) },
      payload: webhookBody,
    });
    expect(webhookRes.statusCode).toBe(200);

    // Still exactly one Patient row for this phone number across all three
    // entry points and formats.
    const rows = await db.select({ id: patients.id }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.phoneE164, `+91${digits}`)));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.patientId);
  });
});
