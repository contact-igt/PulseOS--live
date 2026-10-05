import { describe, expect, it } from "vitest";
import { FixtureSummarizer } from "../domain/conversation/summary/fixture-summarizer.js";
import { clampIdleMinutes, dueAfter, sessionTitle } from "../domain/conversation/summary/session-time.js";
import type { SummarizerMessage } from "../domain/conversation/summary/summarizer.js";

const at = (hhmm: string) => new Date(`2026-10-02T${hhmm}:00+05:30`);
const thread: SummarizerMessage[] = [
  { sender: "patient", body: "Hello, I want to know about cataract surgery. Is Saturday available?", at: at("15:42") },
  { sender: "staff", body: "Hi! Yes, Dr. Menon sees patients on Saturday. We will call you to confirm a time.", at: at("15:44") },
  { sender: "patient", body: "What is the cost for the right eye?", at: at("15:50") },
  { sender: "staff", body: "I will send the price list shortly.", at: at("16:11") },
];

describe("FixtureSummarizer (a deterministic stand-in, labelled FIXTURE — never presented as AI)", () => {
  const s = new FixtureSummarizer();

  it("identifies itself as a fixture", () => {
    expect(s.mode).toBe("FIXTURE");
    expect(s.provider).toBe("fixture");
  });

  it("is deterministic and only reports what was actually said", async () => {
    const a = await s.summarize(thread);
    expect(await s.summarize(thread)).toEqual(a);
    expect(a.patientIntent).toBe("Hello, I want to know about cataract surgery. Is Saturday available?");
    expect(a.questions).toEqual(["Is Saturday available?", "What is the cost for the right eye?"]);
    expect(a.summary).toContain("4 messages");
    // Every sentence it produces is traceable to the thread: it quotes, it does not conclude.
    const said = thread.map((m) => m.body).join(" ");
    for (const q of a.questions) expect(said).toContain(q);
    expect(a.promisedAction).toBe("I will send the price list shortly.");
  });

  it("never states a diagnosis, clinical advice or eligibility", async () => {
    const out = JSON.stringify(await s.summarize(thread)).toLowerCase();
    for (const banned of ["diagnos", "you should take", "eligible", "prescri", "suffer"]) expect(out).not.toContain(banned);
  });

  it("copes with one-sided threads and empty input", async () => {
    const only = await s.summarize([{ sender: "patient", body: "Hi", at: at("10:00") }]);
    expect(only.summary).toContain("1 message");
    expect(only.promisedAction).toBeNull();
    expect(only.questions).toEqual([]);
    await expect(s.summarize([])).rejects.toThrow(/no messages/i);
  });
});

describe("idle window arithmetic", () => {
  it("clamps to the safe 5-10 minute range and defaults to 7", () => {
    expect([clampIdleMinutes(2), clampIdleMinutes(5), clampIdleMinutes(7), clampIdleMinutes(10), clampIdleMinutes(30)]).toEqual([5, 5, 7, 10, 10]);
    expect(clampIdleMinutes(undefined)).toBe(7);
    expect(clampIdleMinutes(Number.NaN)).toBe(7);
  });
  it("due time is the last message plus the window", () => {
    expect(dueAfter(new Date("2026-10-02T10:00:00Z"), 7).toISOString()).toBe("2026-10-02T10:07:00.000Z");
  });
});

describe("sessionTitle (the one concise Timeline line per conversation session)", () => {
  it("shows the message count and the time range in the hospital timezone", () => {
    expect(sessionTitle(12, new Date("2026-10-02T10:12:00Z"), new Date("2026-10-02T10:41:00Z"), "Asia/Kolkata")).toBe("WhatsApp conversation · 12 messages · 3:42 pm – 4:11 pm");
    expect(sessionTitle(1, new Date("2026-10-02T10:12:00Z"), new Date("2026-10-02T10:12:00Z"), "Asia/Kolkata")).toBe("WhatsApp conversation · 1 message · 3:42 pm");
  });
});
