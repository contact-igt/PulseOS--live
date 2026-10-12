/* eslint-disable @typescript-eslint/no-explicit-any -- the harness replies are untyped JSON from another process */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectorEvents, connectors, notifications } from "../db/schema.js";
import { reconcileWhatsNexusOutcomes } from "../domain/notification/notification.service.js";
import { whatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { signWebhookBody } from "../domain/integration/webhook-rules.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

/**
 * CROSS-SYSTEM end-to-end: the real PulseOS app (this process, isolated Postgres) talks over real HTTP to a real WhatsNexus
 * process (tests/helpers/e2eHarness.mjs in the WhatsNexus repo: production routers + disposable MySQL + a Meta double).
 * No message is ever sent to WhatsApp. Skipped unless WN_E2E_ROOT and WN_E2E_MYSQL_PORT are set.
 *
 *   WN_E2E_ROOT=C:/Invictus_Projects/Whatsnexus/invictus-chatbot WN_E2E_MYSQL_PORT=3399 DEMO_PASSWORD=… \
 *   DATABASE_URL=<isolated postgres> npx vitest run src/__tests__/whatsnexus-e2e.integration.test.ts
 */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const WN_ROOT = process.env.WN_E2E_ROOT;
const MYSQL_PORT = process.env.WN_E2E_MYSQL_PORT;
const enabled = !!(DEMO_PASSWORD && WN_ROOT && MYSQL_PORT);

describe.skipIf(!enabled)("PulseOS ↔ WhatsNexus end to end (real HTTP both ways)", () => {
  let app: FastifyInstance;
  let pulseosPort = 0;
  let wnPort = 0;
  let harness: ChildProcess;
  let n = 0;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const wn = async (p: string, body?: object) => (await fetch(`http://127.0.0.1:${wnPort}${p}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<Record<string, any>>;
  const state = (tenantId: string) => wn(`/__test/state?tenantId=${tenantId}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (ok(v) || Date.now() > end) return v;
      await sleep(80);
    }
  }
  const phone = () => `+9196${String(81000000 + ++n * 41).padStart(8, "0")}`;
  const row = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const pollRow = (id: string, ok: (r: typeof notifications.$inferSelect) => boolean, ms?: number) => until(() => row(id), ok, ms);

  async function journey(tt: TestTenant) {
    const patientPhone = phone();
    const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: patientPhone, name: "Asha Rao", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    // `phoneDigits` is the patient's number exactly as Meta reports it in a status (recipient_id).
    return { ...(res.json() as { patientId: string; journeyId: string }), phoneDigits: patientPhone.replace(/\D/g, "") };
  }
  /** Staff presses "send WhatsApp" on a follow-up: the real route, the real provider resolution, the real adapter. */
  async function pressSend(tt: TestTenant, journeyId: string) {
    const res = await call(tt, "FRONT_DESK", "POST", `/journeys/${journeyId}/whatsapp`, { idempotencyKey: `e2e-${Date.now()}-${++n}-abcd` });
    expect(res.statusCode).toBe(201);
    return res.json() as { notificationId: string; status: string };
  }
  async function followUp(tt: TestTenant) {
    const { journeyId, phoneDigits } = await journey(tt);
    return { ...(await pressSend(tt, journeyId)), phoneDigits };
  }

  type Wn = { tenantId: string; apiKey: string; callbackSecret: string };
  async function provision(tt: TestTenant, over: Record<string, unknown> = {}): Promise<Wn> {
    const r = await wn("/__test/provision", { pulseosTenantId: tt.tenantId, callbackUrl: `http://127.0.0.1:${pulseosPort}/webhooks/whatsnexus/${tt.tenantId}`, ...over });
    return { tenantId: r.tenantId, apiKey: r.apiKey, callbackSecret: r.callbackSecret };
  }
  /** Configure the Hub exactly as a Super Admin would, verify with the REAL health probe, then choose WhatsNexus. */
  async function connect(tt: TestTenant, w: Wn, opts: { select?: boolean } = {}) {
    expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { baseUrl: `http://127.0.0.1:${wnPort}`, tenantId: w.tenantId } })).statusCode).toBe(200);
    expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { apiKey: w.apiKey, callbackSecret: w.callbackSecret }, mode: "LIVE" })).statusCode).toBe(200);
    const probe = await call(tt, "SUPER_ADMIN", "POST", "/integrations/hub/whatsnexus/status");
    expect(probe.json()).toMatchObject({ ok: true, status: "CONNECTED", health: "HEALTHY" });
    if (opts.select !== false) expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: "true" } })).statusCode).toBe(200);
  }
  const setApiKey = (tt: TestTenant, key: string) => call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { apiKey: key } });

  /** Meta's status webhook, through WhatsNexus's REAL webhook route. */
  const metaStatus = (w: Wn, wamid: string, status: string, priced = false, recipient = "919600000000") =>
    fetch(`http://127.0.0.1:${wnPort}/api/whatsapp/webhook/${w.tenantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: `waba-${w.tenantId}`, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: `pn-${w.tenantId}` }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient, ...(priced ? { pricing: { billable: true, category: "utility", pricing_model: "CBP" }, conversation: { id: `c-${wamid}` } } : {}) }] } }] }] }),
    });

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_INSECURE = "true"; // loopback http between the two test processes only (never honoured in production)
    app = await buildApp();
    await app.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    pulseosPort = (app.server.address() as AddressInfo).port;
    harness = spawn(process.execPath, [path.join(WN_ROOT!, "tests", "helpers", "e2eHarness.mjs")], {
      cwd: WN_ROOT,
      env: { ...process.env, INVICTUS_SERVER_LINE: "local", DATABASE_HOST: "127.0.0.1", DATABASE_PORT: MYSQL_PORT, DATABASE_USER: "root", DATABASE_PASSWORD: "", DATABASE_DB: "wn_it", ENCRYPTION_MASTER_KEY: randomBytes(32).toString("hex"), JWT_SECRET_KEY: "e2e" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    harness.stderr!.on("data", (d) => process.stderr.write(`[wn-harness] ${d}`));
    wnPort = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("harness did not start")), 40000);
      harness.stdout!.on("data", (d) => {
        const m = /READY (\d+)/.exec(String(d));
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
      harness.on("exit", (code) => reject(new Error(`harness exited ${code}`)));
    });
  }, 60000);
  afterAll(async () => {
    harness?.kill();
    await app?.close();
    await queryClient.end();
  });

  // Each scenario gets its own PulseOS hospital and its own WhatsNexus tenant.
  async function fresh(over: Record<string, unknown> = {}, opts: { select?: boolean } = {}) {
    const tt = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    const w = await provision(tt, over);
    await connect(tt, w, opts);
    created.push(tt);
    return { tt, w };
  }
  const created: TestTenant[] = [];
  afterAll(async () => {
    for (const tt of created) await destroyTestTenant(db, tt).catch(() => {});
  });

  it("E2E-01/02/03/04/24: follow-up → one WhatsNexus dispatch → one Meta send → real wamid → SENT → DELIVERED → READ; billed exactly once", async () => {
    const { tt, w } = await fresh();
    await wn("/__test/meta", { mode: "accept" });
    const before = (await state(w.tenantId)).metaCalls;
    const sent = await followUp(tt);
    expect(sent.status).toBe("SENT");
    const r = await row(sent.notificationId);
    expect(r.provider).toBe("whatsnexus");
    expect(r.providerMessageId).toMatch(/^wamid\.E2E/); // the genuine Meta id, never fabricated
    const s0 = await state(w.tenantId);
    expect(s0.metaCalls - before).toBe(1);
    expect(s0.dispatches).toHaveLength(1);
    expect(s0.dispatches[0]).toMatchObject({ external_id: sent.notificationId, status: "accepted", wamid: r.providerMessageId });
    expect(s0.holds).toHaveLength(1);
    expect(s0.holds[0].status).toBe("active");
    expect(s0.wallet).toBe(1000);

    await metaStatus(w, r.providerMessageId!, "sent", true);
    expect(await until(() => state(w.tenantId), (s) => s.ledger === 1)).toMatchObject({ ledger: 1 });
    const s1 = await state(w.tenantId);
    expect(s1.wallet).toBeLessThan(1000);
    expect(s1.holds[0].status).toBe("consumed");

    await metaStatus(w, r.providerMessageId!, "delivered");
    expect((await pollRow(sent.notificationId, (x) => x.status === "DELIVERED")).deliveredAt).not.toBeNull();
    await metaStatus(w, r.providerMessageId!, "read");
    expect((await pollRow(sent.notificationId, (x) => x.status === "READ")).readAt).not.toBeNull();
    // one WhatsApp, one charge, in the patient timeline as before
    const end = await state(w.tenantId);
    expect(end.metaCalls - before).toBe(1);
    expect(end.ledger).toBe(1);
  });

  it("E2E-11/15: duplicate Meta statuses bill once; duplicate callbacks change nothing", async () => {
    const { tt, w } = await fresh();
    const sent = await followUp(tt);
    const wamid = (await row(sent.notificationId)).providerMessageId!;
    for (let i = 0; i < 3; i++) await metaStatus(w, wamid, "sent", true);
    for (let i = 0; i < 2; i++) await metaStatus(w, wamid, "delivered");
    await pollRow(sent.notificationId, (x) => x.status === "DELIVERED");
    await sleep(1200);
    const s = await state(w.tenantId);
    expect(s.ledger).toBe(1);
    expect(s.outbox.filter((o: any) => o.event_id.endsWith(":delivered"))).toHaveLength(1); // one callback event per status
    const events = await db.select().from(connectorEvents).where(and(eq(connectorEvents.tenantId, tt.tenantId), eq(connectorEvents.direction, "inbound")));
    expect(events.filter((e) => e.externalEventId.includes(":delivered"))).toHaveLength(1);
    expect((await row(sent.notificationId)).status).toBe("DELIVERED");
  });

  it("E2E-05/06/23: a wrong key, another hospital's key, and a rotated-away key are all refused — nothing is sent", async () => {
    const { tt, w } = await fresh();
    const other = await provision(tt); // a different WhatsNexus tenant with its own valid key
    const base = (await state(w.tenantId)).metaCalls;

    await setApiKey(tt, "wnpk_deadbeef_thisIsNotTheKeyAtAllNopeNopeNope");
    let f = await followUp(tt);
    expect(f.status).toBe("FAILED");
    expect((await row(f.notificationId)).reason).toContain("INVALID_CREDENTIALS");

    await setApiKey(tt, other.apiKey); // valid key, but for the OTHER tenant
    f = await followUp(tt);
    expect(f.status).toBe("FAILED");
    expect((await row(f.notificationId)).reason).toContain("INVALID_CREDENTIALS");
    expect((await state(w.tenantId)).metaCalls).toBe(base);
    expect((await state(w.tenantId)).dispatches).toHaveLength(0);

    // rotation: with no overlap the previous key stops working immediately; configuring the new one restores service
    await setApiKey(tt, w.apiKey);
    const ok = await followUp(tt);
    expect(ok.status).toBe("SENT");
    const rot = await wn("/__test/rotate", { tenantId: w.tenantId, overlapSeconds: 0 });
    const stale = await followUp(tt);
    expect(stale.status).toBe("FAILED");
    expect((await row(stale.notificationId)).reason).toContain("INVALID_CREDENTIALS");
    await setApiKey(tt, rot.apiKey);
    expect((await followUp(tt)).status).toBe("SENT");
    // a healthy provider, an unrelated integration and the Hub keep working
    expect((await call(tt, "SUPER_ADMIN", "GET", "/integrations/hub")).statusCode).toBe(200);
  });

  it("E2E-07: no balance → WhatsNexus refuses before Meta; no hold, no charge, a visible permanent reason", async () => {
    const { tt, w } = await fresh({ balance: 0 });
    const metaBefore = (await state(w.tenantId)).metaCalls;
    const f = await followUp(tt);
    expect(f.status).toBe("FAILED");
    expect((await row(f.notificationId)).reason).toContain("INSUFFICIENT_BALANCE");
    const s = await state(w.tenantId);
    expect(s.metaCalls).toBe(metaBefore); // Meta was never contacted
    expect(s.holds).toHaveLength(0);
    expect(s.ledger).toBe(0);
    expect(s.wallet).toBe(0);
  });

  it("E2E-22: integration switched off on the WhatsNexus side → refused permanently, nothing sent", async () => {
    const { tt, w } = await fresh();
    await wn("/__test/integration", { tenantId: w.tenantId, enabled: false });
    const before = (await state(w.tenantId)).metaCalls;
    const f = await followUp(tt);
    expect(f.status).toBe("FAILED");
    expect((await row(f.notificationId)).reason).toContain("INTEGRATION_DISABLED");
    expect((await state(w.tenantId)).metaCalls).toBe(before);
    const probe = await call(tt, "SUPER_ADMIN", "POST", "/integrations/hub/whatsnexus/status");
    expect(probe.json()).toMatchObject({ ok: false });
    expect(probe.json().message).toContain("switched off");
  });

  it("E2E-09: PulseOS retries of one notification (same key) reach Meta once, even concurrently", async () => {
    const { tt, w } = await fresh();
    const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus")));
    const config = { ...(c!.configuration as Record<string, unknown>), mode: "live", pulseosTenantId: tt.tenantId };
    const key = "11111111-2222-4333-8444-555555555555";
    const before = (await state(w.tenantId)).metaCalls;
    await wn("/__test/meta", { mode: "accept", delayAfterAcceptMs: 400 });
    const patient = phone();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => whatsNexusAdapter.sendTemplate(config, { apiKey: w.apiKey }, patient, { name: "follow_up_message", language: "en", parameters: ["A", "B", "C"], idempotencyKey: key })));
    await wn("/__test/meta", { mode: "accept" });
    const wamids = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ providerMessageId: string }>).value.providerMessageId);
    expect(wamids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(wamids).size).toBe(1);
    expect((await state(w.tenantId)).metaCalls - before).toBe(1);
    // a later retry replays the stored result
    const again = await whatsNexusAdapter.sendTemplate(config, { apiKey: w.apiKey }, patient, { name: "follow_up_message", language: "en", parameters: ["A", "B", "C"], idempotencyKey: key });
    expect(again.providerMessageId).toBe(wamids[0]);
    expect((await state(w.tenantId)).metaCalls - before).toBe(1);
    // …and the SAME key with a different payload is refused outright (never silently re-sent).
    await expect(whatsNexusAdapter.sendTemplate(config, { apiKey: w.apiKey }, phone(), { name: "follow_up_message", language: "en", parameters: ["A", "B", "C"], idempotencyKey: key })).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    expect((await state(w.tenantId)).metaCalls - before).toBe(1);
  });

  it("E2E-10: Meta accepted but the response was lost → unknown outcome, NEVER re-sent, later proven by Meta's own status", async () => {
    const { tt, w } = await fresh();
    const base = (await state(w.tenantId)).metaCalls;
    await wn("/__test/meta", { mode: "accept_then_lose_response" });
    const f = await followUp(tt);
    await wn("/__test/meta", { mode: "accept" });
    expect(f.status).toBe("FAILED");
    expect((await row(f.notificationId)).reason).toMatch(/^OUTCOME_UNKNOWN/);
    const s = await state(w.tenantId);
    expect(s.dispatches[0]).toMatchObject({ status: "unknown_outcome", wamid: null });
    expect(s.holds[0].status).toBe("active"); // the reservation is kept
    expect(s.metaCalls - base).toBe(1);

    // PulseOS's read-only reconcile keeps asking; WhatsNexus is still unsure → no change, still no resend
    const tally = await reconcileWhatsNexusOutcomes(db, new Date());
    expect(tally.pending).toBeGreaterThanOrEqual(1);
    expect((await row(f.notificationId)).reason).toMatch(/^OUTCOME_UNKNOWN/);
    expect((await state(w.tenantId)).metaCalls - base).toBe(1);

    // Meta's own status for the message that WAS accepted proves the outcome; the chain heals end to end.
    await metaStatus(w, s.acceptedLost, "sent", true, f.phoneDigits);
    await metaStatus(w, s.acceptedLost, "delivered", false, f.phoneDigits);
    const healed = await pollRow(f.notificationId, (x) => x.status === "DELIVERED", 10000);
    expect(healed).toMatchObject({ status: "DELIVERED", providerMessageId: s.acceptedLost, reason: null });
    const end = await state(w.tenantId);
    expect(end.dispatches[0].status).toBe("accepted");
    expect(end.metaCalls - base).toBe(1); // exactly one WhatsApp, ever
    expect(end.ledger).toBe(1);
  });

  it("E2E-14: Meta reports a status while the send call is still in flight → parked, then delivered; the final state is correct", async () => {
    const { tt, w } = await fresh();
    await wn("/__test/meta", { mode: "accept", delayAfterAcceptMs: 1500 });
    const { journeyId, phoneDigits } = await journey(tt);
    const pending = pressSend(tt, journeyId); // the send call is held open for 1.5 s inside "Meta"
    const wamid = (await until(() => state(w.tenantId), (s) => !!s.lastWamid)).lastWamid as string;
    await metaStatus(w, wamid, "sent", true, phoneDigits); // Meta has already reported — before PulseOS has its answer
    await metaStatus(w, wamid, "delivered", false, phoneDigits);
    const f = await pending;
    await wn("/__test/meta", { mode: "accept" });
    expect(f.status).toBe("SENT");
    const done = await pollRow(f.notificationId, (x) => x.status === "DELIVERED", 10000);
    expect(done).toMatchObject({ status: "DELIVERED", providerMessageId: wamid });
    expect(done.sentAt).not.toBeNull();
    const s = await until(() => state(w.tenantId), (x) => x.ledger === 1 && x.holds[0]?.status !== "active", 10000);
    expect(s.ledger).toBe(1);
    expect(s.holds).toHaveLength(1);
    expect(s.holds[0].status).not.toBe("active"); // billed before the wamid was stored: the reservation must still be settled
    expect(s.wallet).toBeLessThan(1000);
  });

  it("E2E-17: callback worker down → events stay durable and are delivered once it is back", async () => {
    const { tt, w } = await fresh();
    const f = await followUp(tt);
    const wamid = (await row(f.notificationId)).providerMessageId!;
    await wn("/__test/worker", { on: false });
    await metaStatus(w, wamid, "delivered");
    await metaStatus(w, wamid, "read");
    await sleep(1200);
    const s = await state(w.tenantId);
    expect(s.outbox.map((o: any) => o.status)).toEqual(["pending", "pending"]);
    expect((await row(f.notificationId)).status).toBe("SENT");
    await wn("/__test/worker", { on: true });
    expect((await pollRow(f.notificationId, (x) => x.status === "READ", 10000)).status).toBe("READ");
    // PulseOS applies the callback before WhatsNexus has marked the row 'sent' (the receiver answers first): wait for it.
    const drained = await until(() => state(w.tenantId), (x) => x.outbox.every((o: any) => o.status === "sent"), 5000);
    expect(drained.outbox.every((o: any) => o.status === "sent")).toBe(true);
  });

  it("E2E-16: a callback signed with another hospital's secret, or aimed at another hospital's URL, is rejected and changes nothing", async () => {
    const a = await fresh();
    const b = await fresh();
    const f = await followUp(a.tt);
    const wamid = (await row(f.notificationId)).providerMessageId!;
    const body = JSON.stringify({ eventId: `x:${f.notificationId}:read`, dispatchId: "d", externalId: f.notificationId, wamid, status: "read", occurredAt: new Date().toISOString() });
    const ts = String(Math.floor(Date.now() / 1000));
    const post = (tenantId: string, secret: string) => fetch(`http://127.0.0.1:${pulseosPort}/webhooks/whatsnexus/${tenantId}`, { method: "POST", headers: { "content-type": "application/json", "x-whatsnexus-timestamp": ts, "x-whatsnexus-signature": signWebhookBody(secret, ts, body) }, body });
    expect((await post(a.tt.tenantId, b.w.callbackSecret)).status).toBe(401); // B's secret on A
    expect((await post(b.tt.tenantId, a.w.callbackSecret)).status).toBe(401); // A's secret on B
    const crossed = await post(b.tt.tenantId, b.w.callbackSecret); // B's own valid secret, A's notification id
    expect(await crossed.json()).toMatchObject({ applied: false, reason: "unknown_notification" });
    expect((await row(f.notificationId)).status).toBe("SENT");
  });
});
