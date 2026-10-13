import type { MessageRow } from "@pulseos/types";

export type MessageTone = "patient" | "ai" | "staff" | "system";
export type DeliveryTone = "pending" | "ok" | "read" | "failed";

export interface MessageView {
  side: "left" | "center" | "right";
  /** Who wrote it, in words. */
  label: string;
  tone: MessageTone;
  /** Where a sent message has got to; null when it never went to a provider (or the patient wrote it). */
  status: { text: string; tone: DeliveryTone } | null;
  canRetry: boolean;
}

const STATUS: Record<NonNullable<MessageRow["deliveryStatus"]>, { text: string; tone: DeliveryTone }> = {
  queued: { text: "Sending…", tone: "pending" },
  sent: { text: "Sent", tone: "ok" },
  delivered: { text: "Delivered", tone: "ok" },
  read: { text: "Read", tone: "read" },
  failed: { text: "Not delivered", tone: "failed" },
};

/** How one message is shown in the thread: side, author, delivery state and whether it can be sent again. */
export function describeMessage(m: MessageRow): MessageView {
  if (m.senderType === "system") return { side: "center", label: "", tone: "system", status: null, canRetry: false };
  if (m.senderType === "patient") return { side: "left", label: "Patient", tone: "patient", status: null, canRetry: false };
  const status = m.deliveryStatus ? STATUS[m.deliveryStatus] : null;
  if (m.senderType === "ai") return { side: "right", label: "AI Assistant", tone: "ai", status, canRetry: false };
  return { side: "right", label: m.senderName ?? "Team member", tone: "staff", status, canRetry: m.deliveryStatus === "failed" && m.attachments.length === 0 };
}

const MAX_DETAIL = 200;

/** Why a file did not go: the server's own plain words where it gave them, else the provider's refusal or a general line. */
export function describeMediaProblem(e: { message: string; detail: string | null }): { summary: string; detail: string | null } {
  if (e.message === "template_required") return describeSendProblem("template_required");
  if (["file_too_large", "unsupported_type", "empty_file"].includes(e.message) && e.detail) return { summary: e.detail, detail: null };
  if (e.message === "send_failed") return { summary: "WhatsApp did not accept this file.", detail: e.detail ? e.detail.slice(0, MAX_DETAIL) : null };
  if (e.message === "media_not_supported") return { summary: "This conversation cannot send files: its WhatsApp connection is not set up for it.", detail: null };
  return { summary: "The file could not be sent. Check your connection and try again.", detail: null };
}

const BY_CODE: Record<string, string> = {
  INSUFFICIENT_BALANCE: "The WhatsNexus wallet balance is too low to send this message.",
  BILLING_BLOCKED: "WhatsNexus billing is blocking new messages right now.",
  USAGE_LIMIT_EXCEEDED: "The WhatsNexus usage limit has been reached.",
  INVALID_CREDENTIALS: "WhatsNexus rejected PulseOS's credentials. Ask your Super Admin to check the WhatsNexus connection.",
  unreachable: "PulseOS could not reach WhatsNexus. Try again in a moment.",
  OUTCOME_UNKNOWN: "The message may have been sent, but WhatsNexus has not confirmed it. Check before sending it again.",
};

/** Why a send did not go through, for the person who pressed Send. The provider's own words stay as the detail. */
export function describeSendProblem(reason: string | null | undefined): { summary: string; detail: string | null } {
  const text = (reason ?? "").trim();
  if (text === "template_required") return { summary: "The patient's 24 hours to receive a free-form reply have passed. WhatsApp now allows only an approved template message.", detail: null };
  if (!text) return { summary: "The message could not be delivered.", detail: null };
  const m = /^([A-Za-z][A-Za-z0-9_]+):\s*(.*)$/s.exec(text);
  const known = m?.[1] ? BY_CODE[m[1]] : undefined;
  if (known) return { summary: known, detail: (m![2] ?? "").trim().slice(0, MAX_DETAIL) || null };
  return { summary: "The message could not be delivered.", detail: text.slice(0, MAX_DETAIL) };
}
