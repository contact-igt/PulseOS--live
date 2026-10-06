import { createHash, timingSafeEqual } from "node:crypto";
import type { InboundCallEvent, TelephonyProviderAdapter } from "../types.js";
import { normalizeCcsCall } from "./ccs-normalizer.js";

function timingSafeCompare(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export const ccsTelephonyAdapter: TelephonyProviderAdapter = {
  capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"],

  // Fails CLOSED. CCS Express IVR is not known to sign its call reports, so the only proof of origin is a key that PulseOs
  // issued/stored: apiKey, secretKey or integrationKey, presented in a header or in the payload/query (an operator can add
  // ?api_key=... to the webhook URL they paste into CCS). At least one stored key must be presented and match; a presented key
  // that does not match is a refusal even if another one does; nothing stored, or nothing presented, is a refusal.
  verifyWebhook(payload: unknown, headers: Record<string, string | undefined>, secrets: Record<string, unknown>): boolean {
    const stored = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
    const presented = (v: unknown) => (typeof v === "string" && v ? v : undefined);

    const checks: { expected: string | null; provided: string | undefined }[] = [
      // A bare "key" is NOT an alias: CCS's call report has an IVR "KEY" column (the digit pressed), which must stay data.
      { expected: stored(secrets.apiKey), provided: presented(headers["x-api-key"] || headers["api-key"] || headers["apikey"] || p.apiKey || p.api_key) },
      { expected: stored(secrets.secretKey), provided: presented(headers["secret-key"] || headers["x-secret-key"] || headers["secretkey"] || p.secretKey || p.secret_key || p.secret) },
      { expected: stored(secrets.integrationKey), provided: presented(headers["integration-key"] || headers["x-integration-key"] || p.integrationKey || p.integration_key) },
      // The dedicated token PulseOS generated for this connector. The webhook route feeds the URL-path token in as this header.
      { expected: stored(secrets.webhookToken), provided: presented(headers["x-webhook-token"] || p.webhookToken || p.webhook_token) },
    ];
    const configured = checks.filter((c) => c.expected !== null);
    if (configured.length === 0) return false;
    let matched = false;
    for (const c of configured) {
      if (c.provided === undefined) continue;
      if (!timingSafeCompare(c.provided, c.expected!)) return false;
      matched = true;
    }
    return matched;
  },

  // CCS's raw report -> canonical call (ccs-normalizer.ts) -> the provider-neutral event the rest of PulseOS consumes.
  parseWebhookPayload(payload: unknown): InboundCallEvent[] {
    if (!payload || typeof payload !== "object") return [];
    const rawList = Array.isArray(payload) ? payload : [payload];
    const now = new Date();
    const results: InboundCallEvent[] = [];
    for (const item of rawList) {
      const c = normalizeCcsCall(item, { now });
      if (!c) continue;
      const startedAt = c.startedAt ?? now;
      results.push({
        externalEventId: c.providerEventId,
        externalCallId: c.providerCallId,
        phone: c.callerPhone,
        direction: c.direction,
        status: c.outcome === "answered" ? "completed" : c.outcome,
        durationSeconds: c.durationSeconds,
        recordingUrl: c.recordingRef,
        disposition: c.providerDisposition,
        agentName: c.agent,
        startedAt,
        endedAt: c.endedAt ?? (c.durationSeconds != null ? new Date(startedAt.getTime() + c.durationSeconds * 1000) : null),
        answeredAt: c.answeredAt,
        calledLine: c.calledLine,
        providerLabel: "CCS Express IVR",
        // Canonical, credential-free. Telecom circle stays here as provider metadata: it is NOT the patient's location.
        metadata: {
          provider: "ccs_ivr",
          providerCallId: c.providerCallId,
          idDerived: c.idDerived,
          customerName: c.customerName,
          calledLine: c.calledLine,
          answeredAt: c.answeredAt?.toISOString() ?? null,
          callGroup: c.callGroup,
          circle: c.circle,
          ivrSelection: c.ivrSelection,
          providerDisposition: c.providerDisposition,
          unmapped: c.unmapped,
        },
      });
    }
    return results;
  },
};
