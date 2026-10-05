import { z } from "zod";
import { MAX_FIELD, MAX_QUESTIONS, SUMMARY_SAFETY_RULES, type ConversationSummarizer, type SummarizerMessage, type SummaryDraft } from "./summarizer.js";

// A hosted language model behind the summarizer port. Only used when explicitly configured
// (PULSEOS_LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY); otherwise the labelled FIXTURE summarizer runs.
// Data minimisation: only the message texts, labelled "Patient:" / "Hospital:", are sent — no names, phone
// numbers, ids or tenant information beyond what the people wrote themselves.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const field = z.string().nullable().optional().transform((v) => (v && v.trim() ? v.trim() : null));
const schema = z.object({
  summary: z.string().min(1),
  patientIntent: field,
  serviceInterest: field,
  questions: z.array(z.string()).optional().default([]),
  outcome: field,
  promisedAction: field,
  nextAction: field,
});

const clip = (s: string) => (s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD - 1).trimEnd()}…` : s);
const clipOrNull = (s: string | null) => (s ? clip(s) : null);

const SYSTEM = `You summarize one __MEDIUM__ between a patient and a hospital's staff, for the hospital's front-office team.
${SUMMARY_SAFETY_RULES}
Reply with ONLY JSON, no prose, with exactly these keys:
{"summary": string, "patientIntent": string|null, "serviceInterest": string|null, "questions": string[], "outcome": string|null, "promisedAction": string|null, "nextAction": string|null}
- summary: 1-2 factual sentences. patientIntent: what the patient asked for. serviceInterest: the service they named, if any.
- questions: the patient's actual questions. outcome: where the conversation ended. promisedAction: what the hospital said it would do. nextAction: the single next step for staff, if one follows from what was said.`;

export class AnthropicSummarizer implements ConversationSummarizer {
  readonly provider = "anthropic";
  readonly mode = "AI" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; model?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async summarize(messages: SummarizerMessage[], opts: { medium?: "whatsapp" | "call" } = {}): Promise<SummaryDraft> {
    if (messages.length === 0) throw new Error("No messages to summarize");
    const transcript = messages.map((m) => `${m.sender === "patient" ? "Patient" : "Hospital"}: ${m.body}`).join("\n");

    const res = await this.fetchImpl(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 700, temperature: 0, system: SYSTEM.replace("__MEDIUM__", opts.medium === "call" ? "transcribed phone call" : "WhatsApp conversation session"), messages: [{ role: "user", content: transcript }] }),
    });
    if (!res.ok) throw new Error(`Summarizer request failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Error("Summarizer did not return valid JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`Summarizer returned an unexpected shape (${parsed.error.issues[0]?.path.join(".") || "summary"})`);
    const d = parsed.data;
    return {
      summary: clip(d.summary),
      patientIntent: clipOrNull(d.patientIntent),
      serviceInterest: clipOrNull(d.serviceInterest),
      questions: d.questions.map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUESTIONS).map(clip),
      outcome: clipOrNull(d.outcome),
      promisedAction: clipOrNull(d.promisedAction),
      nextAction: clipOrNull(d.nextAction),
    };
  }
}
