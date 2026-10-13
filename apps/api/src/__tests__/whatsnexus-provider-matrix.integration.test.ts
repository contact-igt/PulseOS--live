import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, connectors, notifications, scheduleResources, tasks } from "../db/schema.js";
import { getMessagingAdapter } from "../domain/connector/registry.js";
import { createWhatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { PermanentSendError, RetryableSendError, type MessagingProviderAdapter } from "../domain/connector/types.js";
import { processDueNotifications } from "../domain/notification/notification.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

/**
 * Provider-selection matrix for scheduled appointment reminders (the planner and the worker, not just staff follow-ups):
 * neither / Meta only / WhatsNexus configured but not selected / WhatsNexus selected / temporarily unavailable / provider
 * changed mid-retry / permanent failure. No network: both providers are doubles; nothing is ever sent.
 */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("provider selection matrix for reminders (integration)", () => {
  let app: FastifyInstance;
  const created: TestTenant[] = [];
  const resourceOf = new Map<string, string>();
  let n = 0;
  let slot = 0;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(91000000 + ++n * 43).padStart(8, "0")}`;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000 + ++slot * 60_000);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (ok(v) || Date.now() > end) return v;
      await sleep(50);
    }
  }

  async function tenant(opts: { meta?: boolean; whatsnexus?: "selected" | "configured" | "none" }) {
    const tt = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    created.push(tt);
    await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    resourceOf.set(tt.tenantId, (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, tt.userIds.DOCTOR!)))[0]!.id);
    if (opts.meta) expect((await call(tt, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "pn-test" } })).statusCode).toBe(200);
    if (opts.whatsnexus && opts.whatsnexus !== "none") {
      const put = (b: object) => call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", b);
      expect((await put({ configuration: { baseUrl: "https://wn.example.com", tenantId: "TT001" } })).statusCode).toBe(200);
      expect((await put({ secrets: { apiKey: "wnpk_matrix_key_0123456789abcdef", callbackSecret: "whcs_matrix_secret_0123456789abcd" }, mode: "LIVE" })).statusCode).toBe(200);
      await db.update(connectors).set({ status: "CONNECTED" }).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus"))); // stands in for a passed health check
      if (opts.whatsnexus === "selected") expect((await put({ configuration: { useForSending: "true" } })).statusCode).toBe(200);
    }
    return tt;
  }
  const selectProvider = (tt: TestTenant, whatsnexus: boolean) => call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: whatsnexus ? "true" : "" } });

  /** Books and confirms a visit; the confirmation + reminders are planned from the domain event. */
  async function book(tt: TestTenant, hours = 30) {
    const lead = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Asha Rao", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    const { patientId, journeyId } = lead.json() as { patientId: string; journeyId: string };
    const res = await call(tt, "FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: tt.branchId, doctorId: resourceOf.get(tt.tenantId)!, scheduledAt: inHours(hours).toISOString(), reason: "Consultation" });
    expect(res.statusCode).toBe(201);
    const appt = res.json() as AppointmentRow;
    expect((await call(tt, "FRONT_DESK", "PATCH", `/appointments/${appt.id}/action`, { action: "confirm" })).statusCode).toBe(200);
    const rows = await until(() => db.select().from(notifications).where(eq(notifications.subjectId, appt.id)), (r) => r.length >= 3);
    return { appt, rows };
  }
  const rowsFor = (apptId: string) => db.select().from(notifications).where(eq(notifications.subjectId, apptId));

  type Calls = { whatsnexus: { key: string | undefined; provider: string | null }[]; meta: number };
  /** Adapters for one tick. WhatsNexus behaviour is scripted; Meta is the real adapter in fixture mode only. */
  function adapters(whatsnexus: (calls: Calls) => Promise<{ providerMessageId: string }> | never) {
    const calls: Calls = { whatsnexus: [], meta: 0 };
    const real = getMessagingAdapter("whatsapp_meta_cloud")!;
    const meta: MessagingProviderAdapter = {
      ...real,
      sendTemplate: async (cfg, sec, to, tpl) => {
        if (cfg.mode !== "fixture") throw new Error("test guard: refusing a non-fixture send");
        calls.meta += 1;
        return real.sendTemplate(cfg, sec, to, tpl);
      },
    };
    const wn: MessagingProviderAdapter = { ...createWhatsNexusAdapter(), sendTemplate: async () => { throw new Error("replaced below"); } };
    wn.sendTemplate = async (_c, _s, _to, tpl) => {
      // The provider must already be recorded on the notification when the send happens.
      const [r] = await db.select({ provider: notifications.provider }).from(notifications).where(eq(notifications.id, tpl.idempotencyKey!));
      calls.whatsnexus.push({ key: tpl.idempotencyKey, provider: r?.provider ?? null });
      return whatsnexus(calls);
    };
    return { calls, deps: { adapterFor: (p: string) => (p === "whatsnexus" ? wn : p === "whatsapp_meta_cloud" ? meta : null) } };
  }
  const tick = (deps: ReturnType<typeof adapters>["deps"], plusMs = 1000) => processDueNotifications(db, new Date(Date.now() + plusMs), deps);
  const ok = (id = "wamid.MATRIX") => async () => ({ providerMessageId: `${id}${++n}` });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  // The worker tick handles EVERY hospital's due rows: park whatever a scenario left pending so scenarios cannot affect each other.
  afterEach(async () => {
    for (const tt of created) await db.update(notifications).set({ status: "CANCELLED", reason: "TEST_CLEANUP" }).where(and(eq(notifications.tenantId, tt.tenantId), eq(notifications.status, "PENDING")));
  });
  afterAll(async () => {
    for (const tt of created) {
      await db.delete(tasks).where(eq(tasks.tenantId, tt.tenantId));
      await db.delete(appointments).where(eq(appointments.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  it("neither provider configured: reminders are BLOCKED with a clear reason, nothing is sent", async () => {
    const tt = await tenant({ meta: false, whatsnexus: "none" });
    const { appt } = await book(tt);
    const a = adapters(ok());
    await tick(a.deps);
    const rows = await rowsFor(appt.id);
    expect(rows.filter((r) => r.status === "BLOCKED" && r.reason === "PROVIDER_NOT_CONFIGURED").length).toBeGreaterThanOrEqual(1);
    expect(a.calls.meta + a.calls.whatsnexus.length).toBe(0);
  });

  it("WhatsNexus configured but NOT selected, Meta present: Meta stays the provider (existing behaviour), WhatsNexus is never used", async () => {
    const tt = await tenant({ meta: true, whatsnexus: "configured" });
    const { appt } = await book(tt);
    const a = adapters(ok());
    await tick(a.deps);
    const sent = (await rowsFor(appt.id)).filter((r) => r.status === "SENT");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.every((r) => r.provider === "whatsapp_meta_cloud" && /^FIXTURE_WAMID_/.test(r.providerMessageId!))).toBe(true);
    expect(a.calls.whatsnexus).toHaveLength(0);
  });

  it("WhatsNexus selected explicitly (Meta also present): only WhatsNexus is used, with the real id and the notification id as idempotency key; the schedule is the same", async () => {
    const meta = await tenant({ meta: true, whatsnexus: "none" });
    const wn = await tenant({ meta: true, whatsnexus: "selected" });
    const [m, w] = [await book(meta), await book(wn)];
    // Same rules → same plan, whichever provider will send it.
    const shape = (rows: typeof m.rows, apptAt: Date) => rows.map((r) => { const min = Math.round((apptAt.getTime() - r.scheduledFor.getTime()) / 60_000); return `${r.status}|${min > 1500 ? "immediate" : min}`; }).sort();
    expect(shape(w.rows, new Date(w.appt.scheduledAt))).toEqual(shape(m.rows, new Date(m.appt.scheduledAt)));
    expect(w.rows.length).toBe(m.rows.length);

    const a = adapters(ok("wamid.SEL"));
    await tick(a.deps);
    const sent = (await rowsFor(w.appt.id)).filter((r) => r.status === "SENT");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const r of sent) {
      expect(r.provider).toBe("whatsnexus");
      expect(r.providerMessageId).toMatch(/^wamid\.SEL/);
    }
    expect(a.calls.whatsnexus.every((c) => sent.some((r) => r.id === c.key))).toBe(true); // key = notification id
    expect(a.calls.whatsnexus.every((c) => c.provider === "whatsnexus")).toBe(true); // provider persisted BEFORE the send
    expect(a.calls.whatsnexus).toHaveLength(sent.length); // exactly one logical dispatch per notification
  });

  it("WhatsNexus temporarily unavailable: the reminder is retried later with the SAME key; it is not lost and not duplicated", async () => {
    const tt = await tenant({ meta: true, whatsnexus: "selected" });
    const { appt } = await book(tt);
    const down = adapters(async () => { throw new RetryableSendError("WhatsNexus unreachable (ECONNREFUSED)", "unreachable"); });
    await tick(down.deps);
    const afterDown = (await rowsFor(appt.id)).filter((r) => r.attempts >= 1);
    expect(afterDown.length).toBeGreaterThanOrEqual(1);
    expect(afterDown.every((r) => r.status === "PENDING" && r.attempts === 1 && /unreachable/i.test(r.reason ?? ""))).toBe(true);
    expect(afterDown.every((r) => r.scheduledFor.getTime() > Date.now() + 60_000)).toBe(true); // rescheduled, not dropped
    expect(down.calls.meta).toBe(0); // and no fall-back to Meta

    const up = adapters(ok("wamid.RETRY"));
    await tick(up.deps, 5 * 60_000); // after the retry delay
    const done = (await rowsFor(appt.id)).filter((r) => r.status === "SENT");
    expect(done.length).toBe(afterDown.length);
    // identical idempotency key on both attempts
    for (const r of done) {
      expect(down.calls.whatsnexus.map((c) => c.key)).toContain(r.id);
      expect(up.calls.whatsnexus.map((c) => c.key)).toContain(r.id);
    }
    expect(up.calls.meta).toBe(0);
  });

  it("provider switched while a retry is pending: the message is BLOCKED (PROVIDER_CHANGED), never silently sent through the other provider", async () => {
    const tt = await tenant({ meta: true, whatsnexus: "selected" });
    const { appt } = await book(tt);
    await tick(adapters(async () => { throw new RetryableSendError("down", "unreachable"); }).deps);
    expect((await selectProvider(tt, false)).statusCode).toBe(200); // admin goes back to Meta
    const a = adapters(ok());
    await tick(a.deps, 5 * 60_000);
    const rows = (await rowsFor(appt.id)).filter((r) => r.attempts >= 1);
    expect(rows.every((r) => r.status === "BLOCKED" && r.reason === "PROVIDER_CHANGED")).toBe(true);
    expect(a.calls.meta + a.calls.whatsnexus.length).toBe(0);
  });

  it("a permanent WhatsNexus failure (e.g. template not approved) is final: one attempt, visible reason, no retry, no Meta fallback", async () => {
    const tt = await tenant({ meta: true, whatsnexus: "selected" });
    const { appt } = await book(tt);
    const a = adapters(async () => { throw new PermanentSendError("TEMPLATE_NOT_APPROVED: Template is not approved", "TEMPLATE_NOT_APPROVED"); });
    await tick(a.deps);
    const rows = (await rowsFor(appt.id)).filter((r) => r.attempts >= 1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.status === "FAILED" && r.attempts === 1 && r.reason!.includes("TEMPLATE_NOT_APPROVED"))).toBe(true);
    await tick(a.deps, 30 * 60_000);
    expect((await rowsFor(appt.id)).filter((r) => r.attempts >= 1).every((r) => r.attempts === 1)).toBe(true);
    expect(a.calls.meta).toBe(0);
  });

  it("WhatsNexus selected but switched off / not live: reminders are BLOCKED, never sent via Meta", async () => {
    const tt = await tenant({ meta: true, whatsnexus: "selected" });
    const { appt } = await book(tt);
    await db.update(connectors).set({ status: "DISABLED" }).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus")));
    const a = adapters(ok());
    await tick(a.deps);
    const rows = (await rowsFor(appt.id)).filter((r) => r.status === "BLOCKED");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.reason === "PROVIDER_NOT_READY")).toBe(true);
    expect(a.calls.meta + a.calls.whatsnexus.length).toBe(0);
    void vi;
  });
});
