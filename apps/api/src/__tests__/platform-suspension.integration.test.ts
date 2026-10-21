import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { calls, connectorSecrets, connectors, notificationRules, notifications, outboundWebhookDeliveries, outboundWebhooks, platformAuditEvents, scheduleResources, tenantCapabilities, tenants, users } from "../db/schema.js";
import { getMessagingAdapter } from "../domain/connector/registry.js";
import { deliverDueWebhooks } from "../domain/integration/outbound-webhook.service.js";
import { processDueNotifications } from "../domain/notification/notification.service.js";
import { outboundDecision } from "../domain/platform/outbound-policy.js";
import { encryptSecret } from "../domain/security/encryption.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const RUNO_SECRET = "suspension-runo-secret";
const CCS_KEY = "suspension-ccs-api-key";

// SUSPENDED != DELETED. A suspended tenant: no client sign-in, no client session, every inbound integration still recorded
// (no enquiry is lost), every AUTOMATED outbound message paused - derived from the lifecycle, never by editing settings.

describe.skipIf(!DEMO_PASSWORD)("tenant suspension: inbound continues, outbound automation pauses (integration)", () => {
  let app: FastifyInstance;
  let admin: TestPlatformUser;
  let t: TestTenant;
  let ccsConnectorId: string;
  let doctorResourceId: string;
  let n = 0;
  let slot = 0;

  const call = (role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9197${String(52000000 + ++n * 37).padStart(8, "0")}`;
  /** Only fixture sends are ever allowed here, whatever else the database holds. */
  const fixtureOnly = {
    adapterFor: (provider: string) => {
      const real = getMessagingAdapter(provider)!;
      return { ...real, sendTemplate: async (cfg: Record<string, unknown>, sec: Record<string, unknown>, to: string, tpl: { name: string; language: string; parameters: string[] }) => { if (cfg.mode !== "fixture") throw new Error("test guard: refusing a non-fixture send"); return real.sendTemplate(cfg, sec, to, tpl); } };
    },
  };
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (ok(v) || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /** A confirmed visit `hours` ahead, with its planned confirmation + reminder rows. */
  async function confirmedVisit(hours: number) {
    const lead = await call("FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Suspension Patient", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(lead.statusCode).toBe(201);
    const { patientId, journeyId } = lead.json() as { patientId: string; journeyId: string };
    const res = await call("FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: t.branchId, doctorId: doctorResourceId, scheduledAt: new Date(Date.now() + hours * 3_600_000 + ++slot * 60_000).toISOString(), reason: "Consultation" });
    expect(res.statusCode).toBe(201);
    const appt = res.json() as AppointmentRow;
    expect((await call("FRONT_DESK", "PATCH", `/appointments/${appt.id}/action`, { action: "confirm" })).statusCode).toBe(200);
    const rows = await until(() => db.select().from(notifications).where(eq(notifications.subjectId, appt.id)), (r) => r.length >= 2);
    return { appt, rows, patientId, journeyId };
  }
  const statusOf = async (id: string) => (await db.select({ s: notifications.status, r: notifications.reason }).from(notifications).where(eq(notifications.id, id)))[0]!;
  const lifecycle = async (action: "SUSPEND" | "REACTIVATE", reason: string) => {
    const [row] = await db.select({ version: tenants.version }).from(tenants).where(eq(tenants.id, t.tenantId));
    const res = await app.inject({ method: "POST", url: `/platform/tenants/${t.tenantId}/lifecycle`, cookies: asPlatform(admin.cookie), payload: { action, version: row!.version, reason } });
    expect(res.statusCode).toBe(200);
  };
  const snapshotSettings = async () => ({
    rules: (await db.select({ id: notificationRules.id, enabled: notificationRules.enabled, offsetValue: notificationRules.offsetValue }).from(notificationRules).where(eq(notificationRules.tenantId, t.tenantId))).sort((a, b) => a.id.localeCompare(b.id)),
    caps: (await db.select({ c: tenantCapabilities.capability, e: tenantCapabilities.enabled }).from(tenantCapabilities).where(eq(tenantCapabilities.tenantId, t.tenantId))).sort((a, b) => a.c.localeCompare(b.c)),
    webhooks: await db.select({ id: outboundWebhooks.id, enabled: outboundWebhooks.enabled }).from(outboundWebhooks).where(eq(outboundWebhooks.tenantId, t.tenantId)),
  });

  let webhookId: string;
  async function pendingDelivery(): Promise<string> {
    const [d] = await db.insert(outboundWebhookDeliveries).values({ tenantId: t.tenantId, webhookId, eventId: randomUUID(), eventType: "lead.created", payload: { test: true } }).returning({ id: outboundWebhookDeliveries.id });
    return d!.id;
  }
  const sentRequests: string[] = [];
  const fakeFetch = async (url: string) => {
    sentRequests.push(url);
    return { status: 200 };
  };

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_INSECURE = "true";
    app = await buildApp();
    await app.ready();
    admin = await createPlatformUser(db, app, "PLATFORM_ADMIN", "platform-test-password-1");
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!, { connectorMode: "FIXTURE", webhookSecret: RUNO_SECRET });
    await call("HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    doctorResourceId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
    expect((await call("HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "pn-suspension" } })).statusCode).toBe(200);
    // A CCS IVR line for this hospital (inbound only in this test).
    const [ccs] = await db.insert(connectors).values({ tenantId: t.tenantId, type: "TELEPHONY", provider: "ccs_ivr", displayName: "CCS IVR", capabilities: ["RECEIVE_CALL_EVENT"], status: "CONNECTED", mode: "LIVE", configuration: {} }).returning();
    ccsConnectorId = ccs!.id;
    await db.insert(connectorSecrets).values({ connectorId: ccsConnectorId, encryptedPayload: encryptSecret({ apiKey: CCS_KEY }) });
    const [w] = await db.insert(outboundWebhooks).values({ tenantId: t.tenantId, name: "Suspension test receiver", url: "http://127.0.0.1:9/receiver", events: ["lead.created"], encryptedSecret: encryptSecret({ signingSecret: "s" }) }).returning();
    webhookId = w!.id;
  });
  afterAll(async () => {
    delete process.env.WEBHOOK_ALLOW_INSECURE;
    await app.close();
    await queryClient.end();
  });

  it("the policy: only an ACTIVE tenant sends, and never a message that fell due before it became active", () => {
    const changed = new Date("2026-10-20T10:00:00Z");
    expect(outboundDecision({ status: "ACTIVE", statusChangedAt: null }, new Date()).ok).toBe(true);
    for (const status of ["DRAFT", "ONBOARDING", "SUSPENDED", "ARCHIVED"]) expect(outboundDecision({ status, statusChangedAt: null }, new Date()).ok).toBe(false);
    expect(outboundDecision({ status: "ACTIVE", statusChangedAt: changed }, new Date("2026-10-20T09:59:00Z")).ok).toBe(false);
    expect(outboundDecision({ status: "ACTIVE", statusChangedAt: changed }, new Date("2026-10-20T10:01:00Z")).ok).toBe(true);
  });

  it("while ACTIVE, outbound automation runs normally", async () => {
    const { rows } = await confirmedVisit(30);
    const confirmation = rows.find((r) => r.scheduledFor.getTime() <= Date.now() + 1000)!;
    await processDueNotifications(db, new Date(Date.now() + 1000), fixtureOnly);
    expect((await statusOf(confirmation.id)).s).toBe("SENT");
    const delivery = await pendingDelivery();
    await deliverDueWebhooks(db, new Date(Date.now() + 1000), fakeFetch);
    expect((await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery)))[0]!.status).toBe("SENT");
  });

  it("SUSPENDED: client sign-in and existing sessions are refused; inbound CCS and Runo calls are still recorded; nothing automated is sent; settings untouched", async () => {
    const before = await snapshotSettings();
    const { appt, rows } = await confirmedVisit(30);
    const reminder = rows.filter((r) => r.scheduledFor.getTime() > Date.now() + 60_000).sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0]!;
    // A staff "scheduled WhatsApp": a FOLLOW_UP message due a little later.
    const [followUp] = await db
      .insert(notifications)
      .values({ tenantId: t.tenantId, templateId: reminder.templateId, subjectType: "FOLLOW_UP", subjectId: appt.id, patientId: reminder.patientId, journeyId: reminder.journeyId, scheduledFor: new Date(Date.now() + 5 * 60_000), idempotencyKey: `suspension-followup-${randomUUID()}`, createdBy: t.userIds.FRONT_DESK!, renderedText: "Please call us back about your visit" })
      .returning();
    const delivery = await pendingDelivery();
    const email = (await call("FRONT_DESK", "GET", "/auth/session")).json().user.email as string;

    await lifecycle("SUSPEND", "Contract paused by the client");
    expect(await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.tenantId, t.tenantId), eq(platformAuditEvents.action, "tenant.suspended")))).toHaveLength(1);

    // Client access.
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe("workspace_unavailable");
    expect((await call("FRONT_DESK", "GET", "/auth/session")).statusCode).toBe(401);
    expect((await call("HOSPITAL_ADMIN", "GET", "/patients")).statusCode).toBe(401);

    // Inbound continues: a CCS IVR call and a Runo call are ingested for the suspended hospital.
    const ccsCallId = `ccs-susp-${randomUUID().slice(0, 8)}`;
    const ccs = await app.inject({ method: "POST", url: `/webhooks/ccs/${ccsConnectorId}`, headers: { "x-api-key": CCS_KEY }, payload: { call_id: ccsCallId, caller_number: phone(), direction: "inbound", status: "ANSWERED", duration: 61, start_time: new Date(Date.now() - 120_000).toISOString() } });
    expect(ccs.statusCode).toBe(200);
    expect(await db.select().from(calls).where(and(eq(calls.tenantId, t.tenantId), eq(calls.externalCallId, ccsCallId)))).toHaveLength(1);
    const runoCallId = `runo-susp-${randomUUID().slice(0, 8)}`;
    const runo = await app.inject({ method: "POST", url: `/webhooks/runo/${t.connectorId}`, headers: { "x-api-key": RUNO_SECRET }, payload: { call_id: runoCallId, phone_number: phone(), customer_name: null, agent_name: "IVR", direction: "inbound", status: "completed", duration_seconds: 40, recording_url: null, started_at: new Date(Date.now() - 300_000).toISOString(), ended_at: new Date(Date.now() - 260_000).toISOString() } });
    expect(runo.statusCode).toBeLessThan(300);
    expect(await db.select().from(calls).where(and(eq(calls.tenantId, t.tenantId), eq(calls.externalCallId, runoCallId)))).toHaveLength(1);

    // Outbound pauses: the reminder and the scheduled WhatsApp fall due and are NOT sent; the webhook is not delivered.
    const later = new Date(reminder.scheduledFor.getTime() + 30_000);
    await processDueNotifications(db, later, fixtureOnly);
    expect(await statusOf(reminder.id)).toEqual({ s: "CANCELLED", r: "TENANT_NOT_ACTIVE" });
    expect(await statusOf(followUp!.id)).toEqual({ s: "CANCELLED", r: "TENANT_NOT_ACTIVE" });
    sentRequests.length = 0;
    await deliverDueWebhooks(db, new Date(Date.now() + 1000), fakeFetch);
    expect(sentRequests).toHaveLength(0);
    expect((await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery)))[0]).toMatchObject({ status: "FAILED", error: "tenant_not_active" });

    // Saved preferences are exactly as they were.
    expect(await snapshotSettings()).toEqual(before);
  });

  it("REACTIVATED: future messages work again; anything that fell due while suspended is never released as a backlog", async () => {
    // Fell due while suspended, but the job did not run until after reactivation (e.g. the worker was down).
    const [template] = await db.select().from(notifications).where(eq(notifications.tenantId, t.tenantId)).limit(1);
    const [stale] = await db
      .insert(notifications)
      .values({ tenantId: t.tenantId, templateId: template!.templateId, subjectType: "FOLLOW_UP", subjectId: template!.subjectId, patientId: template!.patientId, journeyId: template!.journeyId, scheduledFor: new Date(Date.now() - 60_000), idempotencyKey: `suspension-stale-${randomUUID()}`, createdBy: t.userIds.FRONT_DESK!, renderedText: "Stale message from the suspension" })
      .returning();
    const staleDelivery = await pendingDelivery();

    await new Promise((r) => setTimeout(r, 20));
    await lifecycle("REACTIVATE", "Contract resumed");
    expect(await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.tenantId, t.tenantId), eq(platformAuditEvents.action, "tenant.reactivated")))).toHaveLength(1);

    // Suspension ended every session; staff sign in again.
    for (const role of ["FRONT_DESK", "HOSPITAL_ADMIN"] as const) {
      const email = (await db.select().from(users).where(eq(users.id, t.userIds[role]!)))[0]!.email;
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
      expect(res.statusCode).toBe(200);
      t.cookie[role] = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    }

    // The stale message and the stale webhook event are never sent.
    await processDueNotifications(db, new Date(Date.now() + 1000), fixtureOnly);
    expect(await statusOf(stale!.id)).toEqual({ s: "CANCELLED", r: "TENANT_NOT_ACTIVE" });
    sentRequests.length = 0;
    await deliverDueWebhooks(db, new Date(Date.now() + 1000), fakeFetch);
    expect(sentRequests).toHaveLength(0);
    expect((await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, staleDelivery)))[0]!.error).toBe("tenant_not_active");

    // New, valid work runs on time.
    const { rows } = await confirmedVisit(60);
    const future = rows.filter((r) => r.scheduledFor.getTime() > Date.now() + 60_000).sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0]!;
    await processDueNotifications(db, new Date(future.scheduledFor.getTime() + 30_000), fixtureOnly);
    expect((await statusOf(future.id)).s).toBe("SENT");
    const fresh = await pendingDelivery();
    await deliverDueWebhooks(db, new Date(Date.now() + 1000), fakeFetch);
    expect((await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, fresh)))[0]!.status).toBe("SENT");
  });
});
