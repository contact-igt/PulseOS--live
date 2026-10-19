import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { IntegrationCard, IntegrationDetail, IntegrationLogRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectorSecrets, connectors, patients, tasks } from "../db/schema.js";
import { decryptSecret } from "../domain/security/encryption.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Website Leads in the Integration Hub: discovery, typed configuration, the intake token, honest status, and that the
// existing intake pipeline still does what it did. Uses throwaway tenants only (no demo data, no outbound messages).
describe.skipIf(!DEMO_PASSWORD)("Website Leads in the Integration Hub (integration)", () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;
  const prevLimit = process.env.FORM_INTAKE_MAX_PER_MINUTE;

  const call = (t: TestTenant, role: Role, method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const hub = async (t: TestTenant, role: Role = "SUPER_ADMIN") => (await call(t, role, "GET", "/integrations/hub")).json() as IntegrationCard[];
  const card = async (t: TestTenant, role: Role = "SUPER_ADMIN") => (await hub(t, role)).find((c) => c.key === "website_leads")!;
  const detail = async (t: TestTenant, role: Role = "SUPER_ADMIN") => (await call(t, role, "GET", "/integrations/hub/website_leads")).json() as IntegrationDetail;
  const form = (over: Record<string, unknown> = {}) => ({ displayName: "Website Contact Form", formId: "website-contact-v1", enabled: true, requireService: true, fixedSource: false, allowedOrigins: ["https://clinic.example"], ...over });
  const saveForm = (t: TestTenant, role: Role, payload: object) => call(t, role, "PUT", "/integrations/hub/website_leads/form", payload);
  const newToken = async (t: TestTenant) => ((await call(t, "SUPER_ADMIN", "POST", "/integrations/hub/website_leads/token")).json() as { token: string }).token;
  const unique = () => `9${`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9)}`;
  const lead = (over: Record<string, unknown> = {}) => ({ submissionId: `sub-${Date.now()}-${Math.random()}`, formId: "website-contact-v1", name: "Asha Sharma", phone: `+91${unique()}`, service: "Cataract", message: "Please call after 5 pm", ...over });
  const submit = (url: string, payload: object, token?: string) =>
    app.inject({ method: "POST", url, payload, headers: { "content-type": "application/json", ...(token ? { "x-pulseos-intake-token": token } : {}) } });
  const pathOf = (webhookUrl: string | null) => new URL(webhookUrl!).pathname;

  beforeAll(async () => {
    process.env.FORM_INTAKE_MAX_PER_MINUTE = "100";
    app = await buildApp();
    await app.ready();
    a = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    b = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    if (prevLimit === undefined) delete process.env.FORM_INTAKE_MAX_PER_MINUTE;
    else process.env.FORM_INTAKE_MAX_PER_MINUTE = prevLimit;
    for (const t of [a, b]) await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("is a card in Ads & Attribution beside the existing integrations, not configured and not healthy until something real happens", async () => {
    const cards = await hub(a);
    expect(cards.map((c) => c.key)).toEqual(["google_ads", "meta_ads", "website_leads", "runo", "ccs_ivr", "whatsapp_meta_cloud", "whatsnexus", "sms", "webhooks"]);
    const w = cards.find((c) => c.key === "website_leads")!;
    expect(w).toMatchObject({ category: "ADS", name: "Website Leads", configuration: "NOT_CONFIGURED", mode: "NOT_CONFIGURED", health: "UNKNOWN", isConnected: false, lastEventAt: null, enabled: true });
    expect((await detail(a)).webhookUrl).toBeNull(); // no connector yet: no address to hand out
  });

  it("settings are typed, saved by an Admin, and exposed without any secret", async () => {
    const res = await saveForm(a, "HOSPITAL_ADMIN", form());
    expect(res.statusCode).toBe(200);
    const d = res.json() as IntegrationDetail;
    expect(d.websiteForm).toMatchObject({ connectorExists: true, formId: "website-contact-v1", requireService: true, allowedOrigins: ["https://clinic.example"], enabled: true, hasToken: false, requireToken: true });
    expect(d.webhookUrl).toMatch(/\/forms\/website\/[0-9a-f-]{36}$/);
    const stored = (await db.select().from(connectors).where(eq(connectors.tenantId, a.tenantId))).find((r) => r.provider === "website_form")!;
    expect(stored.configuration).toMatchObject({ requireService: true, allowedOrigins: ["https://clinic.example"], requireToken: true });
    expect(typeof (stored.configuration as Record<string, unknown>).requireService).toBe("boolean");
    expect(Array.isArray((stored.configuration as Record<string, unknown>).allowedOrigins)).toBe(true);
    expect((await card(a))).toMatchObject({ configuration: "PARTIAL", health: "UNKNOWN", isConnected: false }); // saved is not verified
  });

  it("refuses bad settings and anything it does not know (including a tenant id), and nothing changes", async () => {
    const before = JSON.stringify((await detail(a)).websiteForm);
    for (const bad of [
      form({ allowedOrigins: ["https://clinic.example/contact"] }),
      form({ allowedOrigins: ["*"] }),
      form({ allowedOrigins: ["http://clinic.example"] }),
      form({ formId: "Has Spaces" }),
      form({ requireService: "true" }),
      form({ tenantId: b.tenantId }),
    ]) expect((await saveForm(a, "SUPER_ADMIN", bad)).statusCode).toBe(400);
    expect(JSON.stringify((await detail(a)).websiteForm)).toBe(before);
  });

  it("roles: front desk cannot configure; an Admin cannot create or rotate the token; a Super Admin can", async () => {
    expect((await saveForm(a, "FRONT_DESK", form())).statusCode).toBe(403);
    expect((await call(a, "HOSPITAL_ADMIN", "POST", "/integrations/hub/website_leads/token")).statusCode).toBe(403);
    expect((await call(a, "FRONT_DESK", "POST", "/integrations/hub/website_leads/token")).statusCode).toBe(403);
    expect((await call(a, "SUPER_ADMIN", "POST", "/integrations/hub/website_leads/token")).statusCode).toBe(200);
  });

  it("the generic string form can never create or change Website Leads", async () => {
    const res = await call(b, "SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/configuration", { configuration: { requireService: "true" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "use_website_form_endpoint" });
    expect((await detail(b)).websiteForm?.connectorExists).toBe(false);
  });

  it("the token is shown once, stored encrypted, and never comes back", async () => {
    const d0 = await detail(a);
    const res = await call(a, "SUPER_ADMIN", "POST", "/integrations/hub/website_leads/token");
    expect(res.headers["cache-control"]).toContain("no-store");
    const { token } = res.json() as { token: string };
    expect(token).toMatch(/^wlk_[A-Za-z0-9_-]{43}$/);
    const [stored] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, pathOf(d0.webhookUrl).split("/").pop()!));
    expect(stored!.encryptedPayload).not.toContain(token);
    expect(decryptSecret(stored!.encryptedPayload).intakeToken).toBe(token);
    for (const body of [JSON.stringify(await detail(a)), JSON.stringify(await detail(a, "HOSPITAL_ADMIN")), JSON.stringify(await hub(a)), (await call(a, "SUPER_ADMIN", "GET", "/integrations/logs")).body, (await saveForm(a, "SUPER_ADMIN", form())).body]) {
      expect(body).not.toContain(token);
    }
    expect((await detail(a)).websiteForm).toMatchObject({ hasToken: true });
    expect(await card(a)).toMatchObject({ configuration: "CONFIGURED" });
  });

  it("intake: closed with no token, open to the current token, and rotation retires the old one at once", async () => {
    const t = await newToken(a);
    const url = pathOf((await detail(a)).webhookUrl);
    expect((await submit(url, lead())).statusCode).toBe(401);
    expect((await submit(url, lead(), `${t}x`)).statusCode).toBe(401);
    expect((await submit(url, lead(), t)).statusCode).toBe(200);
    const next = await newToken(a);
    expect(next).not.toBe(t);
    expect((await submit(url, lead(), t)).statusCode).toBe(401);
    expect((await submit(url, lead(), next)).statusCode).toBe(200);
  });

  it("status: saved and rotated is not verified; only a real submission makes it connected; the check never promotes it", async () => {
    const t = await newToken(a);
    const url = pathOf((await detail(a)).webhookUrl);
    expect(await card(a)).toMatchObject({ health: "UNKNOWN", isConnected: false, mode: "LIVE_CAPABLE" });
    const check = (await call(a, "SUPER_ADMIN", "POST", "/integrations/hub/website_leads/status")).json() as { ok: boolean; status: string; health: string };
    expect(check).toMatchObject({ ok: false, status: "CONNECTING", health: "UNKNOWN" });
    expect(await card(a)).toMatchObject({ isConnected: false });
    expect((await submit(url, lead(), t)).statusCode).toBe(200);
    const live = await card(a);
    expect(live).toMatchObject({ health: "HEALTHY", isConnected: true, mode: "LIVE_CONFIGURED" });
    expect(live.lastEventAt).not.toBeNull();
  });

  it("switching it off refuses every submission and deletes nothing; switching on starts verification over", async () => {
    const t = await newToken(a);
    const url = pathOf((await detail(a)).webhookUrl);
    expect((await submit(url, lead({ name: "Before Off" }), t)).statusCode).toBe(200);
    const patientsBefore = (await db.select().from(patients).where(eq(patients.tenantId, a.tenantId))).length;
    expect((await saveForm(a, "HOSPITAL_ADMIN", form({ enabled: false }))).statusCode).toBe(200);
    expect(await card(a)).toMatchObject({ enabled: false, mode: "DISABLED", configuration: "CONFIGURED" });
    expect((await submit(url, lead(), t)).statusCode).toBe(403);
    expect((await db.select().from(patients).where(eq(patients.tenantId, a.tenantId))).length).toBe(patientsBefore);
    expect((await saveForm(a, "HOSPITAL_ADMIN", form({ enabled: true }))).statusCode).toBe(200);
    expect(await card(a)).toMatchObject({ enabled: true, isConnected: false, health: "UNKNOWN" });
    expect((await submit(url, lead(), t)).statusCode).toBe(200);
  });

  it("the existing pipeline is unchanged: a patient, a journey, one follow-up task, and a repeated submissionId is a no-op", async () => {
    const t = await newToken(a);
    const url = pathOf((await detail(a)).webhookUrl);
    const payload = lead({ name: "Pipeline Check" });
    const first = await submit(url, payload, t);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, duplicate: false, deduped: false }); // closed intake: no internal ids
    const tasksBefore = (await db.select().from(tasks).where(eq(tasks.tenantId, a.tenantId))).length;
    const again = await submit(url, payload, t);
    expect(again.json()).toMatchObject({ ok: true, duplicate: true });
    expect((await db.select().from(tasks).where(eq(tasks.tenantId, a.tenantId))).length).toBe(tasksBefore);
    expect(await submit(url, lead({ phone: "12" }), t).then((r) => r.statusCode)).toBe(422);
    expect(await submit(url, lead({ name: "x".repeat(500) }), t).then((r) => r.statusCode)).toBe(422);
    expect(await submit(url, { ...lead(), service: undefined }, t).then((r) => r.statusCode)).toBe(422); // requireService
  });

  it("an Origin that is not allowed is refused even with the right token", async () => {
    const t = await newToken(a);
    const url = pathOf((await detail(a)).webhookUrl);
    const res = await app.inject({ method: "POST", url, payload: lead(), headers: { "content-type": "application/json", "x-pulseos-intake-token": t, origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
  });

  it("Activity shows submission outcomes and nothing a visitor typed", async () => {
    const t = await newToken(a);
    const url = pathOf((await detail(a)).webhookUrl);
    const phone = `+91${unique()}`;
    expect((await submit(url, lead({ phone, name: "Private Visitor" }), t)).statusCode).toBe(200);
    const res = await call(a, "SUPER_ADMIN", "GET", "/integrations/logs?provider=website_leads");
    const rows = res.json() as IntegrationLogRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ provider: "website_form", direction: "inbound", status: "processed" });
    expect(res.body).not.toContain(phone);
    expect(res.body).not.toContain("Private Visitor");
    expect(res.body).not.toContain(t);
  });

  it("another hospital sees none of this and cannot change it", async () => {
    const mine = await detail(a);
    const theirs = await detail(b);
    expect(theirs.websiteForm?.connectorExists).toBe(false);
    expect(theirs.webhookUrl).toBeNull();
    expect((await saveForm(b, "SUPER_ADMIN", form({ displayName: "Other Hospital", formId: "other-hospital-1" }))).statusCode).toBe(200);
    expect((await detail(a)).websiteForm?.displayName).toBe(mine.websiteForm?.displayName);
    expect(pathOf((await detail(b)).webhookUrl)).not.toBe(pathOf(mine.webhookUrl));
    // B's token does not open A's intake.
    const bToken = await newToken(b);
    expect((await submit(pathOf(mine.webhookUrl), lead(), bToken)).statusCode).toBe(401);
  });

  it("a connector that predates the Hub (no token, no requireToken) keeps accepting submissions and is reported as only partly configured", async () => {
    const legacy = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    try {
      const [c] = await db.insert(connectors).values({ tenantId: legacy.tenantId, type: "ACQUISITION", provider: "website_form", status: "CONNECTED", mode: "FIXTURE", displayName: "Website form", capabilities: ["RECEIVE_FORM"], configuration: { formIds: ["old"] } }).returning();
      expect((await submit(`/forms/website/${c!.id}`, lead())).statusCode).toBe(200);
      expect(await card(legacy)).toMatchObject({ configuration: "PARTIAL" });
    } finally {
      await destroyTestTenant(db, legacy);
    }
  });
});
