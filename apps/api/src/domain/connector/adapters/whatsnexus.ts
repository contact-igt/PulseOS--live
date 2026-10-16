import type { ProviderTemplate } from "@pulseos/types";
import { buildFullWebhookUrl, resolvesToPublicAddresses, validateWebhookUrl, webhookAllowInsecure } from "../../integration/webhook-rules.js";
import { redactLogText } from "../../security/redact.js";
import {
  AmbiguousSendError,
  PermanentSendError,
  RetryableSendError,
  type MessagingProviderAdapter,
  type ParsedWhatsAppWebhook,
  type SendLookupResult,
} from "../types.js";

// WhatsNexus is a messaging PROVIDER behind the same adapter seam as Meta Cloud: WhatsNexus owns Meta delivery, the
// hospital's wallet and template approval; PulseOS only asks it to send an approved template and hears the real WhatsApp
// message id (wamid) back. Contract (see WhatsNexus src/models/IntegrationModel):
//   POST {baseUrl}/api/integrations/pulseos/messages        Idempotency-Key = notifications.id
//   GET  {baseUrl}/api/integrations/pulseos/dispatches/:id  read-only reconciliation, never sends
//   GET  {baseUrl}/api/integrations/pulseos/health          authenticated connectivity check, never sends
// Delivery statuses come back as HMAC-signed callbacks handled in webhook.routes.ts (not through this adapter).

const BASE = "/api/integrations/pulseos";
const SEND_TIMEOUT_MS = 20_000;
const LOOKUP_TIMEOUT_MS = 10_000;

export interface WhatsNexusDeps {
  fetchImpl?: typeof fetch;
  /** Replaceable in tests; production resolves DNS and refuses private addresses. */
  isPublicHost?: (host: string) => Promise<boolean>;
}

/** The parts of WhatsNexus's JSON replies this adapter reads (everything else is ignored). */
interface WhatsNexusJson {
  success?: boolean;
  wamid?: string;
  status?: string;
  checks?: Record<string, unknown>;
  error?: { code?: string; message?: string; retryable?: boolean };
  dispatch?: { status?: string; wamid?: string; errorCode?: string; errorMessage?: string; retryable?: boolean };
  templates?: unknown;
}

interface WhatsNexusEnvelope {
  status: number;
  json: WhatsNexusJson | null;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const KEY_SHAPES = /\b(?:wnpk|whcs)_[A-Za-z0-9_-]{6,}/g;

/** Provider text may echo what we sent: strip credential-shaped strings and the exact secrets we hold. */
function scrub(text: string, secrets: Record<string, unknown>): string {
  let t = redactLogText(text) ?? "";
  for (const v of Object.values(secrets)) if (typeof v === "string" && v.length >= 8) t = t.split(v).join("[redacted]");
  return t.replace(KEY_SHAPES, "[redacted]");
}

function readConfig(config: Record<string, unknown>, secrets: Record<string, unknown>) {
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  const tenantId = typeof config.tenantId === "string" ? config.tenantId.trim() : "";
  const apiKey = typeof secrets.apiKey === "string" ? secrets.apiKey.trim() : "";
  const pulseosTenantId = typeof config.pulseosTenantId === "string" ? config.pulseosTenantId : "";
  return { baseUrl, tenantId, apiKey, pulseosTenantId };
}

export type WhatsNexusPairReason =
  | "invalid_url"
  | "private_address"
  | "invalid_code"
  | "code_expired"
  | "binding_mismatch"
  | "tenant_inactive"
  | "integration_off"
  | "callback_rejected"
  | "rate_limited"
  | "unreachable"
  | "unexpected_response";

export type WhatsNexusPairResult =
  | { ok: true; whatsnexusTenantId: string; apiKey: string; keyId: string; callbackSecret: string }
  | { ok: false; reason: WhatsNexusPairReason };

/** WhatsNexus's own error codes for a pairing attempt, in this product's words. */
const PAIR_REASONS: Record<string, WhatsNexusPairReason> = {
  INVALID_PAIRING_CODE: "invalid_code",
  PAIRING_CODE_EXPIRED: "code_expired",
  TENANT_BINDING_MISMATCH: "binding_mismatch",
  TENANT_INACTIVE: "tenant_inactive",
  INTEGRATION_FLAG_OFF: "integration_off",
  INVALID_REQUEST: "callback_rejected",
  RATE_LIMITED: "rate_limited",
};

export function createWhatsNexusAdapter(deps: WhatsNexusDeps = {}): MessagingProviderAdapter & {
  /**
   * Redeem a pairing code: WhatsNexus answers with the API key and callback secret for this hospital, in this one reply. The
   * only WhatsNexus call that needs no credentials (the code is the credential). Never throws; the code is never echoed.
   */
  pair(input: { baseUrl: string; code: string; pulseosTenantId: string; callbackUrl: string }): Promise<WhatsNexusPairResult>;
  probeHealth(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<WhatsNexusHealth>;
  listTemplates(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<WhatsNexusTemplatesResult>;
} {
  const doFetch = deps.fetchImpl ?? (fetch as typeof fetch);
  const isPublicHost = deps.isPublicHost ?? resolvesToPublicAddresses;

  async function call(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; timeoutMs: number },
  ): Promise<WhatsNexusEnvelope> {
    const { baseUrl, tenantId, apiKey, pulseosTenantId } = readConfig(config, secrets);
    if (!baseUrl || !tenantId || !apiKey) throw new PermanentSendError("WhatsNexus is not fully configured", "not_configured");
    const target = validateWebhookUrl(buildFullWebhookUrl(baseUrl, `${BASE}${path}`), { allowInsecure: webhookAllowInsecure() });
    if (!target.ok) throw new PermanentSendError(`WhatsNexus URL rejected: ${target.reason}`, "invalid_url");
    // Re-checked at call time against what the name resolves to now (same guard as the outbound-webhook deliverer).
    if (!webhookAllowInsecure() && !(await isPublicHost(new URL(target.url).hostname))) {
      throw new PermanentSendError("WhatsNexus URL resolves to a non-public address", "private_address");
    }
    const res = await doFetch(target.url, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-tenant-id": tenantId,
        "x-api-key": apiKey,
        ...(pulseosTenantId ? { "x-pulseos-tenant-id": pulseosTenantId } : {}),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // A redirect could point anywhere, including this network, and would carry the API key with it.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    let json: WhatsNexusJson | null = null;
    try {
      const text = await res.text();
      json = text ? (JSON.parse(text) as WhatsNexusJson) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** Network failure classification: never-connected means nothing was sent; anything else may have been. */
  function transportError(err: unknown, secrets: Record<string, unknown>): Error {
    if (err instanceof PermanentSendError) return err;
    const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (cause && ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(cause)) {
      return new RetryableSendError(`WhatsNexus unreachable (${cause})`, "unreachable");
    }
    const message = scrub(err instanceof Error ? err.message : String(err), secrets) || "network error";
    return new AmbiguousSendError(`WhatsNexus request outcome unknown: ${message}`);
  }

  /** Map a WhatsNexus error envelope onto the three PulseOS failure classes. */
  function classifyHttpFailure(res: WhatsNexusEnvelope, secrets: Record<string, unknown>): Error {
    const code = String(res.json?.error?.code ?? `HTTP_${res.status}`);
    const message = scrub(String(res.json?.error?.message ?? `WhatsNexus returned HTTP ${res.status}`), secrets) || code;
    if (code === "DISPATCH_OUTCOME_UNKNOWN") return new AmbiguousSendError(`${code}: ${message}`);
    if (code === "DISPATCH_IN_PROGRESS") return new RetryableSendError(`${code}: ${message}`, code);
    if (res.json?.error?.retryable === true || res.status === 429 || res.status === 503) return new RetryableSendError(`${code}: ${message}`, code);
    if (res.status >= 500) return new AmbiguousSendError(`${code}: ${message}`);
    return new PermanentSendError(`${code}: ${message}`, code);
  }

  async function lookupSend(config: Record<string, unknown>, secrets: Record<string, unknown>, externalId: string): Promise<SendLookupResult> {
    let res: WhatsNexusEnvelope;
    try {
      res = await call(config, secrets, "GET", `/dispatches/${encodeURIComponent(externalId)}`, { timeoutMs: LOOKUP_TIMEOUT_MS });
    } catch (err) {
      throw transportError(err, secrets);
    }
    if (res.status === 404) return { state: "not_found" };
    if (res.status !== 200 || !res.json?.dispatch) throw classifyHttpFailure(res, secrets);
    const d = res.json.dispatch;
    switch (d.status) {
      case "accepted":
        return typeof d.wamid === "string" && d.wamid ? { state: "accepted", providerMessageId: d.wamid } : { state: "unknown_outcome" };
      case "processing":
        return { state: "in_progress" };
      case "unknown_outcome":
        return { state: "unknown_outcome" };
      case "failed":
        return { state: "failed", code: String(d.errorCode ?? "FAILED"), message: String(d.errorMessage ?? "Dispatch failed"), retryable: !!d.retryable };
      default:
        return { state: "unknown_outcome" };
    }
  }

  return {
    capabilities: ["SEND_MESSAGE", "RECEIVE_STATUS"],

    // WhatsNexus does not use Meta-style GET challenges or X-Hub-Signature webhooks on PulseOS.
    verifyWebhookChallenge: () => null,
    verifyWebhookSignature: () => false,
    parseWebhookPayload: (): ParsedWhatsAppWebhook => ({ messages: [], statuses: [] }),

    async sendMessage(config, secrets, to, body) {
      if (config.mode !== "live") throw new PermanentSendError("WhatsNexus sends only in LIVE mode", "not_live");
      const phone = to.startsWith("+") ? to : `+${to.replace(/\D/g, "")}`;
      if (!E164.test(phone)) throw new PermanentSendError("Patient phone is not a valid E.164 number", "invalid_phone");
      let res: WhatsNexusEnvelope;
      try {
        res = await call(config, secrets, "POST", "/text", { timeoutMs: SEND_TIMEOUT_MS, body: { phoneE164: phone, body } });
      } catch (err) {
        throw transportError(err, secrets);
      }
      if (res.status === 200 && res.json?.success === true && typeof res.json.wamid === "string" && res.json.wamid) return { providerMessageId: res.json.wamid };
      throw classifyHttpFailure(res, secrets);
    },

    async sendMedia(config, secrets, to, media) {
      if (config.mode !== "live") throw new PermanentSendError("WhatsNexus sends only in LIVE mode", "not_live");
      const phone = to.startsWith("+") ? to : `+${to.replace(/\D/g, "")}`;
      if (!E164.test(phone)) throw new PermanentSendError("Patient phone is not a valid E.164 number", "invalid_phone");
      let res: WhatsNexusEnvelope;
      try {
        res = await call(config, secrets, "POST", "/media", { idempotencyKey: media.idempotencyKey, timeoutMs: 60_000, body: { phoneE164: phone, ...media } });
      } catch (err) {
        throw transportError(err, secrets);
      }
      if (res.status === 200 && res.json?.success === true && typeof res.json.wamid === "string" && res.json.wamid) return { providerMessageId: res.json.wamid };
      throw classifyHttpFailure(res, secrets);
    },

    async sendTemplate(config, secrets, to, template) {
      if (config.mode !== "live") throw new PermanentSendError("WhatsNexus sends only in LIVE mode", "not_live");
      const key = template.idempotencyKey;
      if (!key) throw new PermanentSendError("A WhatsNexus send needs an idempotency key", "missing_idempotency_key");
      const phone = to.startsWith("+") ? to : `+${to.replace(/\D/g, "")}`;
      if (!E164.test(phone)) throw new PermanentSendError("Patient phone is not a valid E.164 number", "invalid_phone");
      const { pulseosTenantId } = readConfig(config, secrets);

      let res: WhatsNexusEnvelope;
      try {
        res = await call(config, secrets, "POST", "/messages", {
          idempotencyKey: key,
          timeoutMs: SEND_TIMEOUT_MS,
          body: {
            externalId: key,
            phoneE164: phone,
            templateName: template.name,
            language: template.language,
            params: template.parameters,
            source: "PULSE_OS",
            metadata: pulseosTenantId ? { pulseosTenantId } : undefined,
          },
        });
      } catch (err) {
        const classified = transportError(err, secrets);
        if (classified instanceof AmbiguousSendError) return reconcileAmbiguous(config, secrets, key, classified);
        throw classified;
      }

      if (res.status === 200 && res.json?.success === true && typeof res.json.wamid === "string" && res.json.wamid) {
        return { providerMessageId: res.json.wamid };
      }
      // 2xx that is not a clear acceptance (unreadable / no wamid): the message may have been sent.
      if (res.status >= 200 && res.status < 300) return reconcileAmbiguous(config, secrets, key, new AmbiguousSendError("WhatsNexus replied OK without a message id"));
      const failure = classifyHttpFailure(res, secrets);
      if (failure instanceof AmbiguousSendError) return reconcileAmbiguous(config, secrets, key, failure);
      throw failure;
    },

    lookupSend,

    listTemplates,

    async pair({ baseUrl, code, pulseosTenantId, callbackUrl }): Promise<WhatsNexusPairResult> {
      const target = validateWebhookUrl(buildFullWebhookUrl(baseUrl.trim(), `${BASE}/pair`), { allowInsecure: webhookAllowInsecure() });
      if (!target.ok) return { ok: false, reason: "invalid_url" };
      if (!webhookAllowInsecure() && !(await isPublicHost(new URL(target.url).hostname))) return { ok: false, reason: "private_address" };
      let res: Response;
      try {
        res = await doFetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ code, pulseosTenantId, callbackUrl }),
          redirect: "manual", // a redirect could carry the code somewhere else
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      let json: (WhatsNexusJson & { data?: Record<string, unknown> }) | null = null;
      try {
        const text = await res.text();
        json = text ? (JSON.parse(text) as WhatsNexusJson & { data?: Record<string, unknown> }) : null;
      } catch {
        json = null;
      }
      if (res.status === 200 && json?.success === true) {
        const d = json.data ?? {};
        const apiKey = typeof d.apiKey === "string" ? d.apiKey : "";
        const callbackSecret = typeof d.callbackSecret === "string" ? d.callbackSecret : "";
        const whatsnexusTenantId = typeof d.whatsnexusTenantId === "string" ? d.whatsnexusTenantId : "";
        const keyId = typeof d.keyId === "string" ? d.keyId : "";
        if (!/^wnpk_[A-Za-z0-9_-]{16,}$/.test(apiKey) || !/^whcs_[A-Za-z0-9_-]{16,}$/.test(callbackSecret) || !/^[A-Za-z0-9_-]{1,100}$/.test(whatsnexusTenantId)) {
          return { ok: false, reason: "unexpected_response" };
        }
        return { ok: true, whatsnexusTenantId, apiKey, keyId, callbackSecret };
      }
      const reason = PAIR_REASONS[String(json?.error?.code ?? "")];
      return { ok: false, reason: reason ?? "unexpected_response" };
    },

    async probeHealth(config, secrets): Promise<WhatsNexusHealth> {
      const { baseUrl, tenantId, apiKey } = readConfig(config, secrets);
      if (!baseUrl || !tenantId || !apiKey) {
        return { status: "NOT_CONFIGURED", ok: false, message: "WhatsNexus base URL, tenant id and API key are required." };
      }
      let res: WhatsNexusEnvelope;
      try {
        res = await call(config, secrets, "GET", "/health", { timeoutMs: LOOKUP_TIMEOUT_MS });
      } catch (err) {
        const reason = err instanceof PermanentSendError ? err.message : scrub(err instanceof Error ? err.message : String(err), secrets) || "unreachable";
        return { status: "ERROR", ok: false, message: `Could not reach WhatsNexus: ${reason}` };
      }
      const code = String(res.json?.error?.code ?? "");
      if (res.status === 200 && res.json?.success === true) {
        const status = res.json.status === "CONNECTED" ? "CONNECTED" : res.json.status === "DEGRADED" ? "DEGRADED" : "ERROR";
        return { status, ok: status === "CONNECTED", message: healthMessage(status, res.json.checks), details: res.json.checks ?? {} };
      }
      if (code === "INTEGRATION_DISABLED" || code === "INTEGRATION_FLAG_OFF") return { status: "DISABLED", ok: false, message: "The integration is switched off on the WhatsNexus side." };
      if (res.status === 401 || res.status === 403) return { status: "ERROR", ok: false, message: `WhatsNexus rejected the credentials (${code || res.status}).` };
      return { status: "ERROR", ok: false, message: `WhatsNexus health check failed (${code || `HTTP ${res.status}`}).` };
    },
  };

  /** One catalogue entry, or null when it is malformed or not APPROVED. Only the fields PulseOS uses are copied. */
  function parseTemplate(raw: unknown): ProviderTemplate | null {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (t.status !== "APPROVED") return null;
    if (typeof t.name !== "string" || !t.name || typeof t.language !== "string" || !t.language) return null;
    if (typeof t.bodyParameterCount !== "number" || !Number.isInteger(t.bodyParameterCount) || t.bodyParameterCount < 0 || t.bodyParameterCount > 30) return null;
    const category = typeof t.category === "string" && ["utility", "marketing", "authentication"].includes(t.category) ? (t.category as ProviderTemplate["category"]) : null;
    const templateType = typeof t.templateType === "string" && /^[a-z_]{1,20}$/.test(t.templateType) ? t.templateType : null;
    const body = typeof t.body === "string" && t.body.length <= 4096 ? t.body : null;
    return { name: t.name, language: t.language, status: "APPROVED", category, templateType, bodyParameterCount: t.bodyParameterCount, body, hasHeader: t.hasHeader === true, hasButtons: t.hasButtons === true };
  }

  /** The tenant's approved templates, read-only. Never cached here: callers ask again whenever the answer matters. */
  async function listTemplates(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<WhatsNexusTemplatesResult> {
    let res: WhatsNexusEnvelope;
    try {
      res = await call(config, secrets, "GET", "/templates", { timeoutMs: LOOKUP_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof PermanentSendError) {
        return { ok: false, state: err.code === "not_configured" ? "NOT_CONFIGURED" : "UNAVAILABLE", message: scrub(err.message, secrets) };
      }
      const reason = scrub(err instanceof Error ? err.message : String(err), secrets) || "unreachable";
      return { ok: false, state: "UNAVAILABLE", message: `Could not reach WhatsNexus: ${reason}` };
    }
    const code = String(res.json?.error?.code ?? "");
    if (res.status === 200 && Array.isArray(res.json?.templates)) {
      return { ok: true, templates: res.json.templates.map(parseTemplate).filter((t): t is ProviderTemplate => t !== null) };
    }
    if (code === "INTEGRATION_DISABLED" || code === "INTEGRATION_FLAG_OFF") return { ok: false, state: "DISABLED", message: "The integration is switched off on the WhatsNexus side." };
    if (res.status === 401 || res.status === 403) return { ok: false, state: "REJECTED", message: `WhatsNexus rejected the credentials (${code || res.status}).` };
    if (res.status === 200) return { ok: false, state: "UNAVAILABLE", message: "WhatsNexus returned a template list PulseOS could not read." };
    return { ok: false, state: "UNAVAILABLE", message: `WhatsNexus could not list templates (${code || `HTTP ${res.status}`}).` };
  }

  /** An ambiguous POST is never re-sent: ask WhatsNexus (same key) what happened. */
  async function reconcileAmbiguous(config: Record<string, unknown>, secrets: Record<string, unknown>, key: string, original: AmbiguousSendError): Promise<{ providerMessageId: string }> {
    let found: SendLookupResult;
    try {
      found = await lookupSend(config, secrets, key);
    } catch {
      throw original;
    }
    switch (found.state) {
      case "accepted":
        return { providerMessageId: found.providerMessageId };
      case "not_found":
        // The request never created a dispatch: nothing was sent, so a later retry with the same key is safe.
        throw new RetryableSendError("WhatsNexus has no record of the request; safe to retry", "not_received");
      case "failed":
        if (found.retryable) throw new RetryableSendError(`${found.code}: ${found.message}`, found.code);
        throw new PermanentSendError(`${found.code}: ${found.message}`, found.code);
      default:
        throw original;
    }
  }
}

export type WhatsNexusTemplatesResult =
  | { ok: true; templates: ProviderTemplate[] }
  | { ok: false; state: "NOT_CONFIGURED" | "DISABLED" | "REJECTED" | "UNAVAILABLE"; message: string };

export interface WhatsNexusHealth {
  ok: boolean;
  status: "NOT_CONFIGURED" | "DISABLED" | "CONNECTED" | "DEGRADED" | "ERROR";
  message: string;
  details?: Record<string, unknown>;
}

function healthMessage(status: string, checks: Record<string, unknown> | undefined): string {
  if (status === "CONNECTED") return "Authenticated with WhatsNexus; tenant mapping, WhatsApp account and callbacks are ready.";
  const bad = Object.entries(checks ?? {}).filter(([, v]) => typeof v === "string" && !["ok", "active", "eligible", "configured"].includes(v)).map(([k, v]) => `${k}: ${v}`);
  return `WhatsNexus reports ${status}${bad.length ? ` — ${bad.join(", ")}` : ""}.`;
}

export const whatsNexusAdapter = createWhatsNexusAdapter();
