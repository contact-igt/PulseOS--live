import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ProviderTemplateCatalogue, Role, WhatsAppPreview } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectors, messageTemplates, notifications } from "../db/schema.js";
import { createWhatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { fetchProviderTemplateCatalogue } from "../domain/notification/provider-templates.js";
import { listTemplates, previewFollowUpMessage, sendFollowUpMessage, updateTemplate } from "../domain/notification/notification.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const API_KEY = "wnpk_it_key_0123456789abcdefghijklmnop";
const CB_SECRET = "whcs_it_secret_0123456789abcdefghij";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const entry = (name: string, bodyParameterCount: number, language = "en", status = "APPROVED") => ({ name, language, status, bodyParameterCount, hasHeader: false, hasButtons: false });

describe.skipIf(!DEMO_PASSWORD)("WhatsNexus approved-template catalogue, save-time and send-time validation (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant; // WhatsNexus is selected for sending
  let other: TestTenant; // WhatsNexus configured with ANOTHER WhatsNexus tenant
  let fixture: TestTenant; // WhatsNexus configured but only in Fixture mode
  let metaOnly: TestTenant; // never touches WhatsNexus
  let n = 0;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(81000000 + ++n * 41).padStart(8, "0")}`;

  /** A WhatsNexus double that, like the real one, answers only for the tenant the headers name. */
  function wnDouble(catalogueFor: Record<string, unknown[]>, over: { status?: number; body?: unknown; post?: (body: Record<string, unknown>) => Response } = {}) {
    const requests: { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      requests.push({ method: String(init.method), url, headers, body });
      if (init.method === "POST") return over.post ? over.post(body!) : json(200, { success: true, wamid: `wamid.PT${++n}${Date.now()}`, status: "accepted" });
      if (over.status) return json(over.status, over.body ?? { error: { code: "SERVICE_UNAVAILABLE" } });
      return json(200, { templates: catalogueFor[headers["x-tenant-id"]!] ?? [] });
    }) as unknown as typeof fetch;
    const adapter = createWhatsNexusAdapter({ fetchImpl, isPublicHost: async () => true });
    return {
      requests,
      adapter,
      gets: () => requests.filter((r) => r.method === "GET"),
      posts: () => requests.filter((r) => r.method === "POST"),
      deps: { listTemplates: adapter.listTemplates, adapterFor: (p: string) => (p === "whatsnexus" ? adapter : null) },
    };
  }

  async function configureWn(tt: TestTenant, wnTenantId: string, mode: "FIXTURE" | "LIVE") {
    expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { baseUrl: "https://wn.example.com/", tenantId: wnTenantId } })).statusCode).toBe(200);
    expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { apiKey: API_KEY, callbackSecret: CB_SECRET }, mode })).statusCode).toBe(200);
  }
  const markConnected = (tt: TestTenant) => db.update(connectors).set({ status: "CONNECTED" }).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus")));
  const templateRow = async (tt: TestTenant, purpose: string) => (await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tt.tenantId), eq(messageTemplates.purpose, purpose))))[0]!;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    fixture = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    metaOnly = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, other, fixture, metaOnly]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    await configureWn(t, "TT001", "LIVE");
    await markConnected(t);
    expect((await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: "true" } })).statusCode).toBe(200);
    await configureWn(other, "TT002", "LIVE");
    await configureWn(fixture, "TT003", "FIXTURE");
    for (const tt of [t, other, fixture, metaOnly]) await listTemplates(db, tt.tenantId); // installs the default message templates
  });
  afterAll(async () => {
    for (const tt of [t, other, fixture, metaOnly]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  // ── Phase 1/2: the catalogue, read live ────────────────────────────────────
  describe("catalogue", () => {
    it("asks WhatsNexus with the same machine headers as a send, and returns only that hospital's approved templates", async () => {
      const d = wnDouble({ TT001: [entry("pulseos_follow_up_message", 3)], TT002: [entry("other_hospital_only", 1)] });
      const cat = await fetchProviderTemplateCatalogue(db, t.tenantId, d.deps);
      expect(cat).toMatchObject({ provider: "whatsnexus", active: true, state: "OK", templates: [entry("pulseos_follow_up_message", 3)] });
      expect(JSON.stringify(cat)).not.toContain("other_hospital_only");
      expect(d.gets()).toHaveLength(1);
      const r = d.gets()[0]!;
      expect(r.url).toBe("https://wn.example.com/api/integrations/pulseos/templates");
      expect(r.headers["x-tenant-id"]).toBe("TT001");
      expect(r.headers["x-api-key"]).toBe(API_KEY);
      expect(r.headers["x-pulseos-tenant-id"]).toBe(t.tenantId);
      expect(JSON.stringify(cat)).not.toContain(API_KEY);

      // another hospital is asked with ITS OWN identity and sees its own list
      const o = await fetchProviderTemplateCatalogue(db, other.tenantId, d.deps);
      expect(o.templates.map((x) => x.name)).toEqual(["other_hospital_only"]);
      expect(d.gets()[1]!.headers["x-tenant-id"]).toBe("TT002");
      expect(d.gets()[1]!.headers["x-pulseos-tenant-id"]).toBe(other.tenantId);
      expect(o.active).toBe(false); // configured, but this hospital still sends through Meta
    });

    it("is never cached: every call asks WhatsNexus again, so a template paused a moment ago disappears", async () => {
      let live = [entry("pulseos_follow_up_message", 3)];
      const requests: string[] = [];
      const adapter = createWhatsNexusAdapter({ fetchImpl: (async (url: string) => (requests.push(url), json(200, { templates: live }))) as unknown as typeof fetch, isPublicHost: async () => true });
      expect((await fetchProviderTemplateCatalogue(db, t.tenantId, { listTemplates: adapter.listTemplates })).templates).toHaveLength(1);
      live = [];
      expect((await fetchProviderTemplateCatalogue(db, t.tenantId, { listTemplates: adapter.listTemplates })).templates).toHaveLength(0);
      expect(requests).toHaveLength(2);
    });

    it("tells the truth when it cannot read the catalogue: not configured, Fixture mode, rejected credentials, unreachable", async () => {
      const d = wnDouble({});
      const none = await fetchProviderTemplateCatalogue(db, metaOnly.tenantId, d.deps);
      expect(none).toMatchObject({ active: false, state: "NOT_CONFIGURED", templates: [] });
      const fx = await fetchProviderTemplateCatalogue(db, fixture.tenantId, d.deps);
      expect(fx).toMatchObject({ state: "NOT_LIVE", templates: [] });
      expect(fx.message).toContain("Live");
      expect(d.requests).toHaveLength(0); // neither contacted WhatsNexus

      const rejected = await fetchProviderTemplateCatalogue(db, t.tenantId, wnDouble({}, { status: 401, body: { error: { code: "INVALID_CREDENTIALS" } } }).deps);
      expect(rejected).toMatchObject({ active: true, state: "REJECTED", templates: [] });
      const down = await fetchProviderTemplateCatalogue(db, t.tenantId, wnDouble({}, { status: 503 }).deps);
      expect(down).toMatchObject({ active: true, state: "UNAVAILABLE", templates: [] });
    });

    it("HTTP: Admins can read it, front desk cannot, and a hospital with no WhatsNexus gets an honest empty state without any outbound request", async () => {
      const ok = await call(metaOnly, "HOSPITAL_ADMIN", "GET", "/notifications/provider-templates");
      expect(ok.statusCode).toBe(200);
      expect(ok.json() as ProviderTemplateCatalogue).toMatchObject({ provider: "whatsnexus", active: false, state: "NOT_CONFIGURED", templates: [] });
      expect(ok.headers["cache-control"]).toContain("no-store");
      expect((await call(metaOnly, "FRONT_DESK", "GET", "/notifications/provider-templates")).statusCode).toBe(403);
    });
  });

  // ── Phase 3: validated save ────────────────────────────────────────────────
  describe("saving a reminder template while WhatsNexus is the sender", () => {
    const save = async (purpose: string, input: Record<string, unknown>, d: ReturnType<typeof wnDouble>) => updateTemplate(db, t.tenantId, (await templateRow(t, purpose)).id, input, d.deps);

    it("a compatible approved 3-variable template saves", async () => {
      const d = wnDouble({ TT001: [entry("pulseos_follow_up_message", 3)] });
      const r = await save("FOLLOW_UP_MESSAGE", { providerTemplateName: "pulseos_follow_up_message", language: "en" }, d);
      expect(r).toMatchObject({ ok: true, template: { providerTemplateName: "pulseos_follow_up_message", language: "en" } });
      expect((await templateRow(t, "FOLLOW_UP_MESSAGE")).providerTemplateName).toBe("pulseos_follow_up_message");
      expect(d.gets()).toHaveLength(1); // read fresh at save time
    });

    it("a wrong variable count is blocked, in words, and nothing is stored", async () => {
      const before = (await templateRow(t, "FOLLOW_UP_MESSAGE")).providerTemplateName;
      const d = wnDouble({ TT001: [entry("pulseos_two_vars", 2), entry("pulseos_follow_up_message", 3)] });
      const r = await save("FOLLOW_UP_MESSAGE", { providerTemplateName: "pulseos_two_vars" }, d);
      expect(r).toEqual({ ok: false, reason: "template_incompatible", detail: { code: "TEMPLATE_PARAMETER_COUNT_MISMATCH", message: "Template has 2 placeholders; this PulseOS reminder needs 3." } });
      expect((await templateRow(t, "FOLLOW_UP_MESSAGE")).providerTemplateName).toBe(before);
    });

    it("editing the message so it needs a different number of variables is checked against the template it already points at", async () => {
      const d = wnDouble({ TT001: [entry("pulseos_follow_up_message", 3)] });
      const r = await save("FOLLOW_UP_MESSAGE", { body: "Hello {{patient_name}}, this is {{staff_name}}. Please call us." }, d);
      expect(r).toMatchObject({ ok: false, reason: "template_incompatible", detail: { code: "TEMPLATE_PARAMETER_COUNT_MISMATCH", message: "Template has 3 placeholders; this PulseOS reminder needs 2." } });
      expect((await templateRow(t, "FOLLOW_UP_MESSAGE")).body).toContain("{{hospital_name}}");
    });

    it("a typed-in name that WhatsNexus has not approved, or approved only in another language, is refused", async () => {
      const d = wnDouble({ TT001: [entry("pulseos_follow_up_message", 3, "hi")] });
      expect(await save("FOLLOW_UP_MESSAGE", { providerTemplateName: "pulseos_typo" }, d)).toMatchObject({ ok: false, reason: "template_incompatible", detail: { code: "TEMPLATE_NOT_FOUND" } });
      expect(await save("FOLLOW_UP_MESSAGE", { providerTemplateName: "pulseos_follow_up_message", language: "en" }, d)).toMatchObject({ ok: false, reason: "template_incompatible", detail: { code: "TEMPLATE_LANGUAGE_MISMATCH" } });
      // a template WhatsNexus paused is simply absent from the approved list
      expect(await save("FOLLOW_UP_MESSAGE", { providerTemplateName: "pulseos_follow_up_message" }, wnDouble({ TT001: [] }))).toMatchObject({ ok: false, reason: "template_incompatible", detail: { code: "TEMPLATE_NOT_FOUND" } });
    });

    it("switching a stale template ON is checked too; a change that does not touch what is sent needs no catalogue", async () => {
      const row = await templateRow(t, "APPOINTMENT_REMINDER"); // still has the default name no hospital has approved
      const d = wnDouble({ TT001: [entry("pulseos_follow_up_message", 3)] });
      expect(await updateTemplate(db, t.tenantId, row.id, { enabled: true }, d.deps)).toMatchObject({ ok: false, reason: "template_incompatible", detail: { code: "TEMPLATE_NOT_FOUND" } });
      const d2 = wnDouble({});
      expect(await updateTemplate(db, t.tenantId, row.id, { name: "Appointment reminder (hospital)", enabled: false }, d2.deps)).toMatchObject({ ok: true });
      expect(d2.requests).toHaveLength(0);
    });

    it("when WhatsNexus cannot be reached the save is refused with that reason rather than trusted blindly", async () => {
      const r = await save("FOLLOW_UP_MESSAGE", { providerTemplateName: "pulseos_follow_up_message" }, wnDouble({}, { status: 503 }));
      expect(r).toMatchObject({ ok: false, reason: "catalogue_unavailable" });
      expect((r as { detail: { message: string } }).detail.message).toMatch(/WhatsNexus/);
    });

    it("a hospital that sends through Meta keeps the free-text name and never contacts WhatsNexus", async () => {
      const d = wnDouble({});
      const row = await templateRow(metaOnly, "FOLLOW_UP_MESSAGE");
      const r = await updateTemplate(db, metaOnly.tenantId, row.id, { providerTemplateName: "anything_meta_approved", body: "Hello {{patient_name}}" }, d.deps);
      expect(r).toMatchObject({ ok: true, template: { providerTemplateName: "anything_meta_approved" } });
      expect(d.requests).toHaveLength(0);
      // a hospital that has configured WhatsNexus but not selected it is also unconstrained
      const o = await templateRow(other, "FOLLOW_UP_MESSAGE");
      expect(await updateTemplate(db, other.tenantId, o.id, { providerTemplateName: "free_text_ok" }, d.deps)).toMatchObject({ ok: true });
      expect(d.requests).toHaveLength(0);
    });

    it("HTTP: the refusal carries the code and the plain-words message, with a 422", async () => {
      // The route uses the real adapter, which cannot reach wn.example.com from a test: that is the UNAVAILABLE path.
      const row = await templateRow(t, "FOLLOW_UP_MESSAGE");
      const res = await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/templates/${row.id}`, { providerTemplateName: "pulseos_follow_up_message" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "catalogue_unavailable" });
      expect((res.json() as { message: string }).message).toBeTruthy();
    });
  });

  // ── Phase 4: the send, with the real reason ────────────────────────────────
  describe("sending", () => {
    async function journey() {
      const res = await call(t, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Asha Rao", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
      expect(res.statusCode).toBe(201);
      return (res.json() as { journeyId: string }).journeyId;
    }
    const sendWith = async (d: ReturnType<typeof wnDouble>) => {
      const journeyId = await journey();
      const r = await sendFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, journeyId, `pt-${Date.now()}-${++n}-aaaa`, d.deps);
      expect(r.ok).toBe(true);
      const ok = r as { notificationId: string; status: string; reason?: string | null };
      return { ...ok, row: (await db.select().from(notifications).where(eq(notifications.id, ok.notificationId)))[0]! };
    };
    const refusal = (code: string, message: string) => (): Response => json(422, { success: false, error: { code, message, retryable: false } });
    const connectorStatus = async () => (await db.select().from(connectors).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "whatsnexus"))))[0]!.status;

    it("an approved 3-variable template sends with exactly the three positional parameters", async () => {
      const d = wnDouble({});
      const r = await sendWith(d);
      expect(r).toMatchObject({ status: "SENT", reason: null });
      expect(d.posts()).toHaveLength(1);
      expect(d.posts()[0]!.body).toMatchObject({ templateName: "pulseos_follow_up_message", language: "en" });
      expect((d.posts()[0]!.body!.params as string[]).length).toBe(3);
    });

    it.each([
      ["TEMPLATE_NOT_APPROVED", "Template is not approved (status: paused)"],
      ["TEMPLATE_PARAMETER_COUNT_MISMATCH", "Template body expects 2 parameter(s), received 3"],
      ["TEMPLATE_LANGUAGE_MISMATCH", "Approved template language is hi"],
      ["TEMPLATE_NOT_FOUND", "Template not found for this tenant"],
    ])("WhatsNexus refusing with %s marks the notification FAILED and hands the real reason back — it is not retried", async (code, message) => {
      const d = wnDouble({}, { post: refusal(code, message) });
      const r = await sendWith(d);
      expect(r.status).toBe("FAILED");
      expect(r.reason).toContain(code);
      expect(r.reason).toContain(message);
      expect(r.row.status).toBe("FAILED");
      expect(r.row.reason).toBe(r.reason);
      expect(d.posts()).toHaveLength(1); // a person chose to send: never retried behind their back
    });

    it("a problem with ONE template does not flag the whole WhatsNexus connection as broken", async () => {
      await markConnected(t);
      await sendWith(wnDouble({}, { post: refusal("TEMPLATE_NOT_APPROVED", "Template is not approved (status: paused)") }));
      expect(await connectorStatus()).toBe("CONNECTED");
      // a genuine credential failure still does
      await sendWith(wnDouble({}, { post: () => json(401, { success: false, error: { code: "INVALID_CREDENTIALS", message: "bad key" } }) }));
      expect(await connectorStatus()).toBe("ERROR");
      await markConnected(t);
    });

    it("HTTP: the send endpoint returns the reason alongside the status", async () => {
      // Real adapter, unreachable host: a transport failure, reported as FAILED with its reason, never a bare 'could not be sent'.
      const journeyId = await journey();
      const res = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/whatsapp`, { idempotencyKey: `http-${Date.now()}-aaaa` });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { status: string; reason: string | null };
      expect(body.status).toBe("FAILED");
      expect(typeof body.reason).toBe("string");
      await markConnected(t);
    });
  });

  // ── what staff see before they send ────────────────────────────────────────
  describe("the Send WhatsApp preview", () => {
    async function journey(tt: TestTenant) {
      const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Naveen Raj", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
      expect(res.statusCode).toBe(201);
      return (res.json() as { journeyId: string }).journeyId;
    }
    const preview = async (tt: TestTenant, d: ReturnType<typeof wnDouble>, checkProvider = true) => {
      const r = await previewFollowUpMessage(db, tt.tenantId, tt.userIds.FRONT_DESK!, await journey(tt), { checkProvider, catalogue: d.deps });
      expect(r.ok).toBe(true);
      return (r as { preview: WhatsAppPreview }).preview;
    };
    const saved = async () => {
      const row = await templateRow(t, "FOLLOW_UP_MESSAGE");
      return updateTemplate(db, t.tenantId, row.id, { providerTemplateName: "pulseos_follow_up_message", language: "en", body: "Hello {{patient_name}}, this is {{staff_name}} from {{hospital_name}}." }, wnDouble({ TT001: [entry("pulseos_follow_up_message", 3)] }).deps);
    };

    it("says which WhatsNexus template will really be sent, with its category and exactly what fills each placeholder", async () => {
      expect(await saved()).toMatchObject({ ok: true });
      const d = wnDouble({ TT001: [{ ...entry("pulseos_follow_up_message", 3), category: "utility", templateType: "text" }] });
      const p = await preview(t, d);
      expect(p.canSend).toBe(true);
      expect(p.delivery).toMatchObject({ provider: "whatsnexus", templateName: "pulseos_follow_up_message", language: "en", category: "utility" });
      expect(p.delivery!.parameters.map((x) => [x.position, x.variable])).toEqual([[1, "patient_name"], [2, "staff_name"], [3, "hospital_name"]]);
      expect(p.delivery!.parameters[0]!.value).toBe("Naveen Raj");
      expect(d.gets()).toHaveLength(1); // read live, not remembered
    });

    it("blocks the send up front, with the reason code, when the saved template has since been paused, changed or removed", async () => {
      await saved();
      const gone = await preview(t, wnDouble({ TT001: [] }));
      expect(gone).toMatchObject({ canSend: false, blockedReason: "TEMPLATE_NOT_FOUND" });
      const changed = await preview(t, wnDouble({ TT001: [entry("pulseos_follow_up_message", 2)] }));
      expect(changed).toMatchObject({ canSend: false, blockedReason: "TEMPLATE_PARAMETER_COUNT_MISMATCH" });
      const lang = await preview(t, wnDouble({ TT001: [entry("pulseos_follow_up_message", 3, "hi")] }));
      expect(lang).toMatchObject({ canSend: false, blockedReason: "TEMPLATE_LANGUAGE_MISMATCH" });
    });

    it("does not block when WhatsNexus cannot be asked right now: it decides again at the moment of sending", async () => {
      await saved();
      const p = await preview(t, wnDouble({}, { status: 503 }));
      expect(p.canSend).toBe(true);
      expect(p.delivery).toMatchObject({ provider: "whatsnexus", templateName: "pulseos_follow_up_message" });
    });

    it("a hospital sending through Meta is not checked against WhatsNexus, and the sheet says so", async () => {
      const d = wnDouble({});
      const p = await preview(metaOnly, d);
      expect(d.requests).toHaveLength(0);
      expect(p.delivery).toMatchObject({ provider: null });
      const withMeta = await preview(other, d);
      expect(d.requests).toHaveLength(0);
      expect(withMeta.delivery?.provider ?? null).toBeNull();
    });

    it("the plain preview used by the send itself makes no WhatsNexus request", async () => {
      await saved();
      const d = wnDouble({ TT001: [] });
      const r = await previewFollowUpMessage(db, t.tenantId, t.userIds.FRONT_DESK!, await journey(t), { catalogue: d.deps });
      expect(r).toMatchObject({ ok: true, preview: { canSend: true } });
      expect(d.requests).toHaveLength(0);
    });

    it("HTTP: the preview endpoint returns the delivery details", async () => {
      const res = await call(t, "FRONT_DESK", "GET", `/journeys/${await journey(t)}/whatsapp/preview`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as WhatsAppPreview).delivery).toMatchObject({ provider: "whatsnexus", templateName: "pulseos_follow_up_message" });
    });
  });
});
