import { describe, expect, it } from "vitest";
import { ccsTelephonyAdapter } from "../domain/connector/adapters/ccs.js";

describe("ccsTelephonyAdapter", () => {
  it("verifies webhook with matching apiKey, secretKey or integrationKey", () => {
    const secrets = {
      apiKey: "93250a2de829a1b0481c6d9b908bd45c",
      secretKey: "3d0ce39f0f64a006c36bcc0c54cdc95e",
      integrationKey: "23913d0ce39f0f64a006c36bcc0c54cdc95e",
    };

    // Header matching apiKey
    expect(ccsTelephonyAdapter.verifyWebhook({}, { "x-api-key": "93250a2de829a1b0481c6d9b908bd45c" }, secrets)).toBe(true);

    // Header matching secretKey
    expect(ccsTelephonyAdapter.verifyWebhook({}, { "secret-key": "3d0ce39f0f64a006c36bcc0c54cdc95e" }, secrets)).toBe(true);

    // Payload body matching integrationKey
    expect(ccsTelephonyAdapter.verifyWebhook({ integrationKey: "23913d0ce39f0f64a006c36bcc0c54cdc95e" }, {}, secrets)).toBe(true);

    // Invalid key provided
    expect(ccsTelephonyAdapter.verifyWebhook({}, { "x-api-key": "wrong-key" }, secrets)).toBe(false);

    // No secrets configured yet -> accepts for setup
    expect(ccsTelephonyAdapter.verifyWebhook({}, {}, {})).toBe(true);
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

  it("parses the Express IVR Call Report field names", () => {
    const events = ccsTelephonyAdapter.parseWebhookPayload({
      SourceNumber: "6369441531",
      DestinationNumber: "08065118566",
      DialWhomNumber: "07827455040",
      CallDuration: "51",
      Status: "ANSWER",
      StartTime: "2026-10-16 11:30:29",
      EndTime: "2026-10-16 11:31:20",
      CallSid: "express-ivr-call-123",
      CallRecordingUrl: "https://ccs.ivrsms.com/recordings/express-ivr-call-123.mp3",
      Direction: "IVR",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalCallId: "express-ivr-call-123",
      phone: "6369441531",
      agentName: "07827455040",
      status: "completed",
      durationSeconds: 51,
      direction: "inbound",
      recordingUrl: "https://ccs.ivrsms.com/recordings/express-ivr-call-123.mp3",
      metadata: expect.objectContaining({ ivrNumber: "08065118566" }),
    });
    expect(events[0]!.startedAt?.toISOString()).toBe("2026-10-16T06:00:29.000Z");
    expect(events[0]!.endedAt?.toISOString()).toBe("2026-10-16T06:01:20.000Z");
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
    expect(event.durationSeconds).toBeNull();
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
