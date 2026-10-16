import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { activityLog, connectorSecrets, connectors } from "../db/schema.js";
import { createWhatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { decryptSecret } from "../domain/security/encryption.js";
import { pairWhatsNexus } from "../domain/integration/hub.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const CODE = "wnpair_VFQwMDE.abcdefghijklmnopqrstuvwxyz0123456789";
const API_KEY = "wnpk_ab12cd34_" + "k".repeat(43);
const CB_SECRET = "whcs_" + "s".repeat(43);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe.skipIf(!DEMO_PASSWORD)("Connect WhatsNexus with a pairing code (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const pairRoute = (tt: TestTenant, role: Role, body: object) => call(tt, role, "POST", "/integrations/hub/whatsnexus/pair", body);
  /** An adapter whose WhatsNexus replies as told; records what PulseOS sent it. */
  const wn = (reply: () => Response) => {
    const fetchImpl = vi.fn(async () => reply());
    return { adapter: createWhatsNexusAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, isPublicHost: async () => true }), fetchImpl };
  };
  const paired = () => json(200, { success: true, data: { whatsnexusTenantId: "TT001", apiKey: API_KEY, keyId: "ab12cd34", callbackSecret: CB_SECRET } });
  const connector = async (tt: TestTenant) => (await db.select().from(connectors).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus"))))[0];
  const storedSecrets = async (tt: TestTenant) => {
    const c = await connector(tt);
    const [s] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, c!.id));
    return decryptSecret(s!.encryptedPayload) as Record<string, string>;
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    for (const tt of [t, other]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  it("a successful pairing is saved exactly like typed credentials: Live mode, tenant id from WhatsNexus, awaiting verification", async () => {
    const { adapter, fetchImpl } = wn(paired);
    const res = await pairWhatsNexus(db, t.tenantId, { baseUrl: "https://wn.example.com/", code: CODE }, adapter);
    expect(res).toEqual({ ok: true });
    // PulseOS told WhatsNexus who it is and where to call back; it did not send a key.
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://wn.example.com/api/integrations/pulseos/pair");
    const sent = JSON.parse(init.body as string) as Record<string, string>;
    expect(sent).toMatchObject({ code: CODE, pulseosTenantId: t.tenantId });
    expect(sent.callbackUrl).toMatch(new RegExp(`/webhooks/whatsnexus/${t.tenantId}$`));
    const c = (await connector(t))!;
    expect(c.mode).toBe("LIVE");
    expect(c.status).toBe("CONNECTING"); // configured is not connected
    expect(c.configuration).toMatchObject({ baseUrl: "https://wn.example.com", tenantId: "TT001" });
    expect(await storedSecrets(t)).toMatchObject({ apiKey: API_KEY, callbackSecret: CB_SECRET });
  });

  it("re-pairing replaces the credentials and drops the old callback secret", async () => {
    await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { previousCallbackSecret: "whcs_old_" + "o".repeat(30) } });
    expect((await storedSecrets(t)).previousCallbackSecret).toBeTruthy();
    const { adapter } = wn(() => json(200, { success: true, data: { whatsnexusTenantId: "TT001", apiKey: "wnpk_ab12cd34_" + "z".repeat(43), keyId: "ab12cd34", callbackSecret: "whcs_" + "q".repeat(43) } }));
    expect((await pairWhatsNexus(db, t.tenantId, { baseUrl: "https://wn.example.com", code: CODE }, adapter)).ok).toBe(true);
    const s = await storedSecrets(t);
    expect(s.previousCallbackSecret).toBeUndefined();
    expect(s.apiKey).not.toBe(API_KEY);
  });

  it("a refusal from WhatsNexus saves nothing and says why in plain terms", async () => {
    const before = JSON.stringify(await storedSecrets(t));
    for (const [wnCode, status, reason] of [
      ["INVALID_PAIRING_CODE", 401, "pair_invalid_code"],
      ["PAIRING_CODE_EXPIRED", 410, "pair_code_expired"],
      ["TENANT_BINDING_MISMATCH", 403, "pair_binding_mismatch"],
      ["INVALID_REQUEST", 422, "pair_callback_rejected"],
    ] as const) {
      const { adapter } = wn(() => json(status, { success: false, error: { code: wnCode, message: "x" } }));
      expect(await pairWhatsNexus(db, t.tenantId, { baseUrl: "https://wn.example.com", code: CODE }, adapter)).toEqual({ ok: false, reason });
    }
    expect(JSON.stringify(await storedSecrets(t))).toBe(before);
  });

  it("an unreachable WhatsNexus, or a base URL that is not allowed, is refused before anything is saved", async () => {
    const down = createWhatsNexusAdapter({ fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch, isPublicHost: async () => true });
    expect(await pairWhatsNexus(db, t.tenantId, { baseUrl: "https://wn.example.com", code: CODE }, down)).toEqual({ ok: false, reason: "pair_unreachable" });
    const { adapter, fetchImpl } = wn(paired);
    expect((await pairWhatsNexus(db, t.tenantId, { baseUrl: "https://wn.example.com/some/path", code: CODE }, adapter)).ok).toBe(false);
    expect((await pairWhatsNexus(db, t.tenantId, { baseUrl: "http://wn.example.com", code: CODE }, adapter)).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a Super Admin action: an Admin is refused, input is validated, and only WhatsNexus can be paired", async () => {
    expect((await pairRoute(t, "HOSPITAL_ADMIN", { baseUrl: "https://wn.example.com", code: CODE })).statusCode).toBe(403);
    expect((await pairRoute(t, "SUPER_ADMIN", { baseUrl: "https://wn.example.com" })).statusCode).toBe(400);
    expect((await pairRoute(t, "SUPER_ADMIN", { baseUrl: "http://wn.example.com", code: CODE })).json()).toMatchObject({ error: "https_required" });
    expect((await call(t, "SUPER_ADMIN", "POST", "/integrations/hub/runo/pair", { baseUrl: "https://wn.example.com", code: CODE })).statusCode).toBe(404);
  });

  it("only touches the signed-in hospital, and its activity log never holds the code or anything it returned", async () => {
    const { adapter } = wn(paired);
    await pairWhatsNexus(db, other.tenantId, { baseUrl: "https://wn.example.com", code: CODE }, adapter);
    expect((await storedSecrets(other)).apiKey).toBe(API_KEY);
    // t was re-paired with different values above, so the two hospitals do not share credentials.
    expect((await storedSecrets(t)).apiKey).not.toBe((await storedSecrets(other)).apiKey);
    await pairRoute(other, "SUPER_ADMIN", { baseUrl: "https://wn.example.com", code: CODE }); // real adapter: cannot reach example.com in tests, still logs nothing secret
    const log = JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.tenantId, other.tenantId)));
    for (const secret of [CODE, API_KEY, CB_SECRET, "abcdefghijklmnopqrstuvwxyz0123456789"]) expect(log).not.toContain(secret);
  });
});
