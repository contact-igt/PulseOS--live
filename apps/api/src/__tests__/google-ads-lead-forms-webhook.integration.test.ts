import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, connectors, marketingCampaigns, patients } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow } from "@pulseos/types";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded
// PulseOS dev DB (the google_ads_lead_forms ACQUISITION connector, fixture
// mode, is seed data) and DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const GOOGLE_KEY = "pulseos-fixture-google-key";

function leadPayload(leadId: string, phone: string, overrides: Record<string, unknown> = {}) {
  return {
    lead_id: leadId,
    api_version: "1.0",
    form_id: "FORM_G_1",
    campaign_id: "CAMPAIGN_G_1",
    adgroup_id: "ADGROUP_G_1",
    gcl_id: `gclid-${leadId}`,
    google_key: GOOGLE_KEY,
    is_test: false,
    lead_submit_time: new Date().toISOString(),
    user_column_data: [
      { column_id: "FULL_NAME", string_value: "Google Lead Test Patient" },
      { column_id: "PHONE_NUMBER", string_value: phone },
      { column_id: "EMAIL", string_value: "googlelead.test@example.com" },
    ],
    ...overrides,
  };
}

describe.skipIf(!DEMO_PASSWORD)("Google Ads Lead Forms webhook (Group AE, fixture mode) — integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let connectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    adminCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    connectorId = (list.json() as ConnectorRow[]).find((c) => c.provider === "google_ads_lead_forms")!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects a request with a wrong google_key with 400 (non-retryable per Google's own contract)", async () => {
    const res = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: leadPayload("LEAD_BADKEY", "+919876500001", { google_key: "wrong" }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: "invalid_google_key" });
  });

  it("a valid lead creates a Patient/Journey/touchpoint preserving campaign/ad-group/gclid, and responds 200 {}", async () => {
    const phone = `+91 9${String(Date.now()).slice(-9)}`;
    const leadId = `LEAD_${Date.now()}`;
    const res = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: leadPayload(leadId, phone) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    const [touchpoint] = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadId));
    expect(touchpoint).toBeTruthy();
    expect(touchpoint.source).toBe("google");
    expect(touchpoint.externalCampaignId).toBe("CAMPAIGN_G_1");
    expect(touchpoint.externalAdGroupId).toBe("ADGROUP_G_1");
    expect(touchpoint.gclid).toBe(`gclid-${leadId}`);
    expect(touchpoint.touchType).toBe("first_touch");

    // Traceable to this FIXTURE connector, same rule as Meta's adapter.
    const [campaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, touchpoint.campaignId!));
    expect(campaign.connectorId).toBe(connectorId);

    const [patient] = await db.select().from(patients).where(eq(patients.id, touchpoint.patientId));
    expect(patient.name).toBe("Google Lead Test Patient");
  });

  it("a duplicate delivery of the same lead_id is idempotent", async () => {
    const phone = `+91 9${String(Date.now() + 1).slice(-9)}`;
    const leadId = `LEAD_DUP_${Date.now()}`;
    const body = leadPayload(leadId, phone);
    const first = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: body });
    const second = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: body });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadId));
    expect(touchpoints.length).toBe(1);
  });

  it("a repeated enquiry from an existing patient (already in PulseOS from a prior lead) attaches to their still-open journey as an additional touch, not a new Patient", async () => {
    const phone = `+91 9${String(Date.now() + 2).slice(-9)}`;
    const first = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: leadPayload(`LEAD_A_${Date.now()}`, phone) });
    const second = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: leadPayload(`LEAD_B_${Date.now()}`, phone) });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const allPatients = await db.select().from(patients).where(eq(patients.phone, phone));
    expect(allPatients.length).toBe(1);

    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.patientId, allPatients[0].id));
    expect(touchpoints.length).toBe(2);
    expect(touchpoints.filter((t) => t.journeyId === touchpoints[0].journeyId).length).toBe(2); // same journey
  });

  it("tenant isolation: an unknown connector id safely no-ops (200, nothing processed) rather than leaking connector existence", async () => {
    const res = await app.inject({ method: "POST", url: "/webhooks/google-ads-lead-forms/00000000-0000-0000-0000-000000000000", payload: leadPayload("LEAD_UNKNOWN", "+919876500099") });
    expect(res.statusCode).toBe(200);
    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, "LEAD_UNKNOWN"));
    expect(touchpoints.length).toBe(0);
  });

  it("a DISABLED connector safely no-ops", async () => {
    await db.update(connectors).set({ status: "DISABLED" }).where(eq(connectors.id, connectorId));
    const leadId = `LEAD_DISABLED_${Date.now()}`;
    const res = await app.inject({ method: "POST", url: `/webhooks/google-ads-lead-forms/${connectorId}`, payload: leadPayload(leadId, "+919876500098") });
    expect(res.statusCode).toBe(200);
    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadId));
    expect(touchpoints.length).toBe(0);
    await db.update(connectors).set({ status: "CONNECTED" }).where(eq(connectors.id, connectorId));
  });
});
