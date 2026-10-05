import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { IntegrationCard, IntegrationDetail, IntegrationLogRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectorEvents, outboundWebhookDeliveries } from "../db/schema.js";
import { deliverDueWebhooks, enqueueWebhookDeliveries, type WebhookFetch } from "../domain/integration/outbound-webhook.service.js";
import { emitIntegrationEvent } from "../domain/integration/domain-events.js";
import { verifyWebhookSignature } from "../domain/integration/webhook-rules.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { dueNow } from "./helpers/due-now.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("integration hub (integration)", () => {
  let app: FastifyInstance;
  let v1: TestTenant;
  let other: TestTenant;
  const call = (t: TestTenant, role: Role, method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const hub = async (t: TestTenant, role: Role) => (await call(t, role, "GET", "/integrations/hub")).json() as IntegrationCard[];

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_INSECURE = "true";
    app = await buildApp();
    await app.ready();
    v1 = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    delete process.env.WEBHOOK_ALLOW_INSECURE;
    for (const t of [v1, other]) await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("lists the catalogue by category with enabled, configuration, health and mode as separate facts", async () => {
    const cards = await hub(v1, "HOSPITAL_ADMIN");
    expect(cards.map((c) => c.key)).toEqual(["google_ads", "meta_ads", "runo", "ccs_ivr", "whatsapp_meta_cloud", "whatsnexus", "sms", "webhooks"]);
    const google = cards.find((c) => c.key === "google_ads")!;
    expect(google).toMatchObject({ category: "ADS", enabled: false, mode: "DISABLED", configuration: "NOT_CONFIGURED" }); // V1 default: off
    const wa = cards.find((c) => c.key === "whatsapp_meta_cloud")!;
    expect(wa).toMatchObject({ enabled: true, mode: "NOT_CONFIGURED", health: "UNKNOWN" }); // on, but nothing configured
    const runo = cards.find((c) => c.key === "runo")!;
    expect(runo.enabled).toBe(true);
    expect(runo.configuration).not.toBe("BLOCKED"); // Runo is preserved as the call provider
  });

  it("CCS IVR is active and can be configured with credentials and generates a webhook URL", async () => {
    const ccs = (await hub(v1, "SUPER_ADMIN")).find((c) => c.key === "ccs_ivr")!;
    expect(ccs).toMatchObject({ mode: "NOT_CONFIGURED", configuration: "NOT_CONFIGURED", blockedReason: null, canConfigure: true });
    const res = await call(v1, "SUPER_ADMIN", "PUT", "/integrations/hub/ccs_ivr/configuration", { configuration: { accountEmail: "admin@hospital.com" } });
    expect(res.statusCode).toBe(200);
    const detail = (await call(v1, "SUPER_ADMIN", "GET", "/integrations/hub/ccs_ivr")).json();
    expect(detail.webhookUrl).toMatch(/\/webhooks\/ccs\//);
  });

  it("an Admin sets operational configuration; secrets and mode are Super Admin only (refused, not stripped)", async () => {
    expect((await call(v1, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "pn-1" } })).statusCode).toBe(200);
    const denied = await call(v1, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { secrets: { accessToken: "SHOULD-NOT-SAVE" } });
    expect(denied.statusCode).toBe(403);
    expect((await call(v1, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { mode: "LIVE" })).statusCode).toBe(403);
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) {
      expect((await call(v1, role, "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "x" } })).statusCode, role).toBe(403);
    }
  });

  it("secrets are stored encrypted and never returned: only hasSecret", async () => {
    const put = await call(v1, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { secrets: { accessToken: "EAAB-super-secret-token-value-1234567890", appSecret: "app-secret-xyz", webhookVerifyToken: "verify-me" } });
    expect(put.statusCode).toBe(200);
    for (const body of [put.body, (await call(v1, "SUPER_ADMIN", "GET", "/integrations/hub/whatsapp_meta_cloud")).body, (await call(v1, "HOSPITAL_ADMIN", "GET", "/integrations/hub/whatsapp_meta_cloud")).body, JSON.stringify(await hub(v1, "SUPER_ADMIN"))]) {
      expect(body).not.toContain("super-secret-token");
      expect(body).not.toContain("app-secret-xyz");
      expect(body).not.toContain("verify-me");
    }
    const detail = (await call(v1, "SUPER_ADMIN", "GET", "/integrations/hub/whatsapp_meta_cloud")).json() as IntegrationDetail;
    expect(detail.secretFields.every((f) => f.hasSecret)).toBe(true);
    expect(detail.configurationValues.phoneNumberId).toBe("pn-1");
    // Fully configured but not yet confirmed by the provider: honest "Fixture" (default mode), health unknown — never "connected".
    expect(detail).toMatchObject({ configuration: "CONFIGURED", health: "UNKNOWN", mode: "FIXTURE" });
  });

  it("a blank secret leaves the stored one untouched; unknown fields are refused", async () => {
    expect((await call(v1, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { secrets: { accessToken: "" } })).statusCode).toBe(200);
    expect(((await call(v1, "SUPER_ADMIN", "GET", "/integrations/hub/whatsapp_meta_cloud")).json() as IntegrationDetail).secretFields.find((f) => f.key === "accessToken")!.hasSecret).toBe(true);
    expect((await call(v1, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { notAField: "1" } })).statusCode).toBe(422);
    expect((await call(v1, "SUPER_ADMIN", "PUT", "/integrations/hub/nope/configuration", {})).statusCode).toBe(404);
  });

  it("switching the capability off disables the card but keeps configuration and health reported", async () => {
    expect((await call(v1, "HOSPITAL_ADMIN", "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: false })).statusCode).toBe(200);
    const wa = (await hub(v1, "HOSPITAL_ADMIN")).find((c) => c.key === "whatsapp_meta_cloud")!;
    expect(wa).toMatchObject({ enabled: false, mode: "DISABLED", configuration: "CONFIGURED" });
    await call(v1, "HOSPITAL_ADMIN", "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: null });
  });

  it("tenant isolation: another hospital's configuration is never visible", async () => {
    const wa = (await hub(other, "SUPER_ADMIN")).find((c) => c.key === "whatsapp_meta_cloud")!;
    expect(wa.configuration).toBe("NOT_CONFIGURED");
  });

  it("outbound webhooks: Super Admin only; https/public hosts only in production; secret shown once", async () => {
    for (const role of ["HOSPITAL_ADMIN", "FRONT_DESK", "DOCTOR"] as Role[]) {
      expect((await call(v1, role, "GET", "/integrations/webhooks")).statusCode, role).toBe(403);
      expect((await call(v1, role, "POST", "/integrations/webhooks", { name: "n", url: "https://example.org/h", events: ["lead.created"] })).statusCode, role).toBe(403);
    }
    delete process.env.WEBHOOK_ALLOW_INSECURE;
    try {
      expect((await call(v1, "SUPER_ADMIN", "POST", "/integrations/webhooks", { name: "n", url: "http://127.0.0.1/h", events: ["lead.created"] })).statusCode).toBe(422);
      expect((await call(v1, "SUPER_ADMIN", "POST", "/integrations/webhooks", { name: "n", url: "https://example.org/h", events: ["patient.exported"] })).statusCode).toBe(400);
    } finally {
      process.env.WEBHOOK_ALLOW_INSECURE = "true"; // restored even when an assertion above fails
    }
    const created = await call(v1, "SUPER_ADMIN", "POST", "/integrations/webhooks", { name: "CRM sync", url: "https://hooks.example.org/pulse", events: ["lead.created", "appointment.booked"], conditions: [{ field: "sourceKey", op: "eq", value: "google" }] });
    expect(created.statusCode).toBe(201);
    expect(created.json().signingSecret).toMatch(/^whsec_/);
    const list = await call(v1, "SUPER_ADMIN", "GET", "/integrations/webhooks");
    expect(list.body).not.toContain("whsec_");
    expect(list.json()[0]).toMatchObject({ name: "CRM sync", hasSecret: true });
  });

  it("delivers matching real events once, signed; conditions filter; failures retry then stop; other tenants never receive", async () => {
    const hooks = (await call(v1, "SUPER_ADMIN", "GET", "/integrations/webhooks")).json() as { id: string }[];
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ok: WebhookFetch = async (url, init) => { sent.push({ url, headers: init.headers, body: init.body }); return { status: 200 }; };
    const base = { tenantId: v1.tenantId, occurredAt: new Date("2026-10-02T05:00:00Z") };

    emitIntegrationEvent({ ...base, type: "lead.created", eventId: "lead.created:j-1", data: { journeyId: "j-1", sourceKey: "google" } });
    emitIntegrationEvent({ ...base, type: "lead.created", eventId: "lead.created:j-2", data: { journeyId: "j-2", sourceKey: "meta" } }); // condition fails
    emitIntegrationEvent({ ...base, type: "call.completed", eventId: "call.completed:c-1", data: { callId: "c-1" } }); // not subscribed
    emitIntegrationEvent({ ...base, tenantId: other.tenantId, type: "lead.created", eventId: "lead.created:j-9", data: { sourceKey: "google" } }); // other tenant
    await new Promise((r) => setTimeout(r, 400));
    // Repeating the same event never queues twice (idempotent).
    expect(await enqueueWebhookDeliveries(db, { ...base, type: "lead.created", eventId: "lead.created:j-1", data: { journeyId: "j-1", sourceKey: "google" } })).toBe(0);

    const first = await deliverDueWebhooks(db, dueNow(), ok);
    expect(first.sent).toBeGreaterThanOrEqual(1); // the dev DB may hold other hospitals' due deliveries; ours is the one asserted below
    expect(sent.filter((x) => x.url === "https://hooks.example.org/pulse")).toHaveLength(1);
    const ours = sent.filter((x) => x.url === "https://hooks.example.org/pulse");
    expect(ours[0]!.url).toBe("https://hooks.example.org/pulse");
    const body = JSON.parse(ours[0]!.body);
    expect(body).toMatchObject({ id: "lead.created:j-1", type: "lead.created", data: { sourceKey: "google" } });
    expect(ours[0]!.body).not.toContain(v1.tenantId); // no tenant id on the wire
    expect(ours[0]!.headers["x-pulseos-signature"]).toMatch(/^sha256=/);
    expect(verifyWebhookSignature("wrong", ours[0]!.headers["x-pulseos-timestamp"]!, ours[0]!.body, ours[0]!.headers["x-pulseos-signature"]!)).toBe(false);
    expect((await deliverDueWebhooks(db, dueNow(), ok)).sent).toBe(0); // already sent: never again

    // A failing receiver is retried a bounded number of times, then marked failed.
    emitIntegrationEvent({ ...base, type: "lead.created", eventId: "lead.created:j-3", data: { journeyId: "j-3", sourceKey: "google" } });
    await new Promise((r) => setTimeout(r, 600));
    const bad: WebhookFetch = async () => ({ status: 500 });
    let t = Date.now() + 5_000;
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(await deliverDueWebhooks(db, new Date(t), bad));
      t += 2 * 3_600_000;
    }
    expect(outcomes.map((o) => (o.retrying ? "retry" : o.failed ? "failed" : "none"))).toEqual(["retry", "retry", "retry", "failed"]);
    const [failed] = await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.eventId, "lead.created:j-3"));
    expect(failed).toMatchObject({ status: "FAILED", attempts: 4, responseStatus: 500 });
    expect(hooks).toHaveLength(1);
  });

  it("logs are redacted and filterable by provider, status and date; tenant scoped", async () => {
    const [{ id: connectorId }] = (await db.query.connectors.findMany({ where: (c, { and, eq: e }) => and(e(c.tenantId, v1.tenantId), e(c.provider, "runo")) })) as { id: string }[];
    await db.insert(connectorEvents).values([
      { tenantId: v1.tenantId, connectorId, externalEventId: "ev-ok", direction: "inbound", status: "processed", payload: { type: "call" } },
      { tenantId: v1.tenantId, connectorId, externalEventId: "ev-bad", direction: "inbound", status: "failed", error: "auth failed: access_token=EAABsecretsecretsecretsecret123 Bearer abc.def.ghi" },
    ]);
    const all = (await call(v1, "HOSPITAL_ADMIN", "GET", "/integrations/logs")).json() as IntegrationLogRow[];
    const bad = all.find((r) => r.status === "failed" && r.provider === "runo")!;
    expect(bad.error).toContain("[redacted]");
    expect(JSON.stringify(all)).not.toContain("secretsecret");
    expect(JSON.stringify(all)).not.toContain("abc.def.ghi");
    expect(((await call(v1, "HOSPITAL_ADMIN", "GET", "/integrations/logs?provider=runo&status=failed")).json() as IntegrationLogRow[]).every((r) => r.provider === "runo" && r.status === "failed")).toBe(true);
    expect(((await call(v1, "HOSPITAL_ADMIN", "GET", "/integrations/logs?provider=webhooks")).json() as IntegrationLogRow[]).every((r) => r.provider === "webhooks")).toBe(true);
    expect(((await call(v1, "HOSPITAL_ADMIN", "GET", "/integrations/logs?from=2020-01-01&to=2020-01-02")).json() as IntegrationLogRow[])).toHaveLength(0);
    expect(((await call(other, "HOSPITAL_ADMIN", "GET", "/integrations/logs")).json() as IntegrationLogRow[])).toHaveLength(0);
  });
});
