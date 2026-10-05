import { createHmac } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, connectors, marketingCampaigns } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, PatientListRow } from "@pulseos/types";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded
// PulseOS dev DB (the meta_lead_ads ACQUISITION connector, fixture mode,
// is seed data) and DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const APP_SECRET = "FIXTURE_TEST_APP_SECRET";

function sign(rawBody: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
}

function leadgenPayload(leadgenId: string, formId = "FORM_1") {
  return {
    object: "page",
    entry: [{
      id: "FIXTURE_PAGE_ID",
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: "leadgen",
        value: { leadgen_id: leadgenId, page_id: "FIXTURE_PAGE_ID", form_id: formId, adgroup_id: "ADSET_1", ad_id: "AD_1", created_time: Math.floor(Date.now() / 1000) },
      }],
    }],
  };
}

describe.skipIf(!DEMO_PASSWORD)("Meta Lead Ads webhook (Group AD, fixture mode) — integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let connectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    adminCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    connectorId = (list.json() as ConnectorRow[]).find((c) => c.provider === "meta_lead_ads")!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("GET verification returns the challenge when the token matches", async () => {
    const res = await app.inject({ method: "GET", url: `/webhooks/meta-lead-ads/${connectorId}?hub.mode=subscribe&hub.verify_token=pulseos-fixture-verify-token&hub.challenge=abc123` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc123");
  });

  it("GET verification rejects a wrong token with 403", async () => {
    const res = await app.inject({ method: "GET", url: `/webhooks/meta-lead-ads/${connectorId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123` });
    expect(res.statusCode).toBe(403);
  });

  it("POST rejects a request with a missing/invalid signature", async () => {
    const rawBody = JSON.stringify(leadgenPayload(`LEAD_${Date.now()}`));
    const res = await app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: rawBody, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("a valid leadgen notification fetches the fixture lead and creates a Patient/Journey/touchpoint preserving form/ad-set/ad/lead ids", async () => {
    const leadgenId = `LEAD_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const rawBody = JSON.stringify(leadgenPayload(leadgenId, "FORM_FERTILITY"));
    const headers = { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) };

    const res = await app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: rawBody, headers });
    expect(res.statusCode).toBe(200);

    const patientsRes = await app.inject({ method: "GET", url: "/patients", cookies: { pulseos_session: adminCookie } });
    const patients = patientsRes.json() as PatientListRow[];
    // Fixture lead name is deterministic from the leadgen_id.
    const fixtureName = patients.find((p) => p.name.includes("Fixture Meta Lead"));
    expect(fixtureName).toBeTruthy();

    const [touchpoint] = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadgenId));
    expect(touchpoint).toBeTruthy();
    expect(touchpoint.source).toBe("meta");
    expect(touchpoint.externalFormId).toBe("FORM_FERTILITY");
    expect(touchpoint.externalAdGroupId).toBe("ADSET_1");
    expect(touchpoint.externalAdId).toBe("AD_1");
    expect(touchpoint.touchType).toBe("first_touch");

    // The campaign this webhook auto-created must be traceable to this
    // FIXTURE connector — never left with no mode context at all, which
    // would read ambiguously on the Campaigns/Sources UI (Group AJ).
    expect(touchpoint.campaignId).toBeTruthy();
    const [campaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, touchpoint.campaignId!));
    expect(campaign.connectorId).toBe(connectorId);
  });

  it("a duplicate delivery of the same leadgen_id is idempotent — no second Patient/touchpoint is created", async () => {
    const leadgenId = `LEAD_DUP_${Date.now()}`;
    const rawBody = JSON.stringify(leadgenPayload(leadgenId));
    const headers = { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) };

    const first = await app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: rawBody, headers });
    const second = await app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: rawBody, headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadgenId));
    expect(touchpoints.length).toBe(1);
  });

  it("a DISABLED connector safely no-ops (200, nothing processed)", async () => {
    await db.update(connectors).set({ status: "DISABLED" }).where(eq(connectors.id, connectorId));
    const leadgenId = `LEAD_DISABLED_${Date.now()}`;
    const rawBody = JSON.stringify(leadgenPayload(leadgenId));
    const res = await app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: rawBody, headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) } });
    expect(res.statusCode).toBe(200);

    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadgenId));
    expect(touchpoints.length).toBe(0);
    await db.update(connectors).set({ status: "CONNECTED" }).where(eq(connectors.id, connectorId));
  });
});
