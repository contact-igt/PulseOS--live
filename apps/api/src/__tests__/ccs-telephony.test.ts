import { describe, expect, it } from "vitest";
import { ccsTelephonyAdapter } from "../domain/connector/adapters/ccs.js";

describe("ccsTelephonyAdapter", () => {
  // Webhook authentication FAILS CLOSED. Any one saved key, presented by the caller and matching, is enough; nothing
  // saved, nothing presented, or anything presented that does not match is a refusal.
  describe("verifyWebhook (fails closed)", () => {
    const secrets = { apiKey: "synthetic-api-key-0001", secretKey: "synthetic-secret-key-0002", integrationKey: "synthetic-integration-key-0003" };
    const verify = (payload: unknown, headers: Record<string, string>, s: Record<string, unknown> = secrets) => ccsTelephonyAdapter.verifyWebhook(payload, headers, s);

    it("accepts a matching apiKey, secretKey or integrationKey from headers or the payload/query", () => {
      expect(verify({}, { "x-api-key": secrets.apiKey })).toBe(true);
      expect(verify({}, { "secret-key": secrets.secretKey })).toBe(true);
      expect(verify({ integrationKey: secrets.integrationKey }, {})).toBe(true);
      expect(verify({ api_key: secrets.apiKey }, {})).toBe(true);
    });

    it("rejects a wrong key", () => {
      expect(verify({}, { "x-api-key": "wrong-key" })).toBe(false);
      expect(verify({ integrationKey: "wrong" }, {})).toBe(false);
    });

    it("rejects a request that presents no credential at all (this used to be accepted)", () => {
      expect(verify({ caller_number: "9810157258" }, {})).toBe(false);
    });

    it("rejects when nothing is configured: no keys, blank keys or non-string values (this used to be accepted)", () => {
      expect(verify({}, {}, {})).toBe(false);
      expect(verify({}, { "x-api-key": "anything" }, {})).toBe(false);
      expect(verify({}, {}, { apiKey: "", secretKey: "   ", integrationKey: null })).toBe(false);
      expect(verify({ api_key: "" }, { "x-api-key": "" }, { apiKey: "", secretKey: 123 })).toBe(false);
    });

    it("a wrong credential is not rescued by a right one sent alongside it", () => {
      expect(verify({}, { "x-api-key": secrets.apiKey, "secret-key": "wrong" })).toBe(false);
    });

    it("a dedicated webhook token (carried in the URL path) authenticates on its own, and a wrong one is refused", () => {
      const tokenOnly = { webhookToken: "synthetic-webhook-token-0004" };
      expect(verify({}, { "x-webhook-token": tokenOnly.webhookToken }, tokenOnly)).toBe(true);
      expect(verify({}, { "x-webhook-token": "wrong" }, tokenOnly)).toBe(false);
      expect(verify({}, {}, tokenOnly)).toBe(false);
      // with keys saved as well, the token is one more way in; a presented wrong one still refuses
      expect(verify({}, { "x-webhook-token": tokenOnly.webhookToken }, { ...secrets, ...tokenOnly })).toBe(true);
      expect(verify({}, { "x-webhook-token": "wrong" }, { ...secrets, ...tokenOnly })).toBe(false);
    });

    it("an IVR 'key' field in the call report is data, never a credential: it cannot authenticate and cannot poison a valid request", () => {
      expect(verify({ key: secrets.apiKey }, {})).toBe(false);
      expect(verify({ key: "--", caller_number: "9810157258" }, { "x-api-key": secrets.apiKey })).toBe(true);
      expect(verify({ key: "2" }, { "x-webhook-token": "synthetic-webhook-token-0004" }, { webhookToken: "synthetic-webhook-token-0004" })).toBe(true);
    });

    it("an unrelated header cannot stand in for a key", () => {
      expect(verify({}, { authorization: secrets.apiKey })).toBe(false);
    });
  });

  it("parses completed call reports from CCS Express IVR", () => {
    const payload = {
      call_id: "ccs_call_12345",
      caller_number: "9810157258",
      agent_name: "Poonam Jain",
      status: "Answered",
      duration: "45",
      recording_url: "https://ccs.ivrsms.com/recordings/rec_12345.mp3",
      start_time: "2026-10-06 10:15:00",
      direction: "inbound",
    };

    const events = ccsTelephonyAdapter.parseWebhookPayload(payload);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.externalCallId).toBe("ccs_call_12345");
    expect(event.phone).toBe("9810157258");
    expect(event.status).toBe("completed");
    expect(event.durationSeconds).toBe(45);
    expect(event.agentName).toBe("Poonam Jain");
    expect(event.direction).toBe("inbound");
    expect(event.recordingUrl).toBe("https://ccs.ivrsms.com/recordings/rec_12345.mp3");
  });

  it("parses missed call reports from CCS Express IVR", () => {
    const payload = {
      uniqueid: "uniq_missed_999",
      caller: "+919876543210",
      dialstatus: "Missed",
      duration: "0",
    };

    const events = ccsTelephonyAdapter.parseWebhookPayload(payload);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.externalCallId).toBe("uniq_missed_999");
    expect(event.phone).toBe("+919876543210");
    expect(event.status).toBe("missed");
    expect(event.durationSeconds).toBe(0);
  });

  it("handles array payloads from batch CDR exports", () => {
    const payload = [
      { call_id: "c1", caller: "9810000001", status: "Answered", duration: "30" },
      { call_id: "c2", caller: "9810000002", status: "Abandoned", duration: "0" },
    ];

    const events = ccsTelephonyAdapter.parseWebhookPayload(payload);
    expect(events).toHaveLength(2);
    expect(events[0]!.status).toBe("completed");
    expect(events[1]!.status).toBe("missed");
  });
});
