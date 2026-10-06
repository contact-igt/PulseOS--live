import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AdsAnalytics, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { syncAds, syncDueAds } from "../domain/ads/ads-sync.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// Ads connectors read their credentials the same way the Integrations screen does. If the server's encryption key is
// missing or has changed, that is a configuration fault with a specific answer: never an anonymous 500, never a crashed
// scheduler tick that starves every other hospital. Synthetic values only.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("ads connectors with unusable encryption (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  const call = (role: Role, method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const withKey = async (value: string | undefined, fn: () => Promise<void>) => {
    const original = process.env.CONNECTOR_ENCRYPTION_KEY;
    if (value === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = value;
    try {
      await fn();
    } finally {
      if (original === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
      else process.env.CONNECTOR_ENCRYPTION_KEY = original;
    }
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const k of ["MARKETING_ANALYTICS", "GOOGLE_ADS"]) expect((await call("SUPER_ADMIN", "PUT", `/capabilities/${k}`, { enabled: true })).statusCode, k).toBe(200);
    expect((await call("SUPER_ADMIN", "PUT", "/integrations/hub/google_ads/configuration", {
      configuration: { customerId: "123-456-7890" },
      secrets: { developerToken: "synthetic-dev-token", clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret", refreshToken: "synthetic-refresh-token" },
      mode: "SANDBOX",
    })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("baseline: with the key that saved them, the credentials read as configured", async () => {
    const a = (await call("HOSPITAL_ADMIN", "GET", "/analytics/ads?range=30d")).json() as AdsAnalytics;
    expect(a.providers.find((p) => p.provider === "google_ads")!.setup).not.toBe("NOT_CONFIGURED");
  });

  for (const [label, key] of [["a missing encryption key", undefined], ["a changed encryption key", "a-different-key-than-the-one-that-saved-them"]] as const) {
    describe(label, () => {
      it("Marketing Analytics still answers (200) and reports the provider as not configured", async () => {
        await withKey(key, async () => {
          const res = await call("HOSPITAL_ADMIN", "GET", "/analytics/ads?range=30d");
          expect(res.statusCode).toBe(200);
          expect((res.json() as AdsAnalytics).providers.find((p) => p.provider === "google_ads")!.setup).toBe("NOT_CONFIGURED");
        });
      });

      it("Sync Now answers with a specific, safe code instead of an anonymous 500", async () => {
        await withKey(key, async () => {
          const res = await call("HOSPITAL_ADMIN", "POST", "/integrations/hub/google_ads/sync");
          expect(res.statusCode).toBe(key === undefined ? 503 : 409);
          expect(res.json()).toEqual({ error: key === undefined ? "encryption_not_configured" : "secrets_unreadable" });
          expect(res.body).not.toMatch(/synthetic-|CONNECTOR_ENCRYPTION_KEY/);
        });
      });

      it("the sync service reports the reason, and the scheduled tick skips the tenant instead of crashing", async () => {
        await withKey(key, async () => {
          const r = await syncAds(db, t.tenantId, "google_ads", { trigger: "MANUAL" });
          expect(r).toEqual({ ok: false, reason: key === undefined ? "encryption_not_configured" : "secrets_unreadable" });
          await expect(syncDueAds(db, new Date(Date.now() + 10 * 3_600_000))).resolves.toBeDefined();
        });
      });
    });
  }
});
