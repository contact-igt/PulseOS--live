import { describe, expect, it, vi } from "vitest";
import { AnthropicSummarizer } from "../domain/conversation/summary/anthropic-summarizer.js";
import { getSummarizer, SUMMARY_SAFETY_RULES } from "../domain/conversation/summary/index.js";
import type { SummarizerMessage } from "../domain/conversation/summary/summarizer.js";

const thread: SummarizerMessage[] = [
  { sender: "patient", body: "Hi, how much is cataract surgery? My name is Asha Rao, phone 9876543210.", at: new Date("2026-10-02T10:12:00Z") },
  { sender: "staff", body: "We will send the price list shortly.", at: new Date("2026-10-02T10:14:00Z") },
];

const okBody = (obj: unknown) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }] }), text: async () => "" });
const draft = { summary: "Patient asked the price of cataract surgery; staff promised a price list.", patientIntent: "Price of cataract surgery", serviceInterest: "Cataract", questions: ["How much is cataract surgery?"], outcome: null, promisedAction: "Send the price list", nextAction: "Send the price list" };

describe("AnthropicSummarizer", () => {
  it("is AI mode, names its provider, and sends the safety rules with only the messages (no names or numbers beyond what was said)", async () => {
    const fetchImpl = vi.fn(async () => okBody(draft));
    const s = new AnthropicSummarizer({ apiKey: "sk-test", model: "claude-haiku-4-5-20251001", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(s.mode).toBe("AI");
    expect(s.provider).toBe("anthropic");
    const out = await s.summarize(thread);
    expect(out).toMatchObject({ summary: draft.summary, questions: draft.questions, serviceInterest: "Cataract" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBeTruthy();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.system).toContain(SUMMARY_SAFETY_RULES);
    expect(body.system).toMatch(/only (a )?json/i);
    // The transcript labels who spoke; it carries no patient id, journey id or tenant id.
    const user = JSON.stringify(body.messages);
    expect(user).toContain("Patient:");
    expect(user).toContain("Hospital:");
    expect(user).not.toMatch(/tenant|patientId|journeyId/i);
  });

  it("accepts a JSON reply wrapped in a code fence, and trims over-long fields", async () => {
    const long = "x".repeat(900);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "```json\n" + JSON.stringify({ ...draft, summary: long, questions: Array.from({ length: 12 }, (_, i) => `Q${i}?`) }) + "\n```" }] }), text: async () => "" }));
    const out = await new AnthropicSummarizer({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }).summarize(thread);
    expect(out.summary.length).toBeLessThanOrEqual(400);
    expect(out.questions.length).toBeLessThanOrEqual(6);
  });

  it("fails loudly (so the job retries and the raw thread stays available) on an HTTP error, bad JSON or a wrong shape", async () => {
    const make = (impl: () => unknown) => new AnthropicSummarizer({ apiKey: "k", fetchImpl: vi.fn(impl) as unknown as typeof fetch });
    await expect(make(async () => ({ ok: false, status: 529, json: async () => ({}), text: async () => "overloaded" })).summarize(thread)).rejects.toThrow(/529/);
    await expect(make(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "not json at all" }] }), text: async () => "" })).summarize(thread)).rejects.toThrow(/json/i);
    await expect(make(async () => okBody({ patientIntent: "missing summary" })).summarize(thread)).rejects.toThrow(/shape|summary/i);
    await expect(make(async () => okBody(draft)).summarize([])).rejects.toThrow(/no messages/i);
  });
});

describe("getSummarizer", () => {
  it("is the labelled FIXTURE unless a language model is explicitly configured", () => {
    expect(getSummarizer({}).mode).toBe("FIXTURE");
    expect(getSummarizer({ PULSEOS_LLM_PROVIDER: "anthropic" }).mode).toBe("FIXTURE"); // no key: never pretends
    expect(getSummarizer({ ANTHROPIC_API_KEY: "sk" }).mode).toBe("FIXTURE"); // key alone is not enabling
    const ai = getSummarizer({ PULSEOS_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk" });
    expect(ai.mode).toBe("AI");
    expect(ai.provider).toBe("anthropic");
  });
});
