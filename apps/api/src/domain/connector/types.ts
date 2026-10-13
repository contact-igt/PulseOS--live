import type { ConnectorCapability, MessageAttachmentKind } from "@pulseos/types";

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
  attachments?: Array<{
    kind: MessageAttachmentKind;
    providerMediaId: string;
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
  }>;
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
  sendMedia?(config: Record<string, unknown>, secrets: Record<string, unknown>, to: string, media: { kind: MessageAttachmentKind; fileName: string; mimeType: string; base64: string; caption: string; idempotencyKey: string }): Promise<{ providerMessageId: string }>;
  /** Send a provider-approved template (the only kind of message allowed outside the 24-hour window). */
  sendTemplate(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    to: string,
    template: {
      name: string;
      language: string;
      parameters: string[];
      /** Stable id of this send (the PulseOS notification id). Providers that support idempotency use it as the key. */
      idempotencyKey?: string;
    },
  ): Promise<{ providerMessageId: string }>;
  /**
   * Read-only status lookup for a previous send by its idempotency key. Used to reconcile an ambiguous outcome WITHOUT
   * sending again. Providers without such a contract omit it.
   */
  lookupSend?(config: Record<string, unknown>, secrets: Record<string, unknown>, externalId: string): Promise<SendLookupResult>;
}

export type SendLookupResult =
  | { state: "accepted"; providerMessageId: string }
  | { state: "in_progress" }
  | { state: "unknown_outcome" }
  | { state: "failed"; code: string; message: string; retryable: boolean }
  | { state: "not_found" };

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

/** The provider definitely did NOT accept the message and a retry cannot succeed (bad credentials, template not approved, no balance …). */
export class PermanentSendError extends Error {
  readonly permanent = true;
  constructor(message: string, readonly code: string = "PERMANENT") {
    super(message);
  }
}

/** The provider definitely did NOT accept the message and trying again later (same idempotency key) is safe. */
export class RetryableSendError extends Error {
  readonly retryable = true;
  constructor(message: string, readonly code: string = "RETRYABLE") {
    super(message);
  }
}
