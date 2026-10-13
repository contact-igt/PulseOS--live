import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectors, connectorSecrets, notifications, outboundWebhookDeliveries } from "../db/schema.js";
import { getMessagingAdapter } from "../domain/connector/registry.js";
import { createWhatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { AmbiguousSendError, PermanentSendError, type MessagingProviderAdapter } from "../domain/connector/types.js";
import { reconcileWhatsNexusOutcomes, sendFollowUpMessage } from "../domain/notification/notification.service.js";
import { signWebhookBody } from "../domain/integration/webhook-rules.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const API_KEY = "wnpk_it_key_0123456789abcdefghijklmnop";
const CB_SECRET = "whcs_it_secret_0123456789abcdefghij";
const OTHER_CB_SECRET = "whcs_other_secret_0123456789abcdefg";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe.skipIf(!DEMO_PASSWORD)("WhatsNexus provider: selection, sending, callbacks (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant; // the hospital that uses WhatsNexus
  let other: TestTenant; // a second hospital with its own WhatsNexus credentials
  let metaOnly: TestTenant; // an existing hospital that never touches WhatsNexus
  let n = 0;
  let wamidSeq = 0;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(71000000 + ++n * 37).padStart(8, "0")}`;

  async function journey(tt: TestTenant) {
    const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Asha Rao", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }

  /** A WhatsNexus HTTP double. Records every request; `onPost` decides the reply. */
  function wnDouble(onPost: (init: RequestInit, idempotencyKey: string) => Promise<Response> | Response, onGet?: (url: string) => Promise<Response> | Response) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requests: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      requests.push({ method: String(init.method), url, headers, body: init.body ? JSON.parse(init.body as string) : null });
      if (init.method === "POST") return onPost(init, headers["idempotency-key"]!);
      return onGet ? onGet(url) : json(404, { error: { code: "NOT_FOUND" } });
    }) as unknown as typeof fetch;
    const adapter = createWhatsNexusAdapter({ fetchImpl, isPublicHost: async () => true });
    const metaSend = vi.fn();
    const real = getMessagingAdapter("whatsapp_meta_cloud")!;
    const metaAdapter: MessagingProviderAdapter = { ...real, sendTemplate: async (...args) => (metaSend(), real.sendTemplate(...args)) };
    return {
      requests,
      adapter,
      metaSend,
      deps: { adapterFor: (p: string) => (p === "whatsnexus" ? adapter : p === "whatsapp_meta_cloud" ? metaAdapter : null) },
      posts: () => requests.filter((r) => r.method === "POST"),
    };
  }
  const accept = () => json(200, { success: true, wamid: `wamid.IT${++wamidSeq}${Date.now()}`, status: "accepted" });

  const sign = (secret: string, body: object, ts = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(body);
    return { raw, headers: { "content-type": "application/json", "x-whatsnexus-timestamp": String(ts), "x-whatsnexus-signature": signWebhookBody(secret, String(ts), raw) } };
  };
  const callback = (tenantId: string, secret: string, body: object, over: { ts?: number; path?: string } = {}) => {
    const s = sign(secret, body, over.ts);
    return app.inject({ method: "POST", url: over.path ?? `/webhooks/whatsnexus/${tenantId}`, payload: s.raw, headers: s.headers });
  };
  const event = (notificationId: string, wamid: string, status: string, over: Record<string, unknown> = {}) => ({
    eventId: `d-${notificationId}:${status}`,
    dispatchId: "d-1",
    externalId: notificationId,
    wamid,
    status,
    occurredAt: new Date().toISOString(),
    ...over,
  });
  const row = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;

  async function configureWn(tt: TestTenant, cbSecret: string, extra: { mode?: "FIXTURE" | "LIVE" } = {}) {
    const cfg = await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { baseUrl: "https://wn.example.com/", tenantId: "TT001" } });
    expect(cfg.statusCode).toBe(200);
    const sec = await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { apiKey: API_KEY, callbackSecret: cbSecret }, mode: extra.mode ?? "LIVE" });
    expect(sec.statusCode).toBe(200);
  }
  const setConnectorStatus = (tt: TestTenant, status: "CONNECTED" | "DISABLED" | "CONNECTING") =>
    db.update(connectors).set({ status }).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus")));
  const selectWn = (tt: TestTenant, on: boolean) => call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: on ? "true" : "" } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    metaOnly = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, other, metaOnly]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    // Meta Cloud fixture connections: `t` has one too, to prove WhatsNexus never falls back to it.
    for (const tt of [t, metaOnly]) expect((await call(tt, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "pn-test" } })).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const tt of [t, other, metaOnly]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  // ── configuration ──────────────────────────────────────────────────────────
  it("a hospital with no WhatsNexus setup reports NOT_CONFIGURED honestly (no row means no health)", async () => {
    const res = await call(other, "SUPER_ADMIN", "POST", "/integrations/hub/whatsnexus/status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, status: "NOT_CONFIGURED" });
    const card = ((await call(other, "SUPER_ADMIN", "GET", "/integrations/hub")).json() as { key: string; health: string; isConnected: boolean }[]).find((c) => c.key === "whatsnexus")!;
    expect(card.isConnected).toBe(false);
    expect(card.health).not.toBe("HEALTHY");
  });

  it("refuses unsafe or malformed settings and any 'use WhatsNexus' request before it is set up, live and verified", async () => {
    const put = (configuration: Record<string, string>) => call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration });
    expect((await put({ baseUrl: "http://wn.example.com" })).json()).toMatchObject({ error: "https_required" });
    expect((await put({ baseUrl: "https://10.0.0.5" })).json()).toMatchObject({ error: "private_address" });
    expect((await put({ baseUrl: "https://user:pw@wn.example.com" })).json()).toMatchObject({ error: "credentials_in_url" });
    expect((await put({ baseUrl: "https://wn.example.com/api/v1/pixeleye/webhook" })).json()).toMatchObject({ error: "invalid_url" });
    expect((await put({ tenantId: "bad id!" })).json()).toMatchObject({ error: "invalid_tenant_id" });
    expect((await put({ useForSending: "maybe" })).json()).toMatchObject({ error: "invalid_value" });
    const early = await selectWn(t, true);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: "provider_not_ready" });
  });

  it("credentials are stored encrypted and never read back; the base URL is normalised; Admins cannot set credentials", async () => {
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { apiKey: API_KEY } })).statusCode).toBe(403);
    await configureWn(t, CB_SECRET);
    const detail = await call(t, "SUPER_ADMIN", "GET", "/integrations/hub/whatsnexus");
    const text = detail.body;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(CB_SECRET);
    expect(detail.json()).toMatchObject({ configurationValues: { baseUrl: "https://wn.example.com", tenantId: "TT001" }, connectorMode: "LIVE" });
    expect((detail.json() as { secretFields: { key: string; hasSecret: boolean }[] }).secretFields.filter((f) => f.hasSecret).map((f) => f.key).sort()).toEqual(["apiKey", "callbackSecret"]);
    expect((detail.json() as { webhookUrl: string }).webhookUrl).toContain(`/webhooks/whatsnexus/${t.tenantId}`);
    const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "whatsnexus")));
    const [s] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, c!.id));
    expect(s!.encryptedPayload).not.toContain(API_KEY);
    expect(c!.status).toBe("CONNECTING"); // configured is not connected
  });

  it("selecting WhatsNexus needs a verified (CONNECTED) connection and no identity change in the same save", async () => {
    expect((await selectWn(t, true)).statusCode).toBe(409); // still only CONNECTING
    await setConnectorStatus(t, "CONNECTED"); // stands in for a successful Check Status probe
    const together = await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: "true", tenantId: "TT999" } });
    expect(together.statusCode).toBe(409);
    expect((await selectWn(t, true)).statusCode).toBe(200);
    // Pointing at another WhatsNexus tenant is a new connection: it must be verified again.
    await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { tenantId: "TT002" } });
    const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "whatsnexus")));
    expect(c!.status).toBe("CONNECTING");
    await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { tenantId: "TT001" } });
    await setConnectorStatus(t, "CONNECTED");
  });

  it("a Fixture/Sandbox connection is never probed: the check explains how to go live", async () => {
    await configureWn(other, OTHER_CB_SECRET, { mode: "FIXTURE" });
    const res = await call(other, "SUPER_ADMIN", "POST", "/integrations/hub/whatsnexus/status");
    expect(res.json()).toMatchObject({ ok: false });
    expect((res.json() as { message: string }).message).toContain("Live");
  });

  // ── provider selection and sending ─────────────────────────────────────────
  it("an existing Meta-only hospital is untouched: it sends through Meta and the provider is recorded", async () => {
    const d = wnDouble(accept);
    const { journeyId } = await journey(metaOnly);
    const r = await sendFollowUpMessage(db, metaOnly.tenantId, metaOnly.userIds.FRONT_DESK!, journeyId, `meta-${Date.now()}-aaaa`, { adapterFor: (p) => (p === "whatsapp_meta_cloud" ? getMessagingAdapter(p) : d.adapter) });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    const stored = await row((r as { notificationId: string }).notificationId);
    expect(stored.provider).toBe("whatsapp_meta_cloud");
    expect(stored.providerMessageId).toMatch(/^FIXTURE_WAMID_/);
    expect(d.requests).toHaveLength(0);
  });

  it("WhatsNexus selected: exactly one authenticated request, Idempotency-Key = notification id, the REAL wamid is stored, Meta is not used, and no webhook double-dispatch", async () => {
    // A legacy WHATSNEXUS outbound-webhook row that used to cause the second POST.
    const legacy = await call(t, "SUPER_ADMIN", "POST", "/integrations/webhooks", { name: "Legacy WhatsNexus", url: "https://legacy.example.com", endpointPath: "/hook", webhookCategory: "WHATSNEXUS", events: ["whatsapp.followup_requested", "interaction.logged"], headers: [{ key: "x-api-key", value: "legacy-key-value" }] });
    expect(legacy.statusCode).toBe(201);

    const d = wnDouble(accept);
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-aaaa`, d.deps)) as { notificationId: string; status: string };
    expect(r.status).toBe("SENT");
    const stored = await row(r.notificationId);
    expect(stored.provider).toBe("whatsnexus");
    expect(stored.providerMessageId).toMatch(/^wamid\.IT/);
    expect(stored.sentAt).not.toBeNull();

    expect(d.posts()).toHaveLength(1);
    const req = d.posts()[0]!;
    expect(req.url).toBe("https://wn.example.com/api/integrations/pulseos/messages");
    expect(req.headers["idempotency-key"]).toBe(r.notificationId);
    expect(req.headers["x-api-key"]).toBe(API_KEY);
    expect(req.headers["x-tenant-id"]).toBe("TT001");
    expect(req.body).toMatchObject({ externalId: r.notificationId, templateName: "follow_up_message", language: expect.any(String), source: "PULSE_OS" });
    expect(req.body.params.length).toBeGreaterThan(0);
    expect(d.metaSend).not.toHaveBeenCalled();

    await new Promise((res) => setTimeout(res, 400)); // events are asynchronous
    expect(await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.tenantId, t.tenantId))).toHaveLength(0);

    const detail = (await call(t, "SUPER_ADMIN", "GET", "/integrations/hub/whatsnexus")).json() as { mappingNotes: string };
    expect(detail.mappingNotes).toContain("legacy WhatsNexus outbound webhook");
    // The legacy row is preserved, not converted or deleted.
    expect(((await call(t, "SUPER_ADMIN", "GET", "/integrations/webhooks")).json() as { name: string }[]).map((w) => w.name)).toContain("Legacy WhatsNexus");
  });

  it("a permanent WhatsNexus failure is FAILED with a visible reason and NEVER falls back to Meta (even though a Meta connector exists)", async () => {
    const d = wnDouble(() => json(403, { success: false, error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance", retryable: false } }));
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-bbbb`, d.deps)) as { notificationId: string; status: string };
    expect(r.status).toBe("FAILED");
    const stored = await row(r.notificationId);
    expect(stored.reason).toContain("INSUFFICIENT_BALANCE");
    expect(stored.providerMessageId).toBeNull();
    expect(d.metaSend).not.toHaveBeenCalled();
    expect(d.posts()).toHaveLength(1);
  });

  it("WhatsNexus selected but switched off or not live: the message is BLOCKED, never sent through Meta", async () => {
    await setConnectorStatus(t, "DISABLED");
    const d = wnDouble(accept);
    const { journeyId } = await journey(t);
    const preview = await call(t, "FRONT_DESK", "GET", `/journeys/${journeyId}/whatsapp/preview`);
    expect(preview.json()).toMatchObject({ canSend: false, blockedReason: "PROVIDER_NOT_CONFIGURED" });
    const r = await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-cccc`, d.deps);
    expect(r).toMatchObject({ ok: false });
    expect(d.requests).toHaveLength(0);
    expect(d.metaSend).not.toHaveBeenCalled();
    await setConnectorStatus(t, "CONNECTED");
  });

  it("an ambiguous outcome is never re-sent: it stays visibly UNKNOWN, then the read-only reconcile resolves it from WhatsNexus's record", async () => {
    const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const d = wnDouble(() => { throw timeout(); }, () => json(200, { success: true, dispatch: { status: "processing" } }));
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-dddd`, d.deps)) as { notificationId: string; status: string };
    expect(r.status).toBe("FAILED");
    expect((await row(r.notificationId)).reason).toMatch(/^OUTCOME_UNKNOWN/);
    expect(d.posts()).toHaveLength(1);

    // WhatsNexus still unsure → left alone.
    const still = await reconcileWhatsNexusOutcomes(db, new Date(), d.deps);
    expect(still.pending).toBeGreaterThanOrEqual(1);
    expect((await row(r.notificationId)).reason).toMatch(/^OUTCOME_UNKNOWN/);

    // WhatsNexus proves it accepted the send → SENT with the real wamid, reason cleared. Still one POST ever.
    const found = wnDouble(accept, () => json(200, { success: true, dispatch: { status: "accepted", wamid: "wamid.RECONCILED" } }));
    const done = await reconcileWhatsNexusOutcomes(db, new Date(), found.deps);
    expect(done.accepted).toBeGreaterThanOrEqual(1);
    expect(await row(r.notificationId)).toMatchObject({ status: "SENT", providerMessageId: "wamid.RECONCILED", reason: null });
    expect(found.posts()).toHaveLength(0);
  });

  it("an ambiguous send that WhatsNexus never received is resolved as NOT_SENT (and nothing was posted twice)", async () => {
    const d = wnDouble(() => { throw new AmbiguousSendError("x"); }, () => json(200, { success: true, dispatch: { status: "unknown_outcome" } }));
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-eeee`, { adapterFor: () => ({ ...d.adapter, sendTemplate: async () => { throw new AmbiguousSendError("simulated"); } }) })) as { notificationId: string };
    expect((await row(r.notificationId)).reason).toMatch(/^OUTCOME_UNKNOWN/);
    const gone = wnDouble(accept, () => json(404, { error: { code: "NOT_FOUND" } }));
    await reconcileWhatsNexusOutcomes(db, new Date(), gone.deps);
    expect((await row(r.notificationId)).reason).toMatch(/^NOT_SENT/);
  });

  it("a permanent adapter error is not retried by the worker (PermanentSendError)", async () => {
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-ffff`, { adapterFor: () => ({ ...createWhatsNexusAdapter(), sendTemplate: async () => { throw new PermanentSendError("template not approved", "TEMPLATE_NOT_APPROVED"); } }) })) as { notificationId: string; status: string };
    expect(r.status).toBe("FAILED");
    expect((await row(r.notificationId)).attempts).toBe(1);
  });

  // ── callbacks ──────────────────────────────────────────────────────────────
  async function sentNotification(): Promise<{ id: string; wamid: string }> {
    const d = wnDouble(accept);
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-${++n}xyz`, d.deps)) as { notificationId: string };
    return { id: r.notificationId, wamid: (await row(r.notificationId)).providerMessageId! };
  }

  it("a signed callback advances SENT → DELIVERED → READ; duplicates, regressions and failed-after-delivered change nothing", async () => {
    const { id, wamid } = await sentNotification();
    expect((await callback(t.tenantId, CB_SECRET, event(id, wamid, "delivered"))).json()).toMatchObject({ ok: true, applied: true });
    expect(await row(id)).toMatchObject({ status: "DELIVERED" });
    expect((await row(id)).deliveredAt).not.toBeNull();
    expect((await callback(t.tenantId, CB_SECRET, event(id, wamid, "delivered"))).json()).toMatchObject({ duplicate: true });
    expect((await callback(t.tenantId, CB_SECRET, event(id, wamid, "read"))).json()).toMatchObject({ applied: true });
    expect(await row(id)).toMatchObject({ status: "READ" });
    await callback(t.tenantId, CB_SECRET, event(id, wamid, "sent", { eventId: "other-sent" }));
    await callback(t.tenantId, CB_SECRET, event(id, wamid, "failed", { eventId: "other-failed" }));
    expect(await row(id)).toMatchObject({ status: "READ" });
  });

  it("read before delivered is accepted and fills in delivery time", async () => {
    const { id, wamid } = await sentNotification();
    await callback(t.tenantId, CB_SECRET, event(id, wamid, "read"));
    const r = await row(id);
    expect(r.status).toBe("READ");
    expect(r.deliveredAt).not.toBeNull();
  });

  it("a Meta failure reported by WhatsNexus marks a SENT message FAILED", async () => {
    const { id, wamid } = await sentNotification();
    await callback(t.tenantId, CB_SECRET, event(id, wamid, "failed"));
    expect(await row(id)).toMatchObject({ status: "FAILED", reason: "PROVIDER_REPORTED_FAILURE" });
  });

  it("unauthenticated, tampered, stale, wrong-secret, wrong-tenant and unknown-tenant callbacks change nothing", async () => {
    const { id, wamid } = await sentNotification();
    const body = event(id, wamid, "delivered", { eventId: `forged-${id}` });
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const inject = (headers: Record<string, string>, path = `/webhooks/whatsnexus/${t.tenantId}`, payload = raw) => app.inject({ method: "POST", url: path, payload, headers: { "content-type": "application/json", ...headers } });

    expect((await inject({})).statusCode).toBe(401); // no signature at all
    expect((await inject({ "x-whatsnexus-timestamp": ts, "x-whatsnexus-signature": "sha256=" + "0".repeat(64) })).statusCode).toBe(401);
    expect((await inject({ "x-whatsnexus-timestamp": ts, "x-whatsnexus-signature": signWebhookBody(CB_SECRET, ts, raw) }, `/webhooks/whatsnexus/${t.tenantId}`, raw.replace("delivered", "read"))).statusCode).toBe(401); // tampered body
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await inject({ "x-whatsnexus-timestamp": old, "x-whatsnexus-signature": signWebhookBody(CB_SECRET, old, raw) })).statusCode).toBe(401); // stale / replayed capture
    expect((await callback(t.tenantId, OTHER_CB_SECRET, body)).statusCode).toBe(401); // another hospital's secret
    expect((await callback(other.tenantId, CB_SECRET, body)).statusCode).toBe(401); // our secret on another hospital's URL
    expect((await callback("00000000-0000-4000-8000-000000000000", CB_SECRET, body)).statusCode).toBe(401); // unknown tenant
    expect((await callback(t.tenantId, CB_SECRET, body, { path: "/webhooks/whatsnexus" })).statusCode).toBe(401); // bare route with no tenant to look a secret up
    expect((await row(id)).status).toBe("SENT");
  });

  it("another hospital can neither see nor change this hospital's notification, even with its own valid signature", async () => {
    const { id, wamid } = await sentNotification();
    const res = await callback(other.tenantId, OTHER_CB_SECRET, event(id, wamid, "read"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: false, reason: "unknown_notification" });
    expect((await row(id)).status).toBe("SENT");
  });

  it("the externalId must be the notification id (a journey id is refused) and a different wamid cannot replace the bound one", async () => {
    const { id, wamid } = await sentNotification();
    const { journeyId } = await journey(t);
    expect((await callback(t.tenantId, CB_SECRET, event(journeyId.replace(/.$/, "0"), wamid, "delivered", { eventId: "j1", externalId: "journey-123" }))).statusCode).toBe(400);
    const conflict = await callback(t.tenantId, CB_SECRET, event(id, "wamid.SOMEONE_ELSE", "delivered", { eventId: "c1" }));
    expect(conflict.json()).toMatchObject({ applied: false, reason: "wamid_conflict" });
    expect((await row(id))).toMatchObject({ status: "SENT", providerMessageId: wamid });
  });

  it("a callback that arrives BEFORE the send call returns is kept: the final state is DELIVERED with the wamid and sent time", async () => {
    const { journeyId } = await journey(t);
    let seenId = "";
    const racing: MessagingProviderAdapter = {
      ...createWhatsNexusAdapter(),
      sendTemplate: async (_c, _s, _to, tpl) => {
        seenId = tpl.idempotencyKey!;
        // WhatsNexus's delivered callback beats our own response handling.
        const res = await callback(t.tenantId, CB_SECRET, event(seenId, "wamid.RACE1", "delivered", { eventId: "race-1" }));
        expect(res.json()).toMatchObject({ applied: true });
        return { providerMessageId: "wamid.RACE1" };
      },
    };
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-race`, { adapterFor: () => racing })) as { notificationId: string };
    expect(seenId).toBe(r.notificationId);
    const final = await row(r.notificationId);
    expect(final).toMatchObject({ status: "DELIVERED", providerMessageId: "wamid.RACE1" });
    expect(final.sentAt).not.toBeNull();
  });

  it("a late callback upgrades an UNKNOWN-outcome notification to SENT/DELIVERED", async () => {
    const { journeyId } = await journey(t);
    const r = (await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `wn-${Date.now()}-late`, { adapterFor: () => ({ ...createWhatsNexusAdapter(), sendTemplate: async () => { throw new AmbiguousSendError("simulated"); } }) })) as { notificationId: string };
    expect((await row(r.notificationId)).reason).toMatch(/^OUTCOME_UNKNOWN/);
    await callback(t.tenantId, CB_SECRET, event(r.notificationId, "wamid.LATE1", "delivered", { eventId: "late-1" }));
    expect(await row(r.notificationId)).toMatchObject({ status: "DELIVERED", providerMessageId: "wamid.LATE1", reason: null });
  });

  it("the previous callback secret keeps working during rotation and stops when it is cleared", async () => {
    const { id, wamid } = await sentNotification();
    await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { callbackSecret: "whcs_rotated_secret_0123456789abcdef", previousCallbackSecret: CB_SECRET } });
    expect((await callback(t.tenantId, CB_SECRET, event(id, wamid, "delivered", { eventId: "rot-1" }))).json()).toMatchObject({ applied: true });
    expect((await callback(t.tenantId, "whcs_rotated_secret_0123456789abcdef", event(id, wamid, "read", { eventId: "rot-2" }))).json()).toMatchObject({ applied: true });
    // Rotation finished: "-" removes the previous secret, after which the old one is rejected.
    await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { previousCallbackSecret: "-" } });
    expect((await callback(t.tenantId, CB_SECRET, event(id, wamid, "sent", { eventId: "rot-3" }))).statusCode).toBe(401);
    expect((await callback(t.tenantId, "whcs_rotated_secret_0123456789abcdef", event(id, wamid, "sent", { eventId: "rot-4" }))).statusCode).toBe(200);
  });
});
