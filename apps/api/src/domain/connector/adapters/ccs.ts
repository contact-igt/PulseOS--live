import { createHash, timingSafeEqual } from "node:crypto";
import type { InboundCallEvent, TelephonyProviderAdapter } from "../types.js";

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
      { expected: stored(secrets.apiKey), provided: presented(headers["x-api-key"] || headers["api-key"] || headers["apikey"] || p.apiKey || p.api_key || p.key) },
      { expected: stored(secrets.secretKey), provided: presented(headers["secret-key"] || headers["x-secret-key"] || headers["secretkey"] || p.secretKey || p.secret_key || p.secret) },
      { expected: stored(secrets.integrationKey), provided: presented(headers["integration-key"] || headers["x-integration-key"] || p.integrationKey || p.integration_key) },
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

  parseWebhookPayload(payload: unknown): InboundCallEvent[] {
    if (!payload || typeof payload !== "object") return [];

    const rawList = Array.isArray(payload) ? payload : [payload];
    const results: InboundCallEvent[] = [];

    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const data = item as Record<string, any>;

      // Extract phone / caller number from any standard field
      const rawPhone = String(
        data.caller_number ||
        data.caller_no ||
        data.caller ||
        data.caller_id ||
        data.callerid ||
        data.customer_number ||
        data.customer_no ||
        data.customer_phone ||
        data.phone_number ||
        data.phone ||
        data.phonenumber ||
        data.mobile ||
        data.from ||
        data.cli ||
        data.CallingNumber ||
        data.calling_number ||
        ""
      ).trim();

      if (!rawPhone) continue;

      // Extract call identifier
      const externalCallId = String(
        data.call_id ||
        data.callid ||
        data.uniqueid ||
        data.uuid ||
        data.id ||
        data.session_id ||
        data.call_uuid ||
        data.sid ||
        `ccs-${rawPhone}-${Date.now()}`
      );

      // Extract agent / staff / operator
      const agentName = String(
        data.agent_name ||
        data.agent_number ||
        data.agent ||
        data.member_name ||
        data.member ||
        data.member_number ||
        data.executive ||
        data.operator ||
        data.user ||
        data.to ||
        data.CalledNumber ||
        data.extension ||
        ""
      ).trim() || null;

      // Determine call direction
      const dirStr = String(data.direction || data.call_type || data.type || "inbound").toLowerCase();
      const direction: "inbound" | "outbound" = dirStr.includes("out") ? "outbound" : "inbound";

      // Normalize status
      const statusRaw = String(data.status || data.call_status || data.dialstatus || data.call_state || data.disposition || "").toLowerCase();
      let status: "completed" | "missed" | "no_answer" | "busy" | "failed" = "completed";

      if (
        statusRaw.includes("miss") ||
        statusRaw.includes("abandon") ||
        statusRaw.includes("unanswer") ||
        statusRaw.includes("not pick") ||
        statusRaw.includes("not_pick") ||
        statusRaw.includes("un-answered")
      ) {
        status = "missed";
      } else if (statusRaw.includes("busy")) {
        status = "busy";
      } else if (statusRaw.includes("no answer") || statusRaw.includes("no_answer")) {
        status = "no_answer";
      } else if (statusRaw.includes("fail")) {
        status = "failed";
      } else if (
        statusRaw.includes("answer") ||
        statusRaw.includes("complete") ||
        statusRaw.includes("connect") ||
        statusRaw.includes("pick") ||
        statusRaw === "1" ||
        statusRaw === "success"
      ) {
        status = "completed";
      } else {
        // Fallback: if duration > 0, it was answered/completed; otherwise missed
        const dur = Number(data.duration || data.call_duration || data.talk_duration || data.duration_seconds || data.billsec || 0);
        status = dur > 0 ? "completed" : "missed";
      }

      // Duration in seconds
      const durationSeconds = Number(data.duration || data.call_duration || data.talk_duration || data.duration_seconds || data.billsec || 0) || null;

      // Audio recording URL
      const recordingUrl = (data.recording_url || data.recording || data.record_url || data.audio_url || data.file_url || data.call_recording || data.record_file || data.voice_record || null) as string | null;

      // Timestamps
      const rawStarted = data.start_time || data.call_time || data.datetime || data.created_at || data.start_date || data.time;
      const startedAt = rawStarted ? new Date(rawStarted) : new Date();

      const rawEnded = data.end_time || data.end_date;
      const endedAt = rawEnded ? new Date(rawEnded) : null;

      // Disposition / call notes
      const disposition = (data.disposition || data.call_status || data.reason || statusRaw || null) as string | null;

      results.push({
        externalEventId: `ccs:event:${externalCallId}`,
        externalCallId,
        phone: rawPhone,
        direction,
        status,
        durationSeconds,
        recordingUrl,
        disposition,
        agentName,
        startedAt: isNaN(startedAt.getTime()) ? new Date() : startedAt,
        endedAt: endedAt && !isNaN(endedAt.getTime()) ? endedAt : null,
        metadata: {
          ...data,
          provider: "ccs_ivr",
          customerName: data.customer_name || data.name || data.caller_name || null,
        },
      });
    }

    return results;
  },
};
