import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { gbpPerformanceMetrics, patients } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow } from "@pulseos/types";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded
// PulseOS dev DB (the google_business_profile ACQUISITION connector,
// fixture mode, is seed data) and DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("Google Business Profile performance sync (Group AH) — integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let gbpConnectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    adminCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    gbpConnectorId = (list.json() as ConnectorRow[]).find((c) => c.provider === "google_business_profile")!.id;
  });

  afterAll(async () => {
    await db.delete(gbpPerformanceMetrics).where(eq(gbpPerformanceMetrics.connectorId, gbpConnectorId));
    await app.close();
    await queryClient.end();
  });

  it("syncs fixture aggregate metrics into gbp_performance_metrics", async () => {
    const patientCountBefore = (await db.select().from(patients)).length;

    const res = await app.inject({ method: "POST", url: `/connectors/${gbpConnectorId}/sync-performance`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; syncedCount: number };
    expect(body.syncedCount).toBeGreaterThan(0);

    const rows = await db.select().from(gbpPerformanceMetrics).where(eq(gbpPerformanceMetrics.connectorId, gbpConnectorId));
    expect(rows.length).toBe(body.syncedCount);
    for (const row of rows) {
      expect(row.searchImpressions).toBeGreaterThan(0);
      expect(row.websiteClicks).toBeGreaterThanOrEqual(0);
      expect(row.callClicks).toBeGreaterThanOrEqual(0);
    }

    // The core rule: aggregate performance sync NEVER creates a Patient,
    // no matter how large the metric values are.
    const patientCountAfter = (await db.select().from(patients)).length;
    expect(patientCountAfter).toBe(patientCountBefore);
  });

  it("a second sync upserts by (connectorId, metricDate) rather than duplicating rows", async () => {
    await app.inject({ method: "POST", url: `/connectors/${gbpConnectorId}/sync-performance`, cookies: { pulseos_session: adminCookie } });
    const res2 = await app.inject({ method: "POST", url: `/connectors/${gbpConnectorId}/sync-performance`, cookies: { pulseos_session: adminCookie } });
    expect(res2.statusCode).toBe(200);

    const rows = await db.select().from(gbpPerformanceMetrics).where(eq(gbpPerformanceMetrics.connectorId, gbpConnectorId));
    const uniqueDates = new Set(rows.map((r) => r.metricDate.toISOString()));
    expect(rows.length).toBe(uniqueDates.size);
  });

  it("returns 422 unsupported_capability for a connector whose adapter doesn't support SYNC_PERFORMANCE (e.g. website form)", async () => {
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const websiteConnector = (list.json() as ConnectorRow[]).find((c) => c.provider === "website_form")!;
    const res = await app.inject({ method: "POST", url: `/connectors/${websiteConnector.id}/sync-performance`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(422);
  });
});
