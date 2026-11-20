import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, connectors, connectorSecrets, hospitalLifecycleAudit, marketingCampaigns, platformAccounts, platformSessions, suspendedMetaLeads, tenants } from "../db/schema.js";
import { digest } from "../domain/tenant/hospital-onboarding.service.js";
import { getAcquisitionAdapter } from "../domain/connector/registry.js";
import { submitWhileActive } from "../domain/tenant/hospital-lifecycle.policy.js";
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

  it("holds authenticated page-bound references, deduplicates and explicitly replays at most five", async () => {
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, connector!.tenantId));
    const [credential] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId));
    expect(credential).toBeDefined();
    const [superAdmin, ops] = await db.insert(platformAccounts).values([
      { email: "replay-admin@example.test", role: "PLATFORM_SUPER_ADMIN", mfaSecret: "synthetic" },
      { email: "replay-ops@example.test", role: "PLATFORM_OPERATIONS_ADMIN", mfaSecret: "synthetic" },
    ]).returning();
    const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
    await db.insert(platformSessions).values([superAdmin!, ops!].map((row, index) => ({
      accountId: row.id, tokenHash: digest(tokens[index]!), expiresAt: new Date(Date.now() + 600_000),
    })));
    const replay = (index: number, target = tenant!.id, version = tenant!.lifecycleVersion) => app.inject({
      method: "POST", url: `/platform/hospitals/${target}/replay-held-meta-leads?legacy=1`,
      cookies: { pulseos_platform_session: tokens[index]! },
      headers: { origin: "http://localhost:3310", "x-pulseos-platform": "1" },
      payload: { version, approved: true },
    });
    const start = Date.now();
    const ids = Array.from({ length: 7 }, (_, i) => String(start + i * 1301));
    const deliver = (leadId: string, page = "123", signature = true) => {
      const body = leadgenPayload(leadId, "456");
      Object.assign(body.entry[0]!.changes[0]!.value, { page_id: page, adgroup_id: "789", ad_id: "987" });
      const raw = JSON.stringify(body);
      return app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: raw,
        headers: { "content-type": "application/json", "x-hub-signature-256": signature ? sign(raw) : "sha256=wrong" } });
    };
    try {
      await db.update(connectors).set({ configuration: { ...connector!.configuration as object, leadPageId: "123" } }).where(eq(connectors.id, connectorId));
      await db.update(tenants).set({ lifecycleStatus: "SUSPENDED", loginEnabled: false }).where(eq(tenants.id, tenant!.id));
      expect((await deliver(ids[0]!, "123", false)).statusCode).toBe(401);
      expect((await deliver(ids[0]!, "124")).statusCode).toBe(503);
      const mixed = leadgenPayload(ids[0]!, "456");
      const first = mixed.entry[0]!.changes[0]!;
      Object.assign(first.value, { page_id: "124", adgroup_id: "789", ad_id: "987" });
      mixed.entry[0]!.changes.push({ ...first, value: { ...first.value, page_id: "123", leadgen_id: ids[1]! } });
      const mixedRaw = JSON.stringify(mixed);
      const mixedResponse = await app.inject({
        method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: mixedRaw,
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(mixedRaw) },
      });
      expect(mixedResponse.statusCode).toBe(503);
      const mixedHeld = await db.select({ id: suspendedMetaLeads.externalLeadId }).from(suspendedMetaLeads)
        .where(eq(suspendedMetaLeads.tenantId, tenant!.id));
      expect(mixedHeld).toEqual([{ id: ids[1] }]);
      const accepted = await Promise.all([...ids.slice(0, 6), ids[0]!].map((id) => deliver(id)));
      expect(accepted.every((res) => res.statusCode === 200)).toBe(true);
      expect(await db.select().from(suspendedMetaLeads).where(eq(suspendedMetaLeads.tenantId, tenant!.id))).toHaveLength(6);
      expect(await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, ids[0]!))).toHaveLength(0);
      expect((await replay(0)).statusCode).toBe(409);
      expect((await replay(1)).statusCode).toBe(403);
      await db.update(tenants).set({ lifecycleStatus: "ACTIVE", loginEnabled: true }).where(eq(tenants.id, tenant!.id));
      const [other] = await queryClient`select id, lifecycle_version from tenants where id <> ${tenant!.id} and name = 'PulseOS Ophthalmology Demo'`;
      expect((await replay(0, other!.id, other!.lifecycle_version)).json()).toMatchObject({ processed: 0 });
      expect((await replay(0)).json()).toMatchObject({ processed: 5 });
      expect((await replay(0)).json()).toMatchObject({ processed: 1 });
      expect((await deliver(ids[0]!)).statusCode).toBe(200);
      expect(await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, ids[0]!))).toHaveLength(1);

      await db.update(tenants).set({ lifecycleStatus: "SUSPENDED", loginEnabled: false }).where(eq(tenants.id, tenant!.id));
      expect((await deliver(ids[6]!)).statusCode).toBe(200);
      await db.delete(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId));
      await db.update(tenants).set({ lifecycleStatus: "ACTIVE", loginEnabled: true }).where(eq(tenants.id, tenant!.id));
      expect((await replay(0)).json()).toMatchObject({ processed: 0, failed: 1 });
      expect((await replay(0)).json()).toMatchObject({ processed: 0, failed: 0 });
      await db.insert(connectorSecrets).values(credential!).onConflictDoNothing();
      await db.update(connectors).set({ configuration: { ...connector!.configuration as object, leadPageId: "124" } })
        .where(eq(connectors.id, connectorId));
      for (let attempt = 2; attempt <= 3; attempt++) {
        await db.update(suspendedMetaLeads).set({ nextAttemptAt: new Date(0) })
          .where(eq(suspendedMetaLeads.externalLeadId, ids[6]!));
        expect((await replay(0)).json()).toMatchObject({ processed: 0, failed: 1 });
      }
      await db.update(suspendedMetaLeads).set({ nextAttemptAt: new Date(0), expiresAt: new Date(Date.now() + 3_600_000) })
        .where(eq(suspendedMetaLeads.externalLeadId, ids[6]!));
      expect((await replay(0)).json()).toMatchObject({ processed: 0, failed: 0 });
      const operations = await app.inject({
        method: "GET", url: `/platform/hospitals/${tenant!.id}/lifecycle-operations?legacy=1`,
        cookies: { pulseos_platform_session: tokens[0]! },
        headers: { origin: "http://localhost:3310", "x-pulseos-platform": "1" },
      });
      expect(operations.json()).toMatchObject({ lifecycleStatus: "ACTIVE", lifecycleVersion: tenant!.lifecycleVersion,
        heldInbound: 1, exhaustedMetaLeads: 1, expiringMetaLeads: 1 });
      expect(await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, ids[6]!))).toHaveLength(0);
    } finally {
      await db.insert(connectorSecrets).values(credential!).onConflictDoNothing();
      await db.update(connectors).set({ configuration: connector!.configuration, status: connector!.status }).where(eq(connectors.id, connectorId));
      await db.update(tenants).set({ lifecycleStatus: tenant!.lifecycleStatus, loginEnabled: tenant!.loginEnabled }).where(eq(tenants.id, tenant!.id));
      await db.delete(suspendedMetaLeads).where(eq(suspendedMetaLeads.tenantId, tenant!.id));
      for (const actor of [superAdmin!, ops!]) {
        await db.delete(hospitalLifecycleAudit).where(eq(hospitalLifecycleAudit.actorId, actor.id));
        await db.delete(platformSessions).where(eq(platformSessions.accountId, actor.id));
        await db.delete(platformAccounts).where(eq(platformAccounts.id, actor.id));
      }
    }
  });

  it("lets suspension finish during Graph fetch and holds the reference on revalidation", async () => {
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    const tenantId = connector!.tenantId;
    const leadId = String(Date.now());
    const payload = leadgenPayload(leadId, "456");
    Object.assign(payload.entry[0]!.changes[0]!.value, { page_id: "123", adgroup_id: "789", ad_id: "987" });
    const raw = JSON.stringify(payload);
    const adapter = getAcquisitionAdapter("meta_lead_ads")!;
    const fetchLead = adapter.fetchLead!.bind(adapter);
    let started!: () => void;
    let release!: () => void;
    const startedFetch = new Promise<void>((resolve) => { started = resolve; });
    const releaseFetch = new Promise<void>((resolve) => { release = resolve; });
    const mock = vi.spyOn(adapter as { fetchLead: typeof fetchLead }, "fetchLead").mockImplementation(async (...args) => {
      started();
      await releaseFetch;
      return fetchLead(...args);
    });
    const delivery = app.inject({ method: "POST", url: `/webhooks/meta-lead-ads/${connectorId}`, payload: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) } }).then((result) => result);
    try {
      await Promise.race([startedFetch, delivery.then(() => { throw new Error("request finished before fetch"); })]);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.update(tenants).set({ lifecycleStatus: "SUSPENDED", loginEnabled: false }).where(eq(tenants.id, tenantId));
      });
      release();
      expect((await delivery).statusCode).toBe(200);
      expect(await db.select().from(suspendedMetaLeads).where(eq(suspendedMetaLeads.externalLeadId, leadId))).toHaveLength(1);
      expect(await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.externalLeadId, leadId))).toHaveLength(0);
    } finally {
      release();
      await delivery;
      mock.mockRestore();
      await db.update(tenants).set({ lifecycleStatus: "ACTIVE", loginEnabled: true }).where(eq(tenants.id, tenantId));
      await db.delete(suspendedMetaLeads).where(eq(suspendedMetaLeads.externalLeadId, leadId));
    }
  }, 15_000);

  it("orders suspension after admitted external submission and denies later submissions", async () => {
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    let entered!: () => void;
    const admission = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const send = submitWhileActive(db, connector!.tenantId, async () => { entered(); await hold; return "accepted"; });
    await admission;
    let finished = false;
    const suspend = db.update(tenants).set({ lifecycleStatus: "SUSPENDED", loginEnabled: false })
      .where(eq(tenants.id, connector!.tenantId)).then(() => { finished = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toBe(false);
      release();
      expect(await send).toEqual({ value: "accepted" });
      await suspend;
      expect(await submitWhileActive(db, connector!.tenantId, async () => { throw new Error("submitted while suspended"); })).toBeNull();
    } finally {
      release();
      await suspend;
      await db.update(tenants).set({ lifecycleStatus: "ACTIVE", loginEnabled: true }).where(eq(tenants.id, connector!.tenantId));
    }
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
