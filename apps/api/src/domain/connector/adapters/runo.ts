import { createHash, timingSafeEqual } from "node:crypto";
import type { InboundCallEvent, TelephonyProviderAdapter } from "../types.js";

// Ported pattern from the Lead Panel backend's PixelEye/Runo webhook
// middleware and pixelEyeCallLog.service.js (read fully, reference-only):
// a shared x-api-key header compared with a timing-safe hash comparison
// (never a raw string ===), and call_id as the idempotency key scoped per
// client/connector. Runo is inbound-event-ingestion only in this checkpoint
// — no outbound/click-to-call methods are implemented since no supported
// outbound API is configured.
const API_KEY_HEADER = "x-api-key";

function timingSafeCompare(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

const STATUS_MAP: Record<string, InboundCallEvent["status"]> = {
  completed: "completed",
  answered: "completed",
  missed: "missed",
  no_answer: "no_answer",
  busy: "busy",
  failed: "failed",
};

interface RunoWebhookPayload {
  call_id?: string;
  phone_number?: string;
  customer_name?: string | null;
  agent_name?: string | null;
  direction?: string;
  status?: string;
  duration_seconds?: number | null;
  recording_url?: string | null;
  transcript?: string | null;
  /** Demo/test only: the script a FIXTURE connector's stand-in transcriber returns. Ignored unless the connector is in FIXTURE mode. */
  fixture_transcript?: string | null;
  disposition?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

export const runoTelephonyAdapter: TelephonyProviderAdapter = {
  capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"],

  verifyWebhook(_payload, headers, secrets) {
    const provided = headers[API_KEY_HEADER];
    const expected = secrets.webhookSharedSecret;
    if (typeof expected !== "string" || !expected) return false;
    return timingSafeCompare(provided, expected);
  },

  parseWebhookPayload(payload): InboundCallEvent[] {
    const data = payload as RunoWebhookPayload;
    if (!data.call_id || !data.phone_number) return [];

    const direction = data.direction === "outbound" ? "outbound" : "inbound";
    const status = STATUS_MAP[String(data.status ?? "").toLowerCase()] ?? "completed";

    return [
      {
        externalEventId: data.call_id,
        externalCallId: data.call_id,
        phone: data.phone_number,
        direction,
        status,
        durationSeconds: data.duration_seconds ?? null,
        recordingUrl: data.recording_url ?? null,
        transcript: typeof data.transcript === "string" ? data.transcript : null,
        disposition: data.disposition ?? null,
        agentName: data.agent_name ?? null,
        startedAt: data.started_at ? new Date(data.started_at) : null,
        endedAt: data.ended_at ? new Date(data.ended_at) : null,
        metadata: { customerName: data.customer_name ?? null, ...(typeof data.fixture_transcript === "string" ? { fixtureTranscript: data.fixture_transcript } : {}) },
      },
    ];
  },
};
