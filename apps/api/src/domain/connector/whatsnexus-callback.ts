import { verifyWebhookSignature } from "../integration/webhook-rules.js";

// WhatsNexus → PulseOS delivery-status callbacks.
//   x-whatsnexus-timestamp: unix seconds
//   x-whatsnexus-signature: sha256=HMAC_SHA256(callbackSecret, `${timestamp}.${rawBody}`)   (exact raw request bytes)
// Identical to the signature PulseOS itself puts on outbound webhooks, so one primitive (webhook-rules.ts) serves both.
// During secret rotation the connector may hold a previous secret too; either one verifies.

export const CALLBACK_TOLERANCE_SECONDS = 5 * 60;

export type CallbackAuthResult = "ok" | "missing" | "stale" | "invalid_signature";

export function verifyWhatsNexusCallback(
  secrets: Record<string, unknown> | null,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  nowMs: number = Date.now(),
): CallbackAuthResult {
  if (!timestampHeader || !signatureHeader) return "missing";
  const candidates = [secrets?.callbackSecret, secrets?.previousCallbackSecret].filter((s): s is string => typeof s === "string" && s.length >= 16);
  if (candidates.length === 0) return "invalid_signature";
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts) || ts <= 0) return "missing";
  // A replayed capture is rejected here once it ages out; inside the window the event id dedupes it.
  if (Math.abs(nowMs / 1000 - ts) > CALLBACK_TOLERANCE_SECONDS) return "stale";
  return candidates.some((secret) => verifyWebhookSignature(secret, timestampHeader, rawBody, signatureHeader)) ? "ok" : "invalid_signature";
}

export interface WhatsNexusCallbackEvent {
  eventId: string;
  dispatchId: string | null;
  externalId: string;
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: Date;
  pulseosTenantId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict parse of an already-authenticated payload. Anything unexpected is refused, never guessed at. */
export function parseWhatsNexusCallback(body: unknown): { ok: true; event: WhatsNexusCallbackEvent } | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "not_an_object" };
  const b = body as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  const eventId = str(b.eventId, 191);
  const externalId = str(b.externalId, 128);
  const wamid = str(b.wamid, 255);
  const status = b.status;
  if (!eventId) return { ok: false, reason: "invalid_event_id" };
  // externalId is the PulseOS notification id: a journey id or anything else is not accepted.
  if (!externalId || !UUID.test(externalId)) return { ok: false, reason: "invalid_external_id" };
  if (!wamid) return { ok: false, reason: "invalid_wamid" };
  if (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed") return { ok: false, reason: "invalid_status" };
  const at = typeof b.occurredAt === "string" ? new Date(b.occurredAt) : null;
  if (!at || Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_occurred_at" };
  return {
    ok: true,
    event: {
      eventId,
      dispatchId: typeof b.dispatchId === "string" ? b.dispatchId.slice(0, 64) : null,
      externalId,
      wamid,
      status,
      occurredAt: at,
      pulseosTenantId: typeof b.pulseosTenantId === "string" ? b.pulseosTenantId : null,
    },
  };
}
