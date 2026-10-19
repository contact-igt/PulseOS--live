import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { IntegrationCard, IntegrationDetail, IntegrationLogRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectorEvents, connectors, journeys, patients, tasks, timelineEvents } from "../db/schema.js";
import { touchConnectorError, touchConnectorSuccess } from "../domain/connector/connector.service.js";
import { findOpenWebsiteIntakes } from "../domain/integration/website-intake-audit.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// One controlled ingestion failure (the touchpoint write is the LAST step of the shared lead pipeline), switched on per test.
const failure = vi.hoisted(() => ({ armed: false }));
vi.mock("../domain/acquisition/attribution.service.js", async (original) => {
  const real = await original<typeof import("../domain/acquisition/attribution.service.js")>();
  return {
    ...real,
    recordTouchpoint: (...args: Parameters<typeof real.recordTouchpoint>) => {
      if (failure.armed) {
        failure.armed = false;
        throw new Error("boom: Asha Sharma +919800000001 asha@example.com");
      }
      return real.recordTouchpoint(...args);
    },
  };
});

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Verification of Website Leads behaviour that only shows at runtime: atomic ingestion, honest status transitions, token races,
// request-source spoofing, sanitized rejected-request visibility, and the public address shown to developers.
describe.skipIf(!DEMO_PASSWORD)("Website Leads hardening (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let url: string;
  let token: string;
  const prevLimit = process.env.FORM_INTAKE_MAX_PER_MINUTE;

  const call = (role: Role, method: "GET" | "PUT" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const card = async () => ((await call("SUPER_ADMIN", "GET", "/integrations/hub")).json() as IntegrationCard[]).find((c) => c.key === "website_leads")!;
  const detail = async () => (await call("SUPER_ADMIN", "GET", "/integrations/hub/website_leads")).json() as IntegrationDetail;
  const newToken = async () => ((await call("SUPER_ADMIN", "POST", "/integrations/hub/website_leads/token")).json() as { token: string }).token;
  const unique = () => `9${`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9)}`;
  const lead = (over: Record<string, unknown> = {}) => ({ submissionId: `sub-${Date.now()}-${Math.random()}`, formId: "website-contact-v1", name: "Asha Sharma", phone: `+91${unique()}`, service: "Cataract", message: "Please call", ...over });
  const post = (payload: object, headers: Record<string, string> = {}, path = url) =>
    app.inject({ method: "POST", url: path, payload, headers: { "content-type": "application/json", ...headers } });
  const withToken = (tok = token) => ({ "x-pulseos-intake-token": tok });
  const connectorRow = async () => (await db.select().from(connectors).where(eq(connectors.tenantId, t.tenantId))).find((c) => c.provider === "website_form")!;

  beforeAll(async () => {
    process.env.FORM_INTAKE_MAX_PER_MINUTE = "1000";
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", { displayName: "Website Contact Form", formId: "website-contact-v1", enabled: true, requireService: false, fixedSource: false, allowedOrigins: [] });
    token = await newToken();
    url = new URL((await detail()).webhookUrl!).pathname;
  });
  afterAll(async () => {
    if (prevLimit === undefined) delete process.env.FORM_INTAKE_MAX_PER_MINUTE;
    else process.env.FORM_INTAKE_MAX_PER_MINUTE = prevLimit;
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("a failed ingestion leaves nothing behind, says nothing about the visitor, and the retry creates exactly one patient, journey and follow-up task", async () => {
    const phone = `+91${unique()}`;
    const payload = lead({ name: "Asha Sharma", phone, email: "asha@example.com" });
    failure.armed = true;
    const failed = await post(payload, withToken());
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "processing_failed" });
    for (const secret of ["Asha", "asha@example.com", "98000"]) expect(failed.body).not.toContain(secret);

    // All-or-nothing: no half-created patient, journey, task or timeline entry.
    const normalized = phone.replace(/\D/g, "");
    const mine = (await db.select().from(patients).where(eq(patients.tenantId, t.tenantId))).filter((p) => p.phoneE164?.replace(/\D/g, "") === normalized);
    expect(mine).toHaveLength(0);

    // The failure is visible as a category, never as the error text.
    const [event] = await db.select().from(connectorEvents).where(and(eq(connectorEvents.tenantId, t.tenantId), eq(connectorEvents.externalEventId, payload.submissionId as string)));
    expect(event).toMatchObject({ status: "failed", error: "processing_failed" });
    const row = await connectorRow();
    expect(row.lastError).toBe("processing_failed");
    expect(row.status).toBe("ERROR");
    expect(await card()).toMatchObject({ health: "UNHEALTHY", isConnected: false, lastError: "The last submission could not be processed." });
    const logs = await call("SUPER_ADMIN", "GET", "/integrations/logs?provider=website_leads");
    for (const secret of ["Asha", "asha@example.com", "boom", "98000"]) expect(logs.body).not.toContain(secret);

    // A safe retry with the same submissionId succeeds and produces the complete, single set of records.
    const retried = await post(payload, withToken());
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true, duplicate: false, deduped: false });
    const after = (await db.select().from(patients).where(eq(patients.tenantId, t.tenantId))).filter((p) => p.phoneE164?.replace(/\D/g, "") === normalized);
    expect(after).toHaveLength(1);
    const js = await db.select().from(journeys).where(eq(journeys.patientId, after[0]!.id));
    expect(js).toHaveLength(1);
    const ts = (await db.select().from(tasks).where(eq(tasks.patientId, after[0]!.id))).filter((x) => x.reason === "new_lead");
    expect(ts).toHaveLength(1);
    const kinds = (await db.select().from(timelineEvents).where(eq(timelineEvents.patientId, after[0]!.id))).map((e) => e.eventType).sort();
    expect(kinds).toEqual(["journey_created", "website_form_submitted"]);
    expect(await card()).toMatchObject({ health: "HEALTHY", isConnected: true });
  });

  it("status follows the latest real outcome: success, failure, success; an error never re-enables a disabled form", async () => {
    const id = (await connectorRow()).id;
    await touchConnectorSuccess(db, id);
    expect(await card()).toMatchObject({ health: "HEALTHY", isConnected: true });
    await touchConnectorError(db, id, "processing_failed");
    expect(await card()).toMatchObject({ health: "UNHEALTHY", isConnected: false });
    await touchConnectorSuccess(db, id);
    expect(await card()).toMatchObject({ health: "HEALTHY", isConnected: true });

    // Disabled while a request was in flight: its late failure must not flip the form back on.
    const form = { displayName: "Website Contact Form", formId: "website-contact-v1", enabled: false, requireService: false, fixedSource: false, allowedOrigins: [] };
    expect((await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", form)).statusCode).toBe(200);
    await touchConnectorError(db, id, "processing_failed");
    expect((await connectorRow()).status).toBe("DISABLED");
    expect(await card()).toMatchObject({ enabled: false, mode: "DISABLED" });
    expect((await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", { ...form, enabled: true })).statusCode).toBe(200);
    expect(await card()).toMatchObject({ enabled: true, isConnected: false, health: "UNKNOWN" }); // re-enabled: verification starts over
  });

  it("concurrent token replacements leave one consistent, working token", async () => {
    const tokens = await Promise.all(Array.from({ length: 6 }, () => newToken()));
    expect(new Set(tokens).size).toBe(6);
    const results = await Promise.all(tokens.map((tok) => post(lead(), withToken(tok)).then((r) => r.statusCode)));
    expect(results.filter((s) => s === 200)).toHaveLength(1); // exactly the stored one
    expect(results.filter((s) => s === 401)).toHaveLength(5);
    expect((await detail()).websiteForm).toMatchObject({ hasToken: true });
    token = tokens[results.indexOf(200)]!;
  });

  it("a token in the query string is never accepted", async () => {
    const res = await post(lead(), {}, `${url}?x-pulseos-intake-token=${token}&token=${token}&intakeToken=${token}`);
    expect(res.statusCode).toBe(401);
  });

  it("a forged X-Forwarded-For does not get around the rate limit", async () => {
    // A fresh app: this limit is read when the app is built.
    process.env.FORM_INTAKE_MAX_PER_MINUTE = "3";
    const limited = await buildApp();
    await limited.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await limited.inject({ method: "POST", url, payload: lead(), headers: { "content-type": "application/json", "x-pulseos-intake-token": token, "x-forwarded-for": `203.0.113.${i + 1}`, forwarded: `for=198.51.100.${i + 1}`, "x-real-ip": `192.0.2.${i + 1}` } });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
      process.env.FORM_INTAKE_MAX_PER_MINUTE = "1000";
    }
  });

  it("unknown, malformed and another hospital's connector ids all get the same safe answer", async () => {
    const answers = await Promise.all(["/forms/website/00000000-0000-4000-8000-000000000000", "/forms/website/not-a-uuid", `/forms/website/${t.connectorId}`].map((p) => post(lead(), withToken(), p)));
    for (const r of answers) {
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: "not_found" });
    }
  });

  describe("rejected requests are visible to admins, sanitized and bounded", () => {
    const logs = async () => (await call("SUPER_ADMIN", "GET", "/integrations/logs?provider=website_leads")).json() as IntegrationLogRow[];
    const rejections = async () => (await db.select().from(connectorEvents).where(and(eq(connectorEvents.connectorId, (await connectorRow()).id), like(connectorEvents.externalEventId, "reject:%"))));

    it("records auth, origin, validation and disabled rejections as one sanitized event per kind per minute, without touching health", async () => {
      const id = (await connectorRow()).id;
      await touchConnectorSuccess(db, id);
      const before = (await rejections()).length;
      const secretName = "Rejected Visitor";
      const secretPhone = "+919811112222";
      const bad = lead({ name: secretName, phone: secretPhone });

      for (let i = 0; i < 4; i++) expect((await post(bad, withToken(`${token}x`))).statusCode).toBe(401); // wrong token
      expect((await post({ ...bad, phone: "12" }, withToken())).statusCode).toBe(422);
      for (let i = 0; i < 3; i++) expect((await post({ name: secretName }, withToken())).statusCode).toBe(422);

      const rows = await rejections();
      const categories = new Set(rows.map((r) => (r.payload as { category: string }).category));
      expect([...categories].sort()).toEqual(["auth", "validation"]);
      // 8 refused requests, however many: at most one new row per kind (two kinds), never one per request.
      expect(rows.length - before).toBeLessThanOrEqual(2);
      expect(rows.length).toBeLessThanOrEqual(4); // (the earlier query-string case may sit in the previous minute)
      for (const r of rows) {
        expect(r).toMatchObject({ status: "failed", direction: "inbound" });
        expect(JSON.stringify(r)).not.toContain(secretName);
        expect(JSON.stringify(r)).not.toContain(secretPhone);
        expect(JSON.stringify(r)).not.toContain(token);
      }
      const shown = await logs();
      expect(shown.some((l) => l.status === "failed" && /rejected/i.test(l.summary))).toBe(true);
      const body = JSON.stringify(shown);
      for (const secret of [secretName, secretPhone, token]) expect(body).not.toContain(secret);
      // Rejections are not processing errors: health is untouched.
      expect(await card()).toMatchObject({ health: "HEALTHY", isConnected: true });
    });

    it("origin and disabled rejections are recorded too", async () => {
      const base = { displayName: "Website Contact Form", formId: "website-contact-v1", requireService: false, fixedSource: false };
      await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", { ...base, enabled: true, allowedOrigins: ["https://clinic.example"] });
      expect((await post(lead(), { ...withToken(), origin: "https://evil.example" })).statusCode).toBe(403);
      await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", { ...base, enabled: false, allowedOrigins: ["https://clinic.example"] });
      expect((await post(lead(), withToken())).statusCode).toBe(403);
      const cats = (await rejections()).map((r) => (r.payload as { category: string }).category);
      expect(cats).toEqual(expect.arrayContaining(["origin", "disabled"]));
      await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", { ...base, enabled: true, allowedOrigins: [] });
    });

    it("an unknown connector id writes nothing (no tenant to attribute it to, and no way to flood the table)", async () => {
      const before = (await db.select().from(connectorEvents)).length;
      for (let i = 0; i < 5; i++) await post(lead(), withToken(), "/forms/website/00000000-0000-4000-8000-000000000000");
      expect((await db.select().from(connectorEvents)).length).toBe(before);
    });
  });

  describe("isolation and the other ways in", () => {
    const asOther = (role: Role, method: "GET" | "PATCH", path: string, payload?: object) => app.inject({ method, url: path, cookies: { pulseos_session: other.cookie[role]! }, ...(payload ? { payload } : {}) });

    it("the generic connector PATCH cannot write the typed website settings around their validation", async () => {
      const id = (await connectorRow()).id;
      const form = { displayName: "Website Contact Form", formId: "website-contact-v1", enabled: true, requireService: true, fixedSource: false, allowedOrigins: ["https://clinic.example"] };
      expect((await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", form)).statusCode).toBe(200);
      for (const configuration of [{ requireService: "true" }, { allowedOrigins: "https://evil.example" }, { requireToken: false }, { fixedSource: "other" }]) {
        const res = await app.inject({ method: "PATCH", url: `/connectors/${id}`, cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! }, payload: { configuration } });
        expect(res.statusCode, JSON.stringify(configuration)).toBe(409);
        expect(res.json()).toEqual({ error: "use_website_form_endpoint" });
      }
      expect((await connectorRow()).configuration).toMatchObject({ requireService: true, allowedOrigins: ["https://clinic.example"], requireToken: true });
      await call("SUPER_ADMIN", "PUT", "/integrations/hub/website_leads/form", { ...form, requireService: false, allowedOrigins: [] });
    });

    it("another hospital cannot read, change or rotate it, and sees none of its activity", async () => {
      const id = (await connectorRow()).id;
      const mine = await detail();
      expect((await asOther("SUPER_ADMIN", "GET", `/connectors/${id}`)).statusCode).toBe(404);
      expect((await asOther("SUPER_ADMIN", "PATCH", `/connectors/${id}`, { displayName: "Taken over" })).statusCode).toBe(404);
      expect((await connectorRow()).displayName).not.toBe("Taken over");
      const theirs = (await asOther("SUPER_ADMIN", "GET", "/integrations/hub/website_leads")).json() as IntegrationDetail;
      expect(theirs.websiteForm?.connectorExists).toBe(false);
      expect(theirs.webhookUrl).toBeNull();
      const theirLogs = (await asOther("SUPER_ADMIN", "GET", "/integrations/logs")).body;
      expect(theirLogs).not.toContain(id);
      // Rotating in the other hospital creates THEIR connector and token; mine is untouched and still works.
      const rotated = await app.inject({ method: "POST", url: "/integrations/hub/website_leads/token", cookies: { pulseos_session: other.cookie.SUPER_ADMIN! } });
      expect(rotated.statusCode).toBe(200);
      expect((await post(lead(), withToken())).statusCode).toBe(200);
      expect((await detail()).webhookUrl).toBe(mine.webhookUrl);
    });

    it("the activity log records that a token changed, never the token", async () => {
      const fresh = await newToken();
      token = fresh;
      const res = await call("SUPER_ADMIN", "GET", "/activity-log?limit=200");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("integration.secret_changed");
      expect(res.body).not.toContain(fresh);
      expect(res.body).not.toContain("wlk_");
    });
  });

  describe("rollback safety: a release that ignores requireToken must find nothing open", () => {
    it("a form saved before any token exists is held DISABLED, reads as enabled and waiting, and is refused; a token opens it; the admin's own off switch survives token changes", async () => {
      const x = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
      const as = (method: "GET" | "PUT" | "POST", path: string, payload?: object) => app.inject({ method, url: path, cookies: { pulseos_session: x.cookie.SUPER_ADMIN! }, ...(payload ? { payload } : {}) });
      const form = (enabled: boolean) => ({ displayName: "Website Contact Form", formId: "website-contact-v1", enabled, requireService: false, fixedSource: false, allowedOrigins: [] });
      const row = async () => (await db.select().from(connectors).where(eq(connectors.tenantId, x.tenantId))).find((c) => c.provider === "website_form")!;
      try {
        expect((await as("PUT", "/integrations/hub/website_leads/form", form(true))).statusCode).toBe(200);
        // Stored closed, because the previous release would have treated any status but DISABLED as open and ignored requireToken.
        expect((await row()).status).toBe("DISABLED");
        expect((await row()).configuration).toMatchObject({ formEnabled: true, requireToken: true });
        const d = (await as("GET", "/integrations/hub/website_leads")).json() as IntegrationDetail;
        expect(d.websiteForm).toMatchObject({ enabled: true, hasToken: false });
        expect(d).toMatchObject({ enabled: true, configuration: "PARTIAL", health: "UNKNOWN", mode: "NOT_CONFIGURED", isConnected: false });
        const path = new URL(d.webhookUrl!).pathname;
        const refused = await post(lead(), withToken("anything"), path);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({ error: "connector_disabled" });
        expect((await post(lead(), {}, path)).statusCode).toBe(403);
        const check = (await as("POST", "/integrations/hub/website_leads/status")).json() as { ok: boolean; status: string; message: string };
        expect(check).toMatchObject({ ok: false, status: "NOT_CONFIGURED" });
        expect(check.message).toMatch(/No intake token yet/);
        expect((await findOpenWebsiteIntakes(db)).some((o) => o.connectorId === (path.split("/").pop()))).toBe(false);

        // A token opens it (verification starts over).
        const tok = ((await as("POST", "/integrations/hub/website_leads/token")).json() as { token: string }).token;
        expect((await row()).status).toBe("CONNECTING");
        expect((await post(lead(), withToken(tok), path)).statusCode).toBe(200);

        // Switched off by the admin: closed, and a new token does not reopen it.
        expect((await as("PUT", "/integrations/hub/website_leads/form", form(false))).statusCode).toBe(200);
        expect((await row()).status).toBe("DISABLED");
        const tok2 = ((await as("POST", "/integrations/hub/website_leads/token")).json() as { token: string }).token;
        expect((await row()).status).toBe("DISABLED");
        expect((await post(lead(), withToken(tok2), path)).statusCode).toBe(403);
        expect(((await as("GET", "/integrations/hub/website_leads")).json() as IntegrationDetail).websiteForm?.enabled).toBe(false);
        // Switched back on with a token: verifying again, accepting.
        expect((await as("PUT", "/integrations/hub/website_leads/form", form(true))).statusCode).toBe(200);
        expect((await row()).status).toBe("CONNECTING");
        expect((await post(lead(), withToken(tok2), path)).statusCode).toBe(200);
      } finally {
        await destroyTestTenant(db, x);
      }
    });

    it("a token created first (no form saved yet) opens a form that is on by default", async () => {
      const x = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
      try {
        const res = await app.inject({ method: "POST", url: "/integrations/hub/website_leads/token", cookies: { pulseos_session: x.cookie.SUPER_ADMIN! } });
        const tok = (res.json() as { token: string }).token;
        const row = (await db.select().from(connectors).where(eq(connectors.tenantId, x.tenantId))).find((c) => c.provider === "website_form")!;
        expect(row.status).toBe("CONNECTING");
        expect((await post(lead(), withToken(tok), `/forms/website/${row.id}`)).statusCode).toBe(200);
      } finally {
        await destroyTestTenant(db, x);
      }
    });
  });

  describe("the address developers are given", () => {
    const keep = { base: process.env.PUBLIC_API_BASE_URL, env: process.env.NODE_ENV };
    const restore = () => {
      if (keep.base === undefined) delete process.env.PUBLIC_API_BASE_URL;
      else process.env.PUBLIC_API_BASE_URL = keep.base;
      process.env.NODE_ENV = keep.env;
    };
    it("is the configured public origin (trailing slashes ignored)", async () => {
      process.env.PUBLIC_API_BASE_URL = "https://api.pulseos.example///";
      try {
        const d = await detail();
        expect(d.webhookUrl).toMatch(/^https:\/\/api\.pulseos\.example\/forms\/website\/[0-9a-f-]{36}$/);
        expect(d.websiteForm).toMatchObject({ publicBaseConfigured: true });
      } finally {
        restore();
      }
    });
    it("in production without a configured public origin there is no misleading address, only a clear flag", async () => {
      delete process.env.PUBLIC_API_BASE_URL;
      process.env.NODE_ENV = "production";
      try {
        const d = await detail();
        expect(d.webhookUrl).toBeNull();
        expect(d.websiteForm).toMatchObject({ publicBaseConfigured: false, intakePath: expect.stringMatching(/^\/forms\/website\/[0-9a-f-]{36}$/) });
      } finally {
        restore();
      }
    });
    it("a value that is not an http(s) address counts as not configured", async () => {
      process.env.PUBLIC_API_BASE_URL = "api.pulseos.example";
      process.env.NODE_ENV = "production";
      try {
        expect((await detail()).webhookUrl).toBeNull();
      } finally {
        restore();
      }
    });
  });
});
