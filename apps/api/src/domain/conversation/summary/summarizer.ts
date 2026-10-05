import type { SummaryMode } from "@pulseos/types";

// The summarizer port. Conversation code only ever talks to this interface; which implementation runs
// (deterministic fixture, a hosted language model) is chosen once in getSummarizer().

export interface SummarizerMessage {
  sender: "patient" | "staff" | "ai" | "system";
  body: string;
  at: Date;
}

export interface SummaryDraft {
  summary: string;
  patientIntent: string | null;
  serviceInterest: string | null;
  questions: string[];
  outcome: string | null;
  promisedAction: string | null;
  nextAction: string | null;
}

export interface ConversationSummarizer {
  /** Short name stored with each summary ("fixture", "anthropic"). */
  provider: string;
  /** AI only for a real language model. A deterministic stand-in is FIXTURE and is never shown as AI. */
  mode: SummaryMode;
  /** `medium` tells a language model what it is reading (a WhatsApp thread by default, or a transcribed phone call). */
  summarize(messages: SummarizerMessage[], opts?: { medium?: "whatsapp" | "call" }): Promise<SummaryDraft>;
}

/**
 * The rules every summarizer must follow. A summary reports what the participants actually said — it is
 * derived data for staff, not medical documentation. Used verbatim as the language-model instruction.
 */
export const SUMMARY_SAFETY_RULES = [
  "Summarize only what the participants actually said in these messages.",
  "Do NOT diagnose, name a condition the patient did not name, give clinical or medical advice, judge treatment eligibility, or draw any medical conclusion.",
  "Do not invent facts, dates, prices or promises. If something is not stated, leave that field empty (null).",
  "Quote or closely paraphrase; keep each field short and factual.",
  "Write in the language of the conversation where possible, otherwise English.",
].join("\n");

export const MAX_FIELD = 400;
export const MAX_QUESTIONS = 6;
