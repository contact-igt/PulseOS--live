import { describe, expect, it, vi } from "vitest";
import { createWhatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { AmbiguousSendError, PermanentSendError, RetryableSendError } from "../domain/connector/types.js";
import { signWebhookBody } from "../domain/integration/webhook-rules.js";
import { parseWhatsNexusCallback, verifyWhatsNexusCallback } from "../domain/connector/whatsnexus-callback.js";

const config = { mode: "live", baseUrl: "https://wn.example.com", tenantId: "TT001", pulseosTenantId: "11111111-1111-4111-8111-111111111111" };
const secrets = { apiKey: "wnpk_test_key_value_1234567890" };
const NOTIFICATION_ID = "5b0e6f0e-0a55-4a39-9d3f-7e7f5a0c1d11";
const tpl = { name: "appointment_reminder", language: "en", parameters: ["Rahul", "Dr. Kumar", "12 Oct"], idempotencyKey: NOTIFICATION_ID };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const accepted = () => json(200, { success: true, dispatchId: "d-1", externalId: NOTIFICATION_ID, wamid: "wamid.REAL123", status: "accepted" });
const lookup = (dispatch: Record<string, unknown>) => json(200, { success: true, dispatch: { externalId: NOTIFICATION_ID, ...dispatch } });
const abort = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

const build = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const fetchImpl = vi.fn(impl as unknown as typeof fetch);
  return { adapter: createWhatsNexusAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, isPublicHost: async () => true }), fetchImpl };
};

describe("WhatsNexus adapter — pairing with a code", () => {
  const CODE = "wnpair_VFQwMDE.abcdefghijklmnopqrstuvwxyz0123456789";
  const PULSEOS = "11111111-1111-4111-8111-111111111111";
  const CALLBACK = "https://pulse.example.org/webhooks/whatsnexus/" + PULSEOS;
  const input = { baseUrl: "https://wn.example.com", code: CODE, pulseosTenantId: PULSEOS, callbackUrl: CALLBACK };
  const paired = () => json(200, { success: true, data: { whatsnexusTenantId: "TT001", apiKey: "wnpk_ab12cd34_" + "k".repeat(43), keyId: "ab12cd34", callbackSecret: "whcs_" + "s".repeat(43) } });

  it("posts only the code, this PulseOS tenant and its callback address to the unauthenticated pair endpoint, and returns what WhatsNexus issued", async () => {
    const { adapter, fetchImpl } = build(async () => paired());
    const r = await adapter.pair(input);
    expect(r).toEqual({ ok: true, whatsnexusTenantId: "TT001", apiKey: "wnpk_ab12cd34_" + "k".repeat(43), keyId: "ab12cd34", callbackSecret: "whcs_" + "s".repeat(43) });
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://wn.example.com/api/integrations/pulseos/pair");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body as string)).toEqual({ code: CODE, pulseosTenantId: PULSEOS, callbackUrl: CALLBACK });
    expect(Object.keys(init.headers as object).map((h) => h.toLowerCase())).not.toContain("x-api-key");
  });

  it.each([
    ["INVALID_PAIRING_CODE", 401, "invalid_code"],
    ["PAIRING_CODE_EXPIRED", 410, "code_expired"],
    ["TENANT_BINDING_MISMATCH", 403, "binding_mismatch"],
    ["TENANT_INACTIVE", 403, "tenant_inactive"],
    ["INTEGRATION_FLAG_OFF", 403, "integration_off"],
    ["INVALID_REQUEST", 422, "callback_rejected"],
    ["RATE_LIMITED", 429, "rate_limited"],
  ])("maps WhatsNexus's %s to a plain reason", async (code, status, reason) => {
    const { adapter } = build(async () => json(status, { success: false, error: { code, message: "x" } }));
    expect(await adapter.pair(input)).toEqual({ ok: false, reason });
  });

  it("refuses a bad base URL before any request, and a host that resolves to a private address", async () => {
    const { adapter, fetchImpl } = build(async () => paired());
    expect(await adapter.pair({ ...input, baseUrl: "http://wn.example.com" })).toMatchObject({ ok: false });
    expect(await adapter.pair({ ...input, baseUrl: "not a url" })).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const priv = createWhatsNexusAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, isPublicHost: async () => false });
    expect(await priv.pair(input)).toEqual({ ok: false, reason: "private_address" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a network failure or an unreadable answer never throws and never leaks the code", async () => {
    const down = build(async () => { throw Object.assign(new Error("fetch failed " + CODE), { cause: { code: "ECONNREFUSED" } }); });
    expect(await down.adapter.pair(input)).toEqual({ ok: false, reason: "unreachable" });
    expect(await build(async () => json(500, { nope: true })).adapter.pair(input)).toEqual({ ok: false, reason: "unexpected_response" });
    expect(await build(async () => new Response("<html>", { status: 200 })).adapter.pair(input)).toEqual({ ok: false, reason: "unexpected_response" });
  });

  it("a success that does not look like credentials is not accepted", async () => {
    const odd = build(async () => json(200, { success: true, data: { whatsnexusTenantId: "TT001", apiKey: "short", keyId: "x", callbackSecret: "whcs_" + "s".repeat(43) } }));
    expect(await odd.adapter.pair(input)).toEqual({ ok: false, reason: "unexpected_response" });
    const noTenant = build(async () => json(200, { success: true, data: { apiKey: "wnpk_ab12cd34_" + "k".repeat(43), keyId: "k", callbackSecret: "whcs_" + "s".repeat(43) } }));
    expect(await noTenant.adapter.pair(input)).toEqual({ ok: false, reason: "unexpected_response" });
  });
});

describe("WhatsNexus adapter — send contract", () => {
  it("posts the approved-template contract with tenant, key and idempotency headers, and returns the REAL wamid", async () => {
    const { adapter, fetchImpl } = build(async () => accepted());
    const res = await adapter.sendTemplate(config, secrets, "+919876543210", tpl);
    expect(res).toEqual({ providerMessageId: "wamid.REAL123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://wn.example.com/api/integrations/pulseos/messages");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const h = init.headers as Record<string, string>;
    expect(h["x-tenant-id"]).toBe("TT001");
    expect(h["x-api-key"]).toBe(secrets.apiKey);
    expect(h["x-pulseos-tenant-id"]).toBe(config.pulseosTenantId);
    expect(h["idempotency-key"]).toBe(NOTIFICATION_ID);
    expect(JSON.parse(init.body as string)).toEqual({
      externalId: NOTIFICATION_ID,
      phoneE164: "+919876543210",
      templateName: "appointment_reminder",
      language: "en",
      params: ["Rahul", "Dr. Kumar", "12 Oct"],
      source: "PULSE_OS",
      metadata: { pulseosTenantId: config.pulseosTenantId },
    });
  });

  it("adds the + to a digits-only phone and refuses non-E.164 numbers before any request", async () => {
    const { adapter, fetchImpl } = build(async () => accepted());
    await adapter.sendTemplate(config, secrets, "919876543210", tpl);
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string).phoneE164).toBe("+919876543210");
    await expect(adapter.sendTemplate(config, secrets, "12345", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to run outside LIVE mode, without an idempotency key, or without configuration — and never calls the network", async () => {
    const { adapter, fetchImpl } = build(async () => accepted());
    await expect(adapter.sendTemplate({ ...config, mode: "fixture" }, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", { ...tpl, idempotencyKey: undefined })).rejects.toBeInstanceOf(PermanentSendError);
    await expect(adapter.sendTemplate({ ...config, baseUrl: "" }, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    await expect(adapter.sendTemplate(config, {}, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never fabricates a message id: a 200 without a wamid is reconciled, not accepted", async () => {
    const { adapter, fetchImpl } = build(async (_u, init) => (init.method === "POST" ? json(200, { success: true }) : lookup({ status: "processing" })));
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(AmbiguousSendError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // POST, then a read-only lookup
  });

  it.each([
    [403, "INSUFFICIENT_BALANCE", false, PermanentSendError],
    [403, "BILLING_BLOCKED", false, PermanentSendError],
    [422, "TEMPLATE_NOT_APPROVED", false, PermanentSendError],
    [401, "INVALID_CREDENTIALS", false, PermanentSendError],
    [422, "META_REJECTED", false, PermanentSendError],
    [429, "META_TIER_LIMIT", true, RetryableSendError],
    [503, "SERVICE_UNAVAILABLE", true, RetryableSendError],
    [409, "DISPATCH_IN_PROGRESS", true, RetryableSendError],
  ])("HTTP %i %s is classified %s", async (status, code, retryable, cls) => {
    const { adapter, fetchImpl } = build(async () => json(status, { success: false, error: { code, message: "x", retryable } }));
    const err = await adapter.sendTemplate(config, secrets, "+919876543210", tpl).catch((e) => e);
    expect(err).toBeInstanceOf(cls);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no lookup, no resend
  });

  it("does not leak the API key into an error message", async () => {
    const { adapter } = build(async () => json(401, { error: { code: "INVALID_CREDENTIALS", message: `bad key ${secrets.apiKey}` } }));
    const err = (await adapter.sendTemplate(config, secrets, "+919876543210", tpl).catch((e) => e)) as Error;
    expect(String(err.message)).not.toContain(secrets.apiKey);
  });

  it("a host that does not resolve to a public address is refused before any request", async () => {
    const fetchImpl = vi.fn();
    const adapter = createWhatsNexusAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, isPublicHost: async () => false });
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    expect(fetchImpl).not.toHaveBeenCalled();
    const http = createWhatsNexusAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, isPublicHost: async () => true });
    await expect(http.sendTemplate({ ...config, baseUrl: "http://wn.example.com" }, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    await expect(http.sendTemplate({ ...config, baseUrl: "https://10.0.0.5" }, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it("an HTTP redirect is a failure, never followed", async () => {
    const { adapter, fetchImpl } = build(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(PermanentSendError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsNexus adapter — ambiguous outcomes use the lookup contract, never a resend", () => {
  const postCount = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST").length;

  it("timeout, then lookup says accepted → the real wamid, with exactly ONE POST", async () => {
    const { adapter, fetchImpl } = build(async (url, init) => {
      if (init.method === "POST") throw abort();
      expect(url).toBe(`https://wn.example.com/api/integrations/pulseos/dispatches/${NOTIFICATION_ID}`);
      return lookup({ status: "accepted", wamid: "wamid.FOUND" });
    });
    expect(await adapter.sendTemplate(config, secrets, "+919876543210", tpl)).toEqual({ providerMessageId: "wamid.FOUND" });
    expect(postCount(fetchImpl)).toBe(1);
  });

  it("timeout, then WhatsNexus has no record → retryable (safe: it never received it)", async () => {
    const { adapter, fetchImpl } = build(async (_u, init) => {
      if (init.method === "POST") throw abort();
      return json(404, { success: false, error: { code: "NOT_FOUND", message: "none" } });
    });
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(RetryableSendError);
    expect(postCount(fetchImpl)).toBe(1);
  });

  it("timeout, then still processing or unknown → stays ambiguous (nothing is resent)", async () => {
    for (const status of ["processing", "unknown_outcome"]) {
      const { adapter, fetchImpl } = build(async (_u, init) => {
        if (init.method === "POST") throw abort();
        return lookup({ status });
      });
      await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(AmbiguousSendError);
      expect(postCount(fetchImpl)).toBe(1);
    }
  });

  it("timeout and an unreachable lookup → ambiguous", async () => {
    const { adapter } = build(async () => {
      throw abort();
    });
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(AmbiguousSendError);
  });

  it("connection refused never reached WhatsNexus → retryable, no lookup", async () => {
    const { adapter, fetchImpl } = build(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(RetryableSendError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("WhatsNexus reporting DISPATCH_OUTCOME_UNKNOWN (409) is reconciled by lookup, not retried", async () => {
    const { adapter, fetchImpl } = build(async (_u, init) =>
      init.method === "POST" ? json(409, { success: false, error: { code: "DISPATCH_OUTCOME_UNKNOWN", message: "may have been sent" } }) : lookup({ status: "unknown_outcome" }),
    );
    await expect(adapter.sendTemplate(config, secrets, "+919876543210", tpl)).rejects.toBeInstanceOf(AmbiguousSendError);
    expect(postCount(fetchImpl)).toBe(1);
  });

  it("lookupSend maps every WhatsNexus state", async () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [{ status: "accepted", wamid: "wamid.X" }, { state: "accepted", providerMessageId: "wamid.X" }],
      [{ status: "accepted" }, { state: "unknown_outcome" }],
      [{ status: "processing" }, { state: "in_progress" }],
      [{ status: "unknown_outcome" }, { state: "unknown_outcome" }],
      [{ status: "failed", errorCode: "META_REJECTED", errorMessage: "bad", retryable: false }, { state: "failed", code: "META_REJECTED", message: "bad", retryable: false }],
    ];
    for (const [dispatch, expected] of cases) {
      const { adapter } = build(async () => lookup(dispatch));
      expect(await adapter.lookupSend!(config, secrets, NOTIFICATION_ID)).toEqual(expected);
    }
    const { adapter } = build(async () => json(404, { error: { code: "NOT_FOUND" } }));
    expect(await adapter.lookupSend!(config, secrets, NOTIFICATION_ID)).toEqual({ state: "not_found" });
  });
});

describe("WhatsNexus adapter — health probe (authenticated, never sends)", () => {
  it("CONNECTED / DEGRADED from the real health endpoint", async () => {
    const ok = build(async (url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toBe("https://wn.example.com/api/integrations/pulseos/health");
      return json(200, { success: true, status: "CONNECTED", checks: { database: "ok", callback: "configured" } });
    });
    expect(await ok.adapter.probeHealth(config, secrets)).toMatchObject({ ok: true, status: "CONNECTED" });
    const degraded = build(async () => json(200, { success: true, status: "DEGRADED", checks: { callback: "not_configured" } }));
    const d = await degraded.adapter.probeHealth(config, secrets);
    expect(d).toMatchObject({ ok: false, status: "DEGRADED" });
    expect(d.message).toContain("callback: not_configured");
  });

  it("bad credentials, switched-off integration, unreachable server and missing config are distinguished", async () => {
    expect((await build(async () => json(401, { error: { code: "INVALID_CREDENTIALS" } })).adapter.probeHealth(config, secrets)).status).toBe("ERROR");
    expect((await build(async () => json(403, { error: { code: "INTEGRATION_DISABLED" } })).adapter.probeHealth(config, secrets)).status).toBe("DISABLED");
    expect((await build(async () => { throw abort(); }).adapter.probeHealth(config, secrets)).status).toBe("ERROR");
    expect((await build(async () => accepted()).adapter.probeHealth({ ...config, baseUrl: "" }, secrets)).status).toBe("NOT_CONFIGURED");
  });
});

describe("WhatsNexus adapter — approved-template catalogue (read-only, never sends)", () => {
  const entry = { name: "pulseos_follow_up_message", language: "en", status: "APPROVED", category: "utility", templateType: "text", bodyParameterCount: 3, hasHeader: false, hasButtons: false };

  it("an older WhatsNexus that reports no category or type still works: they read as null, and unknown values are dropped", async () => {
    const { category, templateType, ...old } = entry;
    void category; void templateType;
    const a = await build(async () => json(200, { templates: [old] })).adapter.listTemplates(config, secrets);
    expect(a).toEqual({ ok: true, templates: [{ ...old, category: null, templateType: null, body: null }] });
    const b = await build(async () => json(200, { templates: [{ ...entry, category: "service", templateType: "Hologram!" }] })).adapter.listTemplates(config, secrets);
    expect(b).toEqual({ ok: true, templates: [{ ...entry, category: null, templateType: null, body: null }] });
  });

  it("GETs /templates with the same machine headers as a send and returns the approved templates", async () => {
    const { adapter, fetchImpl } = build(async () => json(200, { templates: [entry] }));
    const res = await adapter.listTemplates(config, secrets);
    expect(res).toEqual({ ok: true, templates: [{ ...entry, body: null }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://wn.example.com/api/integrations/pulseos/templates");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    const h = init.headers as Record<string, string>;
    expect(h["x-tenant-id"]).toBe("TT001");
    expect(h["x-api-key"]).toBe(secrets.apiKey);
    expect(h["x-pulseos-tenant-id"]).toBe(config.pulseosTenantId);
    expect(h["idempotency-key"]).toBeUndefined();
  });

  it("keeps only well-formed APPROVED entries and only the fields PulseOS uses", async () => {
    const { adapter } = build(async () =>
      json(200, {
        templates: [
          { ...entry, accessToken: "EAAsecret", example: "Hi Asha" },
          { ...entry, name: "paused_one", status: "PAUSED" },
          { ...entry, name: "bad_count", bodyParameterCount: -1 },
          { ...entry, name: "no_lang", language: "" },
          { ...entry, name: 42 },
          null,
          "text",
        ],
      }),
    );
    const res = await adapter.listTemplates(config, secrets);
    expect(res).toEqual({ ok: true, templates: [{ ...entry, body: null }] });
  });

  it("an unreadable or wrongly shaped reply is an error, never an empty catalogue", async () => {
    for (const reply of [() => new Response("<html>oops</html>", { status: 200 }), () => json(200, {}), () => json(200, { templates: "none" })]) {
      const res = await build(async () => reply()).adapter.listTemplates(config, secrets);
      expect(res).toMatchObject({ ok: false, state: "UNAVAILABLE" });
    }
  });

  it("distinguishes missing configuration, bad credentials, a switched-off integration and an unreachable server", async () => {
    expect(await build(async () => json(200, {})).adapter.listTemplates({ ...config, baseUrl: "" }, secrets)).toMatchObject({ ok: false, state: "NOT_CONFIGURED" });
    expect(await build(async () => json(200, {})).adapter.listTemplates(config, {})).toMatchObject({ ok: false, state: "NOT_CONFIGURED" });
    expect(await build(async () => json(401, { error: { code: "INVALID_CREDENTIALS" } })).adapter.listTemplates(config, secrets)).toMatchObject({ ok: false, state: "REJECTED" });
    expect(await build(async () => json(403, { error: { code: "TENANT_BINDING_MISMATCH" } })).adapter.listTemplates(config, secrets)).toMatchObject({ ok: false, state: "REJECTED" });
    expect(await build(async () => json(403, { error: { code: "INTEGRATION_DISABLED" } })).adapter.listTemplates(config, secrets)).toMatchObject({ ok: false, state: "DISABLED" });
    expect(await build(async () => json(503, { error: { code: "SERVICE_UNAVAILABLE" } })).adapter.listTemplates(config, secrets)).toMatchObject({ ok: false, state: "UNAVAILABLE" });
    expect(await build(async () => { throw abort(); }).adapter.listTemplates(config, secrets)).toMatchObject({ ok: false, state: "UNAVAILABLE" });
  });

  it("never leaks the API key, never follows a redirect, refuses a private host before any request", async () => {
    const leak = await build(async () => json(401, { error: { code: "INVALID_CREDENTIALS", message: `bad key ${secrets.apiKey}` } })).adapter.listTemplates(config, secrets);
    expect(JSON.stringify(leak)).not.toContain(secrets.apiKey);
    const redirect = build(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    expect(await redirect.adapter.listTemplates(config, secrets)).toMatchObject({ ok: false });
    expect(redirect.fetchImpl).toHaveBeenCalledTimes(1);
    const fetchImpl = vi.fn();
    const priv = createWhatsNexusAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, isPublicHost: async () => false });
    expect(await priv.listTemplates(config, secrets)).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("WhatsNexus callback authentication", () => {
  const cbSecrets = { callbackSecret: "cb_secret_value_0123456789abcdef" };
  const body = JSON.stringify({ eventId: "d1:delivered", dispatchId: "d1", externalId: NOTIFICATION_ID, wamid: "wamid.R", status: "delivered", occurredAt: "2026-10-10T12:00:00.000Z" });
  const now = 1_760_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const sig = signWebhookBody(cbSecrets.callbackSecret, ts, body);

  it("accepts a correctly signed, fresh callback", () => {
    expect(verifyWhatsNexusCallback(cbSecrets, body, ts, sig, now)).toBe("ok");
  });
  it("rejects missing, wrong, tampered, other-secret and stale callbacks", () => {
    expect(verifyWhatsNexusCallback(cbSecrets, body, undefined, sig, now)).toBe("missing");
    expect(verifyWhatsNexusCallback(cbSecrets, body, ts, undefined, now)).toBe("missing");
    expect(verifyWhatsNexusCallback(cbSecrets, body, ts, "sha256=" + "0".repeat(64), now)).toBe("invalid_signature");
    expect(verifyWhatsNexusCallback(cbSecrets, body.replace("delivered", "read"), ts, sig, now)).toBe("invalid_signature");
    expect(verifyWhatsNexusCallback({ callbackSecret: "another_secret_value_0123456789" }, body, ts, sig, now)).toBe("invalid_signature");
    expect(verifyWhatsNexusCallback(null, body, ts, sig, now)).toBe("invalid_signature");
    expect(verifyWhatsNexusCallback(cbSecrets, body, ts, sig, now + 6 * 60_000)).toBe("stale");
    expect(verifyWhatsNexusCallback(cbSecrets, body, ts, sig, now - 6 * 60_000)).toBe("stale");
  });
  it("accepts the previous secret during rotation, only while it is stored", () => {
    const rotated = { callbackSecret: "new_secret_value_0123456789abcdef", previousCallbackSecret: cbSecrets.callbackSecret };
    expect(verifyWhatsNexusCallback(rotated, body, ts, sig, now)).toBe("ok");
    expect(verifyWhatsNexusCallback({ callbackSecret: rotated.callbackSecret }, body, ts, sig, now)).toBe("invalid_signature");
  });
  it("parses only the strict contract: a journey id is not a notification id", () => {
    const good = parseWhatsNexusCallback(JSON.parse(body));
    expect(good.ok && "externalId" in good.event && good.event.externalId).toBe(NOTIFICATION_ID);
    expect(parseWhatsNexusCallback({ ...JSON.parse(body), externalId: "journey-123" })).toMatchObject({ ok: false, reason: "invalid_external_id" });
    expect(parseWhatsNexusCallback({ ...JSON.parse(body), status: "deleted" })).toMatchObject({ ok: false, reason: "invalid_status" });
    expect(parseWhatsNexusCallback({ ...JSON.parse(body), wamid: "" })).toMatchObject({ ok: false });
    expect(parseWhatsNexusCallback({ ...JSON.parse(body), occurredAt: "nope" })).toMatchObject({ ok: false });
    expect(parseWhatsNexusCallback(null)).toMatchObject({ ok: false });
  });
  it("parses a signed ping (the WhatsNexus setup test) and nothing else shaped like one", () => {
    expect(parseWhatsNexusCallback({ type: "ping", eventId: "ping-abc", sentAt: "2026-10-13T10:00:00.000Z" })).toMatchObject({ ok: true, event: { kind: "ping", eventId: "ping-abc" } });
    expect(parseWhatsNexusCallback({ type: "ping", sentAt: "2026-10-13T10:00:00.000Z" })).toMatchObject({ ok: false, reason: "invalid_event_id" });
  });
  it("parses a signed inbound image without accepting an arbitrary attachment shape", () => {
    const inbound = parseWhatsNexusCallback({
      type: "inbound_message", eventId: "wamid.inbound.1", externalThreadId: "+919999999999", fromPhone: "+919999999999",
      body: "Please call me", occurredAt: "2026-10-13T10:00:00.000Z", phoneNumberId: "123",
      attachments: [{ kind: "image", providerMediaId: "media_123", fileName: null, mimeType: "image/jpeg", sizeBytes: 42 }],
    });
    expect(inbound).toMatchObject({ ok: true, event: { externalEventId: "wamid.inbound.1", attachments: [{ kind: "image", providerMediaId: "media_123" }] } });
    expect(parseWhatsNexusCallback({ type: "inbound_message", eventId: "x", externalThreadId: "x", fromPhone: "x", body: "", occurredAt: "2026-10-13T10:00:00.000Z", attachments: [{ kind: "image" }] })).toMatchObject({ ok: false, reason: "invalid_attachment" });
  });

  it("accepts an attachment whose size WhatsNexus does not know (it sends null): an image or a voice note must not be refused", () => {
    const base = { type: "inbound_message", eventId: "wamid.in.9", externalThreadId: "919999999999", fromPhone: "919999999999", body: "", occurredAt: "2026-10-13T10:00:00.000Z" };
    for (const kind of ["image", "document", "audio"]) {
      const r = parseWhatsNexusCallback({ ...base, attachments: [{ kind, providerMediaId: "wamid.in.9", fileName: null, mimeType: null, sizeBytes: null }] });
      expect(r).toMatchObject({ ok: true, event: { attachments: [{ kind, providerMediaId: "wamid.in.9", sizeBytes: null }] } });
    }
    // a size that is present but nonsense is still refused
    expect(parseWhatsNexusCallback({ ...base, attachments: [{ kind: "image", providerMediaId: "x", sizeBytes: -5 }] })).toMatchObject({ ok: false, reason: "invalid_attachment" });
    expect(parseWhatsNexusCallback({ ...base, attachments: [{ kind: "image", providerMediaId: "x", sizeBytes: "big" }] })).toMatchObject({ ok: false, reason: "invalid_attachment" });
  });

  describe("outbound_message: what WhatsNexus itself sent (AI assistant, its agents)", () => {
    const out = (over: Record<string, unknown> = {}) => ({
      type: "outbound_message", eventId: "out:wamid.AI1", wamid: "wamid.AI1", externalThreadId: "916369441531", toPhone: "916369441531",
      sender: "ai", senderName: null, body: "Sure, I can help.", messageType: "text", templateName: null, status: "sent",
      occurredAt: "2026-10-13T08:06:00.000Z", phoneNumberId: "pn-1", attachments: [], ...over,
    });

    it("parses an AI reply and an agent message with their sender, name, status and attachments", () => {
      expect(parseWhatsNexusCallback(out())).toMatchObject({ ok: true, event: { kind: "outbound", eventId: "out:wamid.AI1", wamid: "wamid.AI1", externalThreadId: "916369441531", sender: "ai", senderName: null, body: "Sure, I can help.", status: "sent" } });
      const agent = parseWhatsNexusCallback(out({ sender: "agent", senderName: "Priya Nair", attachments: [{ kind: "document", providerMediaId: "wamid.AI1", fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: null }] }));
      expect(agent).toMatchObject({ ok: true, event: { sender: "agent", senderName: "Priya Nair", attachments: [{ kind: "document", providerMediaId: "wamid.AI1", fileName: "report.pdf" }] } });
    });

    it("refuses anything unexpected: unknown sender, missing wamid/thread, bad time, bad attachment, oversized body", () => {
      expect(parseWhatsNexusCallback(out({ sender: "patient" }))).toMatchObject({ ok: false, reason: "invalid_outbound_message" });
      expect(parseWhatsNexusCallback(out({ sender: "pulseos" }))).toMatchObject({ ok: false });
      expect(parseWhatsNexusCallback(out({ wamid: "" }))).toMatchObject({ ok: false, reason: "invalid_outbound_message" });
      expect(parseWhatsNexusCallback(out({ externalThreadId: "" }))).toMatchObject({ ok: false });
      expect(parseWhatsNexusCallback(out({ occurredAt: "nope" }))).toMatchObject({ ok: false });
      expect(parseWhatsNexusCallback(out({ eventId: "" }))).toMatchObject({ ok: false, reason: "invalid_event_id" });
      expect(parseWhatsNexusCallback(out({ attachments: [{ kind: "sticker", providerMediaId: "x" }] }))).toMatchObject({ ok: false, reason: "invalid_attachment" });
      expect(parseWhatsNexusCallback(out({ attachments: [{ kind: "video", providerMediaId: "x" }] }))).toMatchObject({ ok: true });
      expect(parseWhatsNexusCallback(out({ body: "x".repeat(4097) }))).toMatchObject({ ok: false });
    });

    it("keeps what kind of message it was and which template, and treats anything unknown as plain text", () => {
      expect(parseWhatsNexusCallback(out({ messageType: "template", templateName: "diwali_offer" }))).toMatchObject({ ok: true, event: { messageType: "template", templateName: "diwali_offer" } });
      expect(parseWhatsNexusCallback(out())).toMatchObject({ ok: true, event: { messageType: "text", templateName: null } });
      expect(parseWhatsNexusCallback(out({ messageType: "hologram", templateName: 42 }))).toMatchObject({ ok: true, event: { messageType: "text", templateName: null } });
      expect(parseWhatsNexusCallback(out({ messageType: "image" }))).toMatchObject({ ok: true, event: { messageType: "text" } });
    });

    it("an unknown delivery status is read as 'sent' rather than refused, so a new provider status never drops the message", () => {
      expect(parseWhatsNexusCallback(out({ status: "weird" }))).toMatchObject({ ok: true, event: { status: "sent" } });
      expect(parseWhatsNexusCallback(out({ status: "failed" }))).toMatchObject({ ok: true, event: { status: "failed" } });
    });
  });
});
