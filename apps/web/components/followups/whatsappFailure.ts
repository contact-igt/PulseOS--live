const FIX_IN_SETTINGS = "Ask your Admin to choose another template in Integrations → WhatsNexus WhatsApp → Reminders.";

const BY_CODE: Record<string, string> = {
  TEMPLATE_NOT_APPROVED: `WhatsNexus no longer has this message template approved (it may be paused or rejected). ${FIX_IN_SETTINGS}`,
  TEMPLATE_NOT_FOUND: `This message template no longer exists in WhatsNexus. ${FIX_IN_SETTINGS}`,
  TEMPLATE_LANGUAGE_MISMATCH: `The template's language in WhatsNexus no longer matches this message. ${FIX_IN_SETTINGS}`,
  TEMPLATE_PARAMETER_COUNT_MISMATCH: `The template in WhatsNexus now has a different number of placeholders than this message. ${FIX_IN_SETTINGS}`,
  INSUFFICIENT_BALANCE: "The WhatsNexus wallet balance is too low to send this message.",
  BILLING_BLOCKED: "WhatsNexus billing is blocking new messages right now.",
  USAGE_LIMIT_EXCEEDED: "The WhatsNexus usage limit has been reached.",
  INVALID_CREDENTIALS: "WhatsNexus rejected PulseOS's credentials. Ask your Super Admin to check the WhatsNexus connection.",
  OUTCOME_UNKNOWN: "The message may have been sent, but WhatsNexus has not confirmed it yet. Do not send it again; check the Journey timeline shortly.",
};

const GENERIC = "The message could not be sent.";
const MAX_DETAIL = 200;

/**
 * Staff see why a WhatsApp message failed, not just that it did. `reason` is what was stored on the notification
 * ("CODE: what WhatsNexus said"): the code picks plain words, and WhatsNexus's own text is kept as the detail.
 */
export function describeWhatsAppFailure(reason: string | null | undefined): { summary: string; detail: string | null } {
  const text = (reason ?? "").trim();
  if (!text) return { summary: GENERIC, detail: null };
  const m = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(text);
  const code = m?.[1];
  const known = code ? BY_CODE[code] : undefined;
  const detail = (m && known ? m[2]! : text).trim().slice(0, MAX_DETAIL);
  return { summary: known ?? GENERIC, detail: detail || null };
}
