import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { validateCapabilityChange, resolveCapabilities } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { activityLog, adsDailyFacts, connectors, outboundWebhookDeliveries, notifications } from "../db/schema.js";
import { redactLogText } from "../domain/security/redact.js";
import { isPrivateHost, resolvesToPublicAddresses } from "../domain/integration/webhook-rules.js";
import { deliverDueWebhooks, enqueueWebhookDeliveries, type WebhookFetch } from "../domain/integration/outbound-webhook.service.js";
import { applyDeliveryStatus } from "../domain/notification/notification.service.js";
import { syncAds } from "../domain/ads/ads-sync.service.js";
import { scrubMetadata } from "../domain/activity/activity.service.js";
import { metaAdsProvider } from "../domain/ads/meta-ads.js";
import { TransientAdsError, type AdsReportingProvider, type NormalizedAdFact } from "../domain/ads/types.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { dueNow } from "./helpers/due-now.js";

const PW = process.env.DEMO_PASSWORD;

describe("review fixes: pure rules", () => {
  it("webhook SSRF: reserved ranges and names that resolve to private addresses are refused", async () => {
    for (const h of ["192.0.0.9", "198.18.0.1", "224.0.0.1", "255.255.255.255", "64:ff9b::1", "2002::1", "ff02::1", "10.0.0.1", "169.254.169.254"]) expect(isPrivateHost(h), h).toBe(true);
    expect(isPrivateHost("93.184.216.34")).toBe(false);
    expect(await resolvesToPublicAddresses("evil.example", async () => [{ address: "127.0.0.1" }])).toBe(false);
    expect(await resolvesToPublicAddresses("evil.example", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }])).toBe(false); // ANY private answer refuses
    expect(await resolvesToPublicAddresses("ok.example", async () => [{ address: "93.184.216.34" }])).toBe(true);
    expect(await resolvesToPublicAddresses("nx.example", async () => { throw new Error("NXDOMAIN"); })).toBe(false);
  });

  it("redaction also covers JWTs, Basic credentials and URL query strings", () => {
    const out = redactLogText("failed https://api.example.org/h?key=ABC123&x=1 jwt eyJhbGciOi.eyJzdWIiOiIx.sig Authorization: Basic dXNlcjpwYXNz")!;
    expect(out).not.toContain("ABC123");
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).toContain("https://api.example.org/h?[redacted]");
  });

  it("GOOGLE_ADS and META_ADS need Marketing Analytics (no spend synced for a surface nobody can open)", () => {
    const v2 = resolveCapabilities("BETA_V2_GROWTH", {});
    const check = validateCapabilityChange(v2, "MARKETING_ANALYTICS", false);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.capabilities).toEqual(expect.arrayContaining(["GOOGLE_ADS", "META_ADS"]));
    const v1 = resolveCapabilities("BETA_V1_CORE", {});
    expect(validateCapabilityChange(v1, "GOOGLE_ADS", true).ok).toBe(false);
  });

  it("activity metadata never keeps a secret: secret-named keys are dropped, text is redacted, size is bounded", () => {
    const s = scrubMetadata({ accessToken: "EAAB-super-secret", nested: { password: "x", ok: true }, note: "token=abc123 fine", list: Array.from({ length: 50 }, (_, i) => i), apiKey: "k" }) as Record<string, unknown>;
    expect(JSON.stringify(s)).not.toContain("EAAB-super-secret");
    expect(JSON.stringify(s)).not.toContain("abc123");
    expect(s.accessToken).toBe("[not recorded]");
    expect((s.nested as Record<string, unknown>).ok).toBe(true);
    expect((s.list as unknown[]).length).toBe(20);
  });

  it("Meta pull larger than one sync can take fails instead of storing a truncated snapshot; throttling code 17 is transient; no currency is an error", async () => {
    const page = { ok: true, status: 200, json: async () => ({ data: [], paging: { next: "https://graph.facebook.com/next" } }) };
    vi.stubGlobal("fetch", vi.fn(async () => page));
    await expect(metaAdsProvider.fetchDailyFacts({ adAccountId: "9" }, { accessToken: "t" }, { from: "2026-09-01", to: "2026-09-02" })).rejects.toThrow(/more data than one sync/);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 17 } }) })));
    await expect(metaAdsProvider.fetchDailyFacts({ adAccountId: "9" }, { accessToken: "t" }, { from: "2026-09-01", to: "2026-09-02" })).rejects.toBeInstanceOf(TransientAdsError);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ campaign_id: "1", date_start: "2026-09-01", spend: "5" }] }) })));
    await expect(metaAdsProvider.fetchDailyFacts({ adAccountId: "9" }, { accessToken: "t" }, { from: "2026-09-01", to: "2026-09-02" })).rejects.toThrow(/currency/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(metaAdsProvider.fetchDailyFacts({ adAccountId: "9" }, { accessToken: "t" }, { from: "2026-09-01", to: "2026-09-02" })).rejects.toBeInstanceOf(TransientAdsError); // a network error is retried
    vi.unstubAllGlobals();
  });
});

describe.skipIf(!PW)("review fixes (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  const call = (tt: TestTenant, role: Role, method: "GET" | "PUT" | "POST", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_INSECURE = "true";
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", PW!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", PW!);
  });
  afterAll(async () => {
    delete process.env.WEBHOOK_ALLOW_INSECURE;
    for (const x of [t, other]) await destroyTestTenant(db, x);
    await app.close();
    await queryClient.end();
  });

  it("a redirect from a webhook receiver is never followed: the delivery fails as redirect_refused (and the request asked for manual redirects)", async () => {
    const hook = await call(t, "SUPER_ADMIN", "POST", "/integrations/webhooks", { name: "r", url: "https://redirector.example.org/h", events: ["lead.created"] });
    expect(hook.statusCode).toBe(201);
    const ev = { tenantId: t.tenantId, occurredAt: new Date(), type: "lead.created" as const, eventId: `lead.created:redir-${Date.now()}`, data: { sourceKey: "google" } };
    expect(await enqueueWebhookDeliveries(db, ev)).toBe(1);
    let seenRedirect: string | undefined;
    const f: WebhookFetch = async (_u, init) => { seenRedirect = init.redirect; return { status: 302 }; };
    await deliverDueWebhooks(db, dueNow(), f);
    expect(seenRedirect).toBe("manual");
    const [d] = await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.eventId, ev.eventId));
    expect(d!.error).toBe("redirect_refused");
    expect(d!.status).toBe("PENDING"); // retried later within the bounded schedule, never followed
  });

  it("a delivery status can only touch the connector's own hospital's messages", async () => {
    const [p] = await db.query.patients.findMany({ where: (x, { eq: e }) => e(x.tenantId, t.tenantId), limit: 1 });
    const [n] = await db.insert(notifications).values({ tenantId: t.tenantId, subjectType: "FOLLOW_UP", subjectId: p!.id, patientId: p!.id, scheduledFor: new Date(), status: "SENT", providerMessageId: "wamid.CROSS", idempotencyKey: `x-${Date.now()}` }).returning();
    expect(await applyDeliveryStatus(db, other.tenantId, "wamid.CROSS", "read", new Date())).toBe(false);
    expect((await db.select().from(notifications).where(eq(notifications.id, n!.id)))[0]!.status).toBe("SENT");
    expect(await applyDeliveryStatus(db, t.tenantId, "wamid.CROSS", "read", new Date())).toBe(true);
    expect((await db.select().from(notifications).where(eq(notifications.id, n!.id)))[0]!.status).toBe("READ");
  });

  it("changing the mode or a secret starts the connection over: a fixture's 'connected' never carries into Live", async () => {
    await call(t, "SUPER_ADMIN", "PUT", "/capabilities/MARKETING_ANALYTICS", { enabled: true });
    await call(t, "SUPER_ADMIN", "PUT", "/capabilities/META_ADS", { enabled: true });
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/meta_ads/configuration", { configuration: { adAccountId: "555" } })).statusCode).toBe(200);
    expect((await call(t, "HOSPITAL_ADMIN", "POST", "/integrations/hub/meta_ads/sync", {})).statusCode).toBe(200);
    expect((await call(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/meta_ads")).json().health).toBe("HEALTHY");
    expect((await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/meta_ads/configuration", { mode: "LIVE" })).statusCode).toBe(200);
    const live = (await call(t, "SUPER_ADMIN", "GET", "/integrations/hub/meta_ads")).json();
    expect(live.mode).toBe("NOT_CONFIGURED"); // no credentials for Live yet
    expect(live.health).toBe("UNKNOWN"); // and nothing has contacted the real provider
    expect((await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/meta_ads/configuration", { secrets: { accessToken: "EAAB-live-token-123456789012345" } })).statusCode).toBe(200);
    const withSecret = (await call(t, "SUPER_ADMIN", "GET", "/integrations/hub/meta_ads")).json();
    expect(withSecret).toMatchObject({ mode: "LIVE_CAPABLE", health: "UNKNOWN" }); // configured for Live, not yet confirmed
  });

  it("a sync replaces the window it read: a day the provider no longer reports does not keep its old spend", async () => {
    const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "meta_ads")));
    await db.update(connectors).set({ mode: "FIXTURE", status: "NOT_CONFIGURED" }).where(eq(connectors.id, c!.id));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    await db.insert(adsDailyFacts).values({ tenantId: t.tenantId, connectorId: c!.id, provider: "meta_ads", accountId: "555", entityId: "ghost", entityName: "Ghost", factDate: today, spend: "999.00" });
    const empty: AdsReportingProvider = { provider: "meta_ads", fetchDailyFacts: async (): Promise<NormalizedAdFact[]> => [] };
    const r = await syncAds(db, t.tenantId, "meta_ads", { trigger: "SCHEDULED", now: new Date(Date.now() + 2 * 3_600_000), adapter: empty });
    expect(r.ok && r.run.status).toBe("SUCCEEDED");
    expect(await db.select().from(adsDailyFacts).where(and(eq(adsDailyFacts.tenantId, t.tenantId), eq(adsDailyFacts.entityId, "ghost")))).toHaveLength(0);
  });

  it("capability changes are recorded (who, what) with no secret anywhere; Admin sees them, Staff cannot, and tenants are isolated", async () => {
    await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/meta_ads/configuration", { secrets: { accessToken: "EAAB-never-logged-1234567890123" } });
    const log = (await call(t, "HOSPITAL_ADMIN", "GET", "/activity-log")).json() as { action: string; entityKey: string; actorName: string; metadata: Record<string, unknown> }[];
    expect(log.find((e) => e.action === "capability.changed" && e.entityKey === "META_ADS")).toMatchObject({ metadata: { to: true } });
    const secretEntry = log.find((e) => e.action === "integration.secret_changed");
    expect(secretEntry!.metadata.protectedFieldNames).toEqual(["accessToken"]); // the NAME, never the value
    expect(JSON.stringify(log)).not.toContain("EAAB-never-logged");
    expect(log[0]!.actorName).toBeTruthy();
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await call(t, role, "GET", "/activity-log")).statusCode, role).toBe(403);
    expect(((await call(other, "HOSPITAL_ADMIN", "GET", "/activity-log")).json() as unknown[]).length).toBe(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.tenantId, other.tenantId))).length).toBe(0);
  });

  it("with Conversation Intelligence off, no summary deadline is set and the job does not summarize (the Inbox may still be on)", async () => {
    const { recordConversationActivity } = await import("../domain/conversation/summary/conversation-session.service.js");
    expect((await call(t, "SUPER_ADMIN", "PUT", "/capabilities/WHATSAPP_INBOX", { enabled: true })).statusCode).toBe(200);
    const [p] = await db.query.patients.findMany({ where: (x, { eq: e }) => e(x.tenantId, t.tenantId), limit: 1 });
    const { conversations } = await import("../db/schema.js");
    const [conv] = await db.insert(conversations).values({ tenantId: t.tenantId, patientId: p!.id, channel: "WHATSAPP", externalThreadId: `th-${Date.now()}`, ownershipState: "HUMAN_REQUIRED", lastMessageAt: new Date() }).returning();
    await recordConversationActivity(db, t.tenantId, conv!.id, { at: new Date(), sender: "patient" });
    expect((await db.select().from(conversations).where(eq(conversations.id, conv!.id)))[0]!.summaryDueAt).toBeNull();
    await db.delete(conversations).where(eq(conversations.id, conv!.id));
  });
});
