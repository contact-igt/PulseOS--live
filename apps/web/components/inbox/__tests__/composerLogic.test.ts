import { describe, expect, it } from "vitest";
import { EMOJI_GROUPS, insertAtCursor, pushRecent } from "../emoji";
import { formatDuration, hasSound, meterLevel, pickRecorderMime, recordingFileName, rmsOf, silentRecordingMessage } from "../voiceRecorder";
import { describeMediaProblem } from "../messagePresentation";

describe("insertAtCursor", () => {
  it("puts the emoji where the caret is and moves the caret after it", () => {
    expect(insertAtCursor("Hello world", 5, 5, "😊")).toEqual({ value: "Hello😊 world", caret: 5 + "😊".length });
    expect(insertAtCursor("", 0, 0, "👍")).toEqual({ value: "👍", caret: "👍".length });
  });
  it("replaces a selection", () => {
    expect(insertAtCursor("Hello world", 6, 11, "🌍")).toEqual({ value: "Hello 🌍", caret: 6 + "🌍".length });
  });
  it("a caret past the end or a reversed selection never breaks the text", () => {
    expect(insertAtCursor("Hi", 99, 99, "🙂").value).toBe("Hi🙂");
    expect(insertAtCursor("Hi", 2, 0, "🙂").value).toBe("🙂");
    expect(insertAtCursor("Hi", -3, -3, "🙂").value).toBe("🙂Hi");
  });
  it("counts an emoji that is several characters long as one insertion", () => {
    const family = "👨‍👩‍👧";
    expect(insertAtCursor("a", 1, 1, family)).toEqual({ value: `a${family}`, caret: 1 + family.length });
  });
});

describe("pushRecent", () => {
  it("puts the newest first, without repeats, up to the limit", () => {
    expect(pushRecent(["😀", "👍"], "👍", 5)).toEqual(["👍", "😀"]);
    expect(pushRecent(["😀"], "🙏", 5)).toEqual(["🙏", "😀"]);
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("the emoji set", () => {
  it("has labelled groups of unique emojis, and nothing blank", () => {
    expect(EMOJI_GROUPS.length).toBeGreaterThanOrEqual(6);
    for (const g of EMOJI_GROUPS) {
      expect(g.label).toBeTruthy();
      expect(g.icon).toBeTruthy();
      expect(g.emojis.length).toBeGreaterThanOrEqual(20);
      expect(new Set(g.emojis).size).toBe(g.emojis.length);
      expect(g.emojis.every((e) => e.trim().length > 0)).toBe(true);
    }
  });
});

describe("voice recording", () => {
  it("prefers the format the browser can actually record, in WhatsApp-friendliest order", () => {
    const supports = (...ok: string[]) => (m: string) => ok.includes(m);
    expect(pickRecorderMime(supports("audio/ogg;codecs=opus", "audio/webm;codecs=opus"))).toBe("audio/ogg;codecs=opus");
    expect(pickRecorderMime(supports("audio/webm;codecs=opus", "audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime(supports("audio/mp4"))).toBe("audio/mp4");
    expect(pickRecorderMime(supports())).toBeNull();
  });
  it("names the file by what was recorded", () => {
    expect(recordingFileName("audio/webm;codecs=opus", 1760000000000)).toBe("voice-1760000000000.webm");
    expect(recordingFileName("audio/ogg;codecs=opus", 1)).toBe("voice-1.ogg");
    expect(recordingFileName("audio/mp4", 1)).toBe("voice-1.m4a");
    expect(recordingFileName("", 1)).toBe("voice-1.webm");
  });
  it("shows the length as minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3599)).toBe("59:59");
  });
});

describe("is the microphone actually picking up sound?", () => {
  it("measures loudness as the root-mean-square of the samples", () => {
    expect(rmsOf([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 5);
    expect(rmsOf([0, 0, 0])).toBe(0);
    expect(rmsOf([])).toBe(0);
  });
  it("turns loudness into a 0 to 1 meter on a decibel scale (silence empty, normal speech well up)", () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(0.0001)).toBe(0); // -80 dB: the floor
    expect(meterLevel(0.01)).toBeCloseTo(0.4, 2); // -40 dB
    expect(meterLevel(0.5)).toBe(1);
    expect(meterLevel(1)).toBe(1);
  });
  it("calls a recording silent when its loudest moment never rose above the noise floor", () => {
    expect(hasSound(0)).toBe(false);
    expect(hasSound(0.0005)).toBe(false);
    expect(hasSound(0.02)).toBe(true);
    expect(hasSound(0.3)).toBe(true);
  });
  it("tells the person what to check, naming the microphone the browser used", () => {
    const m = silentRecordingMessage("Microphone Array (Realtek Audio)");
    expect(m).toMatch(/no sound/i);
    expect(m).toContain("Microphone Array (Realtek Audio)");
    expect(silentRecordingMessage(null)).toMatch(/no sound/i);
    expect(silentRecordingMessage("")).not.toContain("()");
  });
});

describe("describeMediaProblem", () => {
  it("uses the server's own plain words when it sent them", () => {
    expect(describeMediaProblem({ message: "file_too_large", detail: "This image is too large. Images can be up to 5 MB." })).toEqual({ summary: "This image is too large. Images can be up to 5 MB.", detail: null });
    expect(describeMediaProblem({ message: "unsupported_type", detail: "This file type cannot be sent as a video." }).summary).toBe("This file type cannot be sent as a video.");
  });
  it("explains a closed window and a provider that refused the file, keeping its reason", () => {
    expect(describeMediaProblem({ message: "template_required", detail: null }).summary).toMatch(/24 hours/);
    const refused = describeMediaProblem({ message: "send_failed", detail: "INVALID_REQUEST: Meta API Error: unsupported media format" });
    expect(refused.summary).toBe("WhatsApp did not accept this file.");
    expect(refused.detail).toBe("INVALID_REQUEST: Meta API Error: unsupported media format");
  });
  it("an upload that never reached the server, or an unknown failure, still says something useful", () => {
    expect(describeMediaProblem({ message: "Failed to fetch", detail: null }).summary).toMatch(/could not be sent/i);
    expect(describeMediaProblem({ message: "media_not_supported", detail: null }).summary).toMatch(/not set up|cannot send/i);
  });
});
