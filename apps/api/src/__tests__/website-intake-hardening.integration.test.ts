import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectorSecrets, connectors, journeys, patients, timelineEvents } from "../db/schema.js";
import { encryptSecret } from "../domain/security/encryption.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The public "I am interested" endpoint is the one door anyone on the internet can knock on. For a hospital that configures it
// it needs: a tenant-specific token (never in the page's JavaScript - the website's own server adds it), strict field caps and
// validation, a rate limit, and the same duplicate handling as every other lead. The tenant is always the connector's.
describe.skipIf(!DEMO_PASSWORD)("website intake hardening (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let connectorId: string;
  const TOKEN = "intake-token-for-the-pilot-hospital-only";
  const prevLimit = process.env.FORM_INTAKE_MAX_PER_MINUTE;

  const unique = () => `9${`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9)}`;
  const body = (over: Record<string, unknown> = {}) => ({ submissionId: `sub-${Date.now()}-${Math.random()}`, formId: "namokar-interested", name: "Interested Person", phone: `+91${unique()}`, service: "Cataract", message: "Please call after 5 pm", ...over });
  const post = (payload: object, headers: Record<string, string> = { "x-pulseos-intake-token": TOKEN }) =>
    app.inject({ method: "POST", url: `/forms/website/${connectorId}`, payload, headers: { "content-type": "application/json", ...headers } });
  const patientCount = async () => (await db.select().from(patients).where(eq(patients.tenantId, t.tenantId))).length;

  beforeAll(async () => {
    process.env.FORM_INTAKE_MAX_PER_MINUTE = "60";
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const [c] = await db
      .insert(connectors)
      .values({ tenantId: t.tenantId, type: "ACQUISITION", provider: "website_form", status: "CONNECTED", mode: "FIXTURE", displayName: "Website form", capabilities: ["RECEIVE_FORM"], configuration: { formIds: ["namokar-interested"], requireService: true, fixedSource: "website", allowedOrigins: ["https://namokar.example"] } })
      .returning();
    connectorId = c!.id;
    await db.insert(connectorSecrets).values({ connectorId, encryptedPayload: encryptSecret({ intakeToken: TOKEN }) });
  });
  afterAll(async () => {
    if (prevLimit === undefined) delete process.env.FORM_INTAKE_MAX_PER_MINUTE;
    else process.env.FORM_INTAKE_MAX_PER_MINUTE = prevLimit;
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("needs this hospital's token: none or a wrong one is 401 with the same answer, and nothing is created", async () => {
    const before = await patientCount();
    const none = await post(body(), {});
    const wrong = await post(body(), { "x-pulseos-intake-token": `${TOKEN}x` });
    const empty = await post(body(), { "x-pulseos-intake-token": "" });
    for (const r of [none, wrong, empty]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "unauthorized" });
    }
    expect(await patientCount()).toBe(before);
  });

  it("with the token it creates the Patient, a Website journey and a Timeline line carrying the message, and returns no internal ids", async () => {
    const payload = body({ utm: { source: "google", medium: "cpc" }, message: "Please call after 5 pm" });
    const res = await post(payload);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, duplicate: false, deduped: false });
    const [p] = await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, payload.phone)));
    expect(p).toBeTruthy();
    const [j] = await db.select().from(journeys).where(eq(journeys.patientId, p!.id));
    // The source is the hospital's own mapping (Website), whatever the page's UTM tags say.
    expect(j).toMatchObject({ source: "website", journeyType: "Cataract", stage: "enquiry" });
    const events = await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, j!.id), eq(timelineEvents.eventType, "website_form_submitted")));
    expect(events).toHaveLength(1);
    expect(events[0]!.description).toContain("Please call after 5 pm");
  });

  it("a returning phone number reaches the same Patient and the same open journey", async () => {
    const phone = `+91${unique()}`;
    await post(body({ phone }));
    const again = await post(body({ phone: phone.replace("+91", "0"), service: "Cataract" }));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, deduped: true });
    const rows = await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, phone)));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(journeys).where(eq(journeys.patientId, rows[0]!.id))).toHaveLength(1);
  });

  it("the same submission id is accepted once (a retried form is not a second lead)", async () => {
    const payload = body();
    expect((await post(payload)).json()).toMatchObject({ duplicate: false });
    expect((await post(payload)).json()).toMatchObject({ ok: true, duplicate: true });
  });

  it("validates and caps every field", async () => {
    const before = await patientCount();
    const bad: Record<string, unknown>[] = [
      { name: "x".repeat(121) },
      { name: "   " },
      { phone: "not a phone" },
      { phone: "+91123" },
      { phone: "9".repeat(40) },
      { service: "" },
      { service: "x".repeat(121) },
      { message: "x".repeat(1001) },
      { email: "not-an-email" },
      { pageUrl: `https://namokar.example/${"a".repeat(600)}` },
      { submissionId: "s".repeat(101) },
      { utm: { source: "g".repeat(300) } },
    ];
    for (const over of bad) {
      const r = await post(body(over));
      expect(r.statusCode, JSON.stringify(over).slice(0, 80)).toBe(422);
    }
    // A missing service is refused for this hospital (its intake requires one) ...
    const noService = body();
    delete (noService as Record<string, unknown>).service;
    expect((await post(noService)).statusCode).toBe(422);
    expect(await patientCount()).toBe(before);
  });

  it("ignores anything it does not know, including a tenant id in the body: the tenant is the connector's", async () => {
    const res = await post(body({ tenantId: "00000000-0000-4000-8000-000000000000", role: "SUPER_ADMIN", constructor: { x: 1 } }));
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.select({ id: patients.id }).from(patients).where(eq(patients.tenantId, t.tenantId))).length).toBeGreaterThan(0);
  });

  it("a browser from an origin the hospital did not allow is refused; the hospital's own site and server-to-server calls pass", async () => {
    expect((await post(body(), { "x-pulseos-intake-token": TOKEN, origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await post(body(), { "x-pulseos-intake-token": TOKEN, origin: "https://namokar.example" })).statusCode).toBe(200);
    expect((await post(body())).statusCode).toBe(200);
  });

  it("a disabled connector accepts nothing", async () => {
    await db.update(connectors).set({ status: "DISABLED" }).where(eq(connectors.id, connectorId));
    expect((await post(body())).statusCode).toBe(403);
    await db.update(connectors).set({ status: "CONNECTED" }).where(eq(connectors.id, connectorId));
  });

  // Last: it deliberately exhausts this address's budget.
  it("is rate limited per address and says when to retry", async () => {
    let limited: Awaited<ReturnType<typeof post>> | null = null;
    for (let i = 0; i < 100 && !limited; i++) {
      const r = await post(body());
      if (r.statusCode === 429) limited = r;
    }
    expect(limited, "never rate limited").not.toBeNull();
    expect(limited!.json()).toMatchObject({ error: "too_many_requests" });
    expect(Number(limited!.headers["retry-after"])).toBeGreaterThan(0);
  });
});
