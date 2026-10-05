import type { ConversationSummarizer, SummarizerMessage, SummaryDraft } from "./summarizer.js";
import { MAX_FIELD, MAX_QUESTIONS } from "./summarizer.js";

// A deterministic stand-in used when no language model is configured. It quotes the thread — it never
// concludes — and is labelled FIXTURE everywhere it is shown, so it can never be mistaken for AI output.

const trim = (s: string) => (s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD - 1).trimEnd()}…` : s);
const sentences = (text: string) => text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);

export class FixtureSummarizer implements ConversationSummarizer {
  readonly provider = "fixture";
  readonly mode = "FIXTURE" as const;

  async summarize(messages: SummarizerMessage[], _opts?: { medium?: "whatsapp" | "call" }): Promise<SummaryDraft> {
    if (messages.length === 0) throw new Error("No messages to summarize");
    const patient = messages.filter((m) => m.sender === "patient");
    const staff = messages.filter((m) => m.sender === "staff" || m.sender === "ai");
    const questions = patient.flatMap((m) => sentences(m.body)).filter((s) => s.endsWith("?")).slice(0, MAX_QUESTIONS).map(trim);
    const promise = [...staff].reverse().find((m) => /\b(will|shall|going to)\b/i.test(m.body));
    const lastStaff = staff.at(-1);
    const n = messages.length;
    return {
      summary: trim(`${n} message${n === 1 ? "" : "s"}: the patient wrote ${patient.length}, the hospital replied ${staff.length} time${staff.length === 1 ? "" : "s"}. The patient began with “${patient[0]?.body ?? messages[0]!.body}”.`),
      patientIntent: patient[0] ? trim(patient[0].body) : null,
      serviceInterest: null,
      questions,
      outcome: lastStaff ? trim(lastStaff.body) : null,
      promisedAction: promise ? trim(promise.body) : null,
      nextAction: null,
    };
  }
}
