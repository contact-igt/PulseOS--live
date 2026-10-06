import { describe, expect, it } from "vitest";
import { normalizeCcsCall, parseCcsDuration, parseCcsTimestamp } from "../ccs-normalizer.js";

// CCS Express IVR -> one canonical call. NOTE: PulseOS has never received a real CCS webhook yet, so the field names the
// normalizer accepts are CANDIDATES (taken from the CCS dashboard's columns and common IVR CDR vocabulary), matched
// case- and separator-insensitively. What it does not recognise is kept, not dropped, so the first real payload can be
// mapped from what was actually sent.

const NOW = new Date("2026-10-06T14:00:00Z");
const n = (raw: Record<string, unknown>) => normalizeCcsCall(raw, { now: NOW });

describe("CCS canonical call", () => {
  it("maps the dashboard-style fields of an answered inbound call", () => {
    const c = n({
      call_id: "ccs-1001", caller_number: "98101 57258", called_number: "07940001234", agent_name: "Shivani", call_group: "Reception",
      start_time: "2026-10-06 19:49:10", answer_time: "2026-10-06 19:49:25", end_time: "2026-10-06 19:50:36", duration: "71",
      status: "Answered", circle: "Delhi", ivr_key: "2", recording_url: "https://ccs.example.test/rec/1001.mp3", customer_name: "Asha Rao",
    })!;
    expect(c).toMatchObject({
      provider: "CCS_EXPRESS_IVR", providerEventId: "ccs:event:ccs-1001", providerCallId: "ccs-1001", direction: "inbound", callerPhone: "98101 57258",
      calledLine: "07940001234", agent: "Shivani", callGroup: "Reception", durationSeconds: 71, outcome: "answered", providerDisposition: "Answered",
      circle: "Delhi", ivrSelection: "2", recordingAvailable: true, customerName: "Asha Rao", idDerived: false,
    });
    // CCS reports India local time without an offset: read as IST (+05:30), not as the server's zone.
    expect(c.startedAt!.toISOString()).toBe("2026-10-06T14:19:10.000Z");
    expect(c.answeredAt!.toISOString()).toBe("2026-10-06T14:19:25.000Z");
    expect(c.endedAt!.toISOString()).toBe("2026-10-06T14:20:36.000Z");
  });

  it("matches field names regardless of case and separators", () => {
    const c = n({ "Call ID": "A7", "Caller Number": "9810157258", "Call Status": "Answered", "Agent Name": "Ravi" })!;
    expect(c).toMatchObject({ providerCallId: "A7", callerPhone: "9810157258", outcome: "answered", agent: "Ravi" });
    expect(n({ callerNumber: "9810157258", callId: "B8" })).toMatchObject({ providerCallId: "B8" });
  });

  describe("outcome", () => {
    const outcome = (status: string, direction: string, duration?: string) => n({ call_id: "x", caller_number: "9810157258", status, direction, ...(duration ? { duration } : {}) })!.outcome;
    it("an inbound call nobody answered is a MISSED call, whichever way CCS words it", () => {
      for (const s of ["No Answer", "NO_ANSWER", "Missed", "Unanswered", "Not Answered", "Abandoned", "Not Picked"]) expect(outcome(s, "inbound"), s).toBe("missed");
    });
    it("an outbound call the patient did not pick up is no_answer, not a missed call for staff", () => {
      expect(outcome("No Answer", "outbound")).toBe("no_answer");
    });
    it("answered, busy and failed", () => {
      expect(outcome("Answered", "inbound")).toBe("answered");
      expect(outcome("Connected", "inbound")).toBe("answered");
      expect(outcome("Busy", "outbound")).toBe("busy");
      expect(outcome("Failed", "outbound")).toBe("failed");
    });
    it("with no status at all, talk time decides", () => {
      expect(n({ call_id: "x", caller_number: "9810157258", duration: "30" })!.outcome).toBe("answered");
      expect(n({ call_id: "x", caller_number: "9810157258", duration: "0" })!.outcome).toBe("missed");
    });
  });

  it("direction: out/outgoing is outbound, anything else (or nothing) is inbound", () => {
    expect(n({ call_id: "x", caller_number: "9810157258", call_type: "Outgoing" })!.direction).toBe("outbound");
    expect(n({ call_id: "x", caller_number: "9810157258", direction: "outbound" })!.direction).toBe("outbound");
    expect(n({ call_id: "x", caller_number: "9810157258", call_type: "Incoming" })!.direction).toBe("inbound");
    expect(n({ call_id: "x", caller_number: "9810157258" })!.direction).toBe("inbound");
  });

  it("durations: seconds, HH:MM:SS, MM:SS, '1m 26s'; nonsense is null", () => {
    expect(parseCcsDuration("86")).toBe(86);
    expect(parseCcsDuration(86)).toBe(86);
    expect(parseCcsDuration("00:01:26")).toBe(86);
    expect(parseCcsDuration("01:26")).toBe(86);
    expect(parseCcsDuration("1m 26s")).toBe(86);
    expect(parseCcsDuration("abc")).toBeNull();
    expect(parseCcsDuration(undefined)).toBeNull();
    expect(parseCcsDuration("-5")).toBeNull();
  });

  it("timestamps: zoneless text is IST; an explicit offset or Z is honoured; DD-MM-YYYY is read the Indian way; garbage is null", () => {
    expect(parseCcsTimestamp("2026-10-06 19:49:10")!.toISOString()).toBe("2026-10-06T14:19:10.000Z");
    expect(parseCcsTimestamp("2026-10-06T19:49:10+05:30")!.toISOString()).toBe("2026-10-06T14:19:10.000Z");
    expect(parseCcsTimestamp("2026-10-06T14:19:10Z")!.toISOString()).toBe("2026-10-06T14:19:10.000Z");
    expect(parseCcsTimestamp("06-10-2026 19:49:10")!.toISOString()).toBe("2026-10-06T14:19:10.000Z");
    expect(parseCcsTimestamp("06/10/2026 07:49 PM")!.toISOString()).toBe("2026-10-06T14:19:00.000Z");
    expect(parseCcsTimestamp(1791296950)!.toISOString()).toBe("2026-10-06T14:29:10.000Z");
    expect(parseCcsTimestamp("not a date")).toBeNull();
    expect(parseCcsTimestamp(undefined)).toBeNull();
  });

  it("circle is provider metadata only: it never becomes a patient location", () => {
    const c = n({ call_id: "x", caller_number: "9810157258", circle: "Karnataka" })!;
    expect(c.circle).toBe("Karnataka");
    expect(Object.keys(c)).not.toContain("city");
    expect(Object.keys(c)).not.toContain("location");
  });

  describe("idempotency identity", () => {
    it("uses the provider's call id", () => {
      expect(n({ call_id: "ccs-9", caller_number: "9810157258" })!.providerEventId).toBe("ccs:event:ccs-9");
    });
    it("with no call id, derives a STABLE id from what identifies the call, so a retry cannot duplicate it", () => {
      const raw = { caller_number: "9810157258", called_number: "0794", start_time: "2026-10-06 19:49:10", duration: "71", agent_name: "Ravi" };
      const a = n(raw)!;
      const b = n({ ...raw })!;
      const other = n({ ...raw, start_time: "2026-10-06 19:55:10" })!;
      expect(a.idDerived).toBe(true);
      expect(a.providerEventId).toBe(b.providerEventId);
      expect(a.providerCallId).toBe(b.providerCallId);
      expect(a.providerEventId).not.toBe(other.providerEventId);
      expect(a.providerEventId).toMatch(/^ccs:derived:[0-9a-f]{16,}$/);
    });
  });

  it("keeps what it does not recognise, and never carries a credential or the recording URL", () => {
    const c = n({ call_id: "x", caller_number: "9810157258", campaign_tag: "diwali-camp", api_key: "synthetic-key", secretKey: "synthetic-secret", recording_url: "https://ccs.example.test/rec.mp3?token=abc" })!;
    expect(c.unmapped).toEqual({ campaign_tag: "diwali-camp" });
    // Only `recordingRef` (destined for the protected recording store) carries the URL; nothing else the normalizer returns does.
    expect(JSON.stringify({ ...c, recordingRef: null })).not.toMatch(/synthetic-|token=abc|rec\.mp3/);
    expect(c.recordingRef).toBe("https://ccs.example.test/rec.mp3?token=abc");
    expect(c.recordingAvailable).toBe(true);
  });

  it("long or nested unrecognised values are capped, not stored whole", () => {
    const c = n({ call_id: "x", caller_number: "9810157258", note: "y".repeat(5000), nested: { a: { b: 1 } } })!;
    expect(String(c.unmapped.note).length).toBeLessThanOrEqual(300);
    expect(typeof c.unmapped.nested).toBe("string");
  });

  it("a payload with no caller number is not a call", () => {
    expect(n({ call_id: "x", note: "ping" })).toBeNull();
    expect(n({})).toBeNull();
    expect(n("nope" as unknown as Record<string, unknown>)).toBeNull();
  });
});
