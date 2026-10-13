import type { MessageAttachmentKind } from "@pulseos/types";
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
  kind: "status";
  eventId: string;
  dispatchId: string | null;
  externalId: string;
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: Date;
  pulseosTenantId: string | null;
}

/** A message WhatsNexus itself sent to the patient (its AI assistant or one of its agents), mirrored so the Inbox is the whole conversation. */
export interface WhatsNexusOutboundEvent {
  kind: "outbound";
  eventId: string;
  wamid: string;
  externalThreadId: string;
  sender: "ai" | "agent";
  senderName: string | null;
  body: string;
  status: "sent" | "delivered" | "read" | "failed";
  /** "template" for a template message, otherwise "text" (media travels as attachments). */
  messageType: "text" | "template";
  templateName: string | null;
  occurredAt: Date;
  attachments: WhatsNexusInboundEvent["attachments"];
}

/** The signed test WhatsNexus sends from its setup screen: proves the address, the secret and the reachability. Carries no patient data and changes nothing. */
export interface WhatsNexusPingEvent {
  kind: "ping";
  eventId: string;
}

export interface WhatsNexusInboundEvent {
  kind: "inbound";
  eventId: string;
  externalEventId: string;
  externalThreadId: string;
  fromPhone: string;
  fromName: string | null;
  body: string;
  occurredAt: Date;
  phoneNumberId: string | null;
  attachments: Array<{ kind: MessageAttachmentKind; providerMediaId: string; fileName: string | null; mimeType: string | null; sizeBytes: number | null }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict parse of an already-authenticated payload. Anything unexpected is refused, never guessed at. */
export function parseWhatsNexusCallback(body: unknown): { ok: true; event: WhatsNexusCallbackEvent | WhatsNexusInboundEvent | WhatsNexusOutboundEvent | WhatsNexusPingEvent } | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "not_an_object" };
  const b = body as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  const optionalStr = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
  const eventId = str(b.eventId, 191);
  if (b.type === "ping") {
    if (!eventId) return { ok: false, reason: "invalid_event_id" };
    return { ok: true, event: { kind: "ping", eventId } };
  }
  if (b.type === "outbound_message") {
    const wamid = str(b.wamid, 255);
    const externalThreadId = str(b.externalThreadId, 255);
    const messageBody = optionalStr(b.body, 4096);
    const at = typeof b.occurredAt === "string" ? new Date(b.occurredAt) : null;
    if (!eventId) return { ok: false, reason: "invalid_event_id" };
    const sender = b.sender === "ai" || b.sender === "agent" ? b.sender : null;
    if (!wamid || !externalThreadId || !sender || messageBody === null || !at || Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_outbound_message" };
    const rawAttachments = b.attachments === undefined ? [] : b.attachments;
    if (!Array.isArray(rawAttachments) || rawAttachments.length > 4) return { ok: false, reason: "invalid_attachments" };
    const attachments: WhatsNexusOutboundEvent["attachments"] = [];
    for (const attachment of rawAttachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return { ok: false, reason: "invalid_attachment" };
      const a = attachment as Record<string, unknown>;
      const kind = a.kind === "image" || a.kind === "video" || a.kind === "document" || a.kind === "audio" ? a.kind : null;
      const providerMediaId = str(a.providerMediaId, 255);
      if (!kind || !providerMediaId) return { ok: false, reason: "invalid_attachment" };
      const sizeBytes = typeof a.sizeBytes === "number" && Number.isInteger(a.sizeBytes) && a.sizeBytes >= 0 && a.sizeBytes <= 25 * 1024 * 1024 ? a.sizeBytes : null;
      attachments.push({ kind, providerMediaId, fileName: optionalStr(a.fileName, 255), mimeType: optionalStr(a.mimeType, 127), sizeBytes });
    }
    // A status this version does not know is read as "sent": a new provider status must never lose the message itself.
    const status = b.status === "delivered" || b.status === "read" || b.status === "failed" ? b.status : "sent";
    const messageType = b.messageType === "template" ? "template" : "text";
    const templateName = messageType === "template" ? optionalStr(b.templateName, 255) || null : null;
    return { ok: true, event: { kind: "outbound", eventId, wamid, externalThreadId, sender, senderName: optionalStr(b.senderName, 255) || null, body: messageBody, status, messageType, templateName, occurredAt: at, attachments } };
  }
  if (b.type === "inbound_message") {
    const externalThreadId = str(b.externalThreadId, 255);
    const fromPhone = str(b.fromPhone, 32);
    const messageBody = optionalStr(b.body, 4096);
    const at = typeof b.occurredAt === "string" ? new Date(b.occurredAt) : null;
    if (!eventId) return { ok: false, reason: "invalid_event_id" };
    if (!externalThreadId || !fromPhone || messageBody === null || !at || Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_inbound_message" };
    const rawAttachments = b.attachments === undefined ? [] : b.attachments;
    if (!Array.isArray(rawAttachments) || rawAttachments.length > 4) return { ok: false, reason: "invalid_attachments" };
    const attachments: WhatsNexusInboundEvent["attachments"] = [];
    for (const attachment of rawAttachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return { ok: false, reason: "invalid_attachment" };
      const a = attachment as Record<string, unknown>;
      const kind = a.kind === "image" || a.kind === "video" || a.kind === "document" || a.kind === "audio" ? a.kind : null;
      const providerMediaId = str(a.providerMediaId, 255);
      // WhatsNexus does not know the size of media it has not downloaded yet and sends null: that is "unknown", not invalid.
      const sizeBytes = typeof a.sizeBytes === "number" && Number.isInteger(a.sizeBytes) && a.sizeBytes >= 0 && a.sizeBytes <= 25 * 1024 * 1024 ? a.sizeBytes : null;
      if (!kind || !providerMediaId || (a.sizeBytes !== undefined && a.sizeBytes !== null && sizeBytes === null)) return { ok: false, reason: "invalid_attachment" };
      attachments.push({ kind, providerMediaId, fileName: optionalStr(a.fileName, 255), mimeType: optionalStr(a.mimeType, 127), sizeBytes });
    }
    return { ok: true, event: { kind: "inbound", eventId, externalEventId: eventId, externalThreadId, fromPhone, fromName: optionalStr(b.fromName, 255), body: messageBody, occurredAt: at, phoneNumberId: optionalStr(b.phoneNumberId, 128), attachments } };
  }
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
      kind: "status",
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
