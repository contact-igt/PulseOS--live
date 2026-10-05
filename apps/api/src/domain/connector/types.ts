import type { ConnectorCapability } from "@pulseos/types";

export interface InboundMessageEvent {
  externalEventId: string;
  externalThreadId: string;
  fromPhone: string;
  fromName: string | null;
  body: string;
  occurredAt: Date;
  // Meta's own `metadata.phone_number_id`, present on every real inbound
  // webhook payload (confirmed against Meta's live docs) — which hospital
  // WhatsApp number received this message. Null only for a payload shape
  // that omits it (never expected from a real Meta delivery).
  phoneNumberId: string | null;
}

export interface MessageStatusEvent {
  externalEventId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: Date;
}

export interface ParsedWhatsAppWebhook {
  messages: InboundMessageEvent[];
  statuses: MessageStatusEvent[];
}

// A Messaging adapter never appears by provider name inside domain logic — the
// registry (registry.ts) is the only place that knows "whatsapp_meta_cloud"
// maps to this shape. Patient/Journey/Conversation/Timeline code only ever
// calls through this interface.
export interface MessagingProviderAdapter {
  capabilities: ConnectorCapability[];
  verifyWebhookChallenge(query: Record<string, string>, secrets: Record<string, unknown>): string | null;
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, secrets: Record<string, unknown>): boolean;
  parseWebhookPayload(payload: unknown): ParsedWhatsAppWebhook;
  sendMessage(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    to: string,
    body: string,
  ): Promise<{ providerMessageId: string }>;
  /** Send a provider-approved template (the only kind of message allowed outside the 24-hour window). */
  sendTemplate(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    to: string,
    template: { name: string; language: string; parameters: string[] },
  ): Promise<{ providerMessageId: string }>;
}

export interface InboundCallEvent {
  externalEventId: string;
  externalCallId: string;
  phone: string;
  direction: "inbound" | "outbound";
  status: "completed" | "missed" | "no_answer" | "busy" | "failed";
  durationSeconds: number | null;
  recordingUrl: string | null;
  /** A transcript the provider already produced (plain text). Stored as-is — never re-transcribed. */
  transcript?: string | null;
  disposition: string | null;
  agentName: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface TelephonyProviderAdapter {
  capabilities: ConnectorCapability[];
  verifyWebhook(payload: unknown, headers: Record<string, string | undefined>, secrets: Record<string, unknown>): boolean;
  parseWebhookPayload(payload: unknown): InboundCallEvent[];
}

/** The provider may already have accepted the message (timeout after sending, 2xx with an unreadable body): never retried, or the patient could get it twice. */
export class AmbiguousSendError extends Error {
  readonly ambiguous = true;
}
