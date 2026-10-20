import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectorEvents, connectorSecrets } from "../db/schema.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";
const SECRET = "super-secret-webhook-value-123";

describe("platform integrations view (integration)", () => {
  let app: FastifyInstance;
  let auditor: TestPlatformUser;
  let t: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    auditor = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD);
    t = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD, { webhookSecret: SECRET, connectorMode: "LIVE" });
    await db.insert(connectorEvents).values({ tenantId: t.tenantId, connectorId: t.connectorId, externalEventId: `evt-${t.connectorId}`, direction: "inbound", status: "processed", payload: { patient: "Fictional Person", recording: t.recordingUrl } });
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  const get = (url: string) => app.inject({ method: "GET", url, cookies: asPlatform(auditor.cookie) });

  it("shows every tenant's connectors with separate enabled / configured / credential / health facts and no secret", async () => {
    const res = await get(`/platform/integrations?tenantId=${t.tenantId}`);
    expect(res.statusCode).toBe(200);
    const runo = res.json().rows.find((r: { connector: string }) => r.connector === "runo");
    expect(runo).toMatchObject({ tenantId: t.tenantId, enabled: true, credentialState: "SAVED" });
    expect(runo).toHaveProperty("configuration");
    expect(runo).toHaveProperty("health");
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain(SECRET);
    const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, t.connectorId));
    expect(raw).not.toContain(secret!.encryptedPayload.slice(0, 24));
  });

  it("filters by connector and by health bucket on the server", async () => {
    const res = await get(`/platform/integrations?connector=runo&pageSize=100`);
    expect(res.json().rows.every((r: { connector: string }) => r.connector === "runo")).toBe(true);
    expect(res.json().connectors.map((c: { key: string }) => c.key)).toContain("ccs_ivr");
  });

  it("an unreadable credential is reported as such and needs attention", async () => {
    await db.update(connectorSecrets).set({ encryptedPayload: "not-a-valid-ciphertext" }).where(eq(connectorSecrets.connectorId, t.connectorId));
    const res = await get(`/platform/integrations?tenantId=${t.tenantId}&bucket=attention`);
    const runo = res.json().rows.find((r: { connector: string }) => r.connector === "runo");
    expect(runo).toMatchObject({ credentialState: "UNREADABLE" });
    expect(runo.attention).toMatch(/cannot be read/);
  });

  it("the connector support view shows state, mappings and safe event metadata, never payloads or recording links", async () => {
    const res = await get(`/platform/tenants/${t.tenantId}/integrations/runo`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recentEvents[0]).toMatchObject({ status: "processed", direction: "inbound" });
    expect(body.recordings).toMatchObject({ calls: 1, withRecording: 1 });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("Fictional Person");
    expect(raw).not.toContain(t.recordingUrl);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/payload/i);
    expect(body.secretFields.every((f: Record<string, unknown>) => Object.keys(f).sort().join() === "key,label,saved")).toBe(true);
  });

  it("refuses tenant sessions and unknown connectors", async () => {
    expect((await app.inject({ method: "GET", url: "/platform/integrations", cookies: { pulseos_session: t.cookie.SUPER_ADMIN! } })).statusCode).toBe(401);
    expect((await get(`/platform/tenants/${t.tenantId}/integrations/not_real`)).statusCode).toBe(404);
  });
});
