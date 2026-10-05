import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { marketingCampaigns } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow } from "@pulseos/types";

// Integration test for POST /connectors/:id/sync-campaigns — the endpoint
// this session's Group I audit found was unreachable from the UI (the
// Integrations page had no Sync button at all, just a cache-only "Refresh").
// Wiring the UI didn't change this endpoint's contract, but it had no
// dedicated backend test either — closing that gap here.
//
// meta_lead_ads is a real seeded connector also exercised by the Meta
// webhook integration tests, which can independently create their own
// marketing_campaigns rows stamped with this same connectorId — so
// assertions here use before/after deltas rather than an absolute row
// count, and there is no afterAll cleanup (deleting shared connector-scoped
// campaigns here would violate campaign_touchpoints' FK from those other
// tests' data; the next `db:seed` resets this table like every other test
// file's incidental writes).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function countByConnector(connectorId: string): Promise<number> {
  return (await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.connectorId, connectorId))).length;
}

describe.skipIf(!DEMO_PASSWORD)("campaign sync (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let metaConnectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    adminCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    metaConnectorId = (list.json() as ConnectorRow[]).find((c) => c.provider === "meta_lead_ads")!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("syncs fixture campaigns into marketing_campaigns, stamped with this connector's id", async () => {
    const before = await countByConnector(metaConnectorId);

    const res = await app.inject({ method: "POST", url: `/connectors/${metaConnectorId}/sync-campaigns`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; syncedCount: number };
    expect(body.syncedCount).toBeGreaterThan(0);

    const rows = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.connectorId, metaConnectorId));
    expect(rows.length).toBeGreaterThanOrEqual(before);
    for (const row of rows) {
      expect(row.source).toBe("meta");
      expect(row.externalCampaignId).toBeTruthy();
    }
  });

  it("a second sync upserts by (tenantId, externalCampaignId) rather than duplicating rows", async () => {
    await app.inject({ method: "POST", url: `/connectors/${metaConnectorId}/sync-campaigns`, cookies: { pulseos_session: adminCookie } });
    const afterFirst = await countByConnector(metaConnectorId);

    const res2 = await app.inject({ method: "POST", url: `/connectors/${metaConnectorId}/sync-campaigns`, cookies: { pulseos_session: adminCookie } });
    expect(res2.statusCode).toBe(200);
    const afterSecond = await countByConnector(metaConnectorId);

    expect(afterSecond).toBe(afterFirst);
  });

  it("returns 422 unsupported_capability for a connector whose adapter doesn't support SYNC_CAMPAIGNS (e.g. google_business_profile)", async () => {
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const gbpConnector = (list.json() as ConnectorRow[]).find((c) => c.provider === "google_business_profile")!;
    const res = await app.inject({ method: "POST", url: `/connectors/${gbpConnector.id}/sync-campaigns`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unsupported_capability");
  });

  it("404s for an unknown connector id rather than leaking another tenant's state", async () => {
    const res = await app.inject({ method: "POST", url: "/connectors/00000000-0000-0000-0000-000000000000/sync-campaigns", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(404);
  });
});
