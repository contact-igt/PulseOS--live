import { describe, expect, it } from "vitest";
import type { MessageRow } from "@pulseos/types";
import { describeMessage, describeSendProblem } from "../messagePresentation";

const msg = (over: Partial<MessageRow> = {}): MessageRow => ({ id: "m1", senderType: "staff", senderName: "Vikram Rao", body: "hii", sentAt: "2026-10-13T08:05:00.000Z", deliveryStatus: "sent", kind: "text", templateName: null, attachments: [], ...over });

describe("describeMessage", () => {
  it("names who wrote it, by words and by side, never by colour alone", () => {
    expect(describeMessage(msg({ senderType: "patient", senderName: null, deliveryStatus: null }))).toMatchObject({ side: "left", label: "Patient", status: null });
    expect(describeMessage(msg({ senderType: "ai", senderName: null }))).toMatchObject({ side: "right", label: "AI Assistant", tone: "ai" });
    expect(describeMessage(msg())).toMatchObject({ side: "right", label: "Vikram Rao", tone: "staff" });
    // a WhatsNexus agent arrives with their own name; with no name at all it is still a person, not "undefined"
    expect(describeMessage(msg({ senderName: "Priya Nair" })).label).toBe("Priya Nair");
    expect(describeMessage(msg({ senderName: null })).label).toBe("Team member");
  });

  it("shows where a sent message has got to, in words", () => {
    const status = (deliveryStatus: MessageRow["deliveryStatus"]) => describeMessage(msg({ deliveryStatus })).status;
    expect(status("queued")).toEqual({ text: "Sending…", tone: "pending" });
    expect(status("sent")).toEqual({ text: "Sent", tone: "ok" });
    expect(status("delivered")).toEqual({ text: "Delivered", tone: "ok" });
    expect(status("read")).toEqual({ text: "Read", tone: "read" });
    expect(status("failed")).toEqual({ text: "Not delivered", tone: "failed" });
  });

  it("a message that never went to a provider (a note, a demo message) shows no delivery state", () => {
    expect(describeMessage(msg({ deliveryStatus: null })).status).toBeNull();
  });

  it("only a failed text from a person can be retried", () => {
    expect(describeMessage(msg({ deliveryStatus: "failed" })).canRetry).toBe(true);
    expect(describeMessage(msg({ deliveryStatus: "sent" })).canRetry).toBe(false);
    expect(describeMessage(msg({ deliveryStatus: "failed", senderType: "ai" })).canRetry).toBe(false);
    expect(describeMessage(msg({ deliveryStatus: "failed", senderType: "patient" })).canRetry).toBe(false);
    expect(describeMessage(msg({ deliveryStatus: "failed", attachments: [{ id: "a", kind: "image", fileName: null, mimeType: null, sizeBytes: null }] })).canRetry).toBe(false);
  });

  it("a system line is centred and has no sender or status", () => {
    expect(describeMessage(msg({ senderType: "system", senderName: null, deliveryStatus: null }))).toMatchObject({ side: "center", status: null, canRetry: false });
  });
});

describe("describeSendProblem", () => {
  it("explains a closed 24-hour window and what to do instead", () => {
    const d = describeSendProblem("template_required");
    expect(d.summary).toMatch(/24 hours/);
    expect(d.summary).toMatch(/approved template/i);
  });
  it("explains a failed delivery with the provider's own reason kept as the detail", () => {
    const d = describeSendProblem("INSUFFICIENT_BALANCE: wallet empty");
    expect(d.summary).toMatch(/balance/i);
    expect(d.detail).toBe("wallet empty");
    const generic = describeSendProblem("SERVICE_UNAVAILABLE: WhatsApp is down");
    expect(generic.summary).toBe("The message could not be delivered.");
    expect(generic.detail).toBe("SERVICE_UNAVAILABLE: WhatsApp is down");
  });
  it("an unreachable WhatsNexus is said plainly", () => {
    expect(describeSendProblem("unreachable: WhatsNexus unreachable (ECONNREFUSED)").summary).toMatch(/could not reach WhatsNexus/i);
  });
  it("no reason at all still gives a usable message", () => {
    expect(describeSendProblem(null)).toEqual({ summary: "The message could not be delivered.", detail: null });
  });
  it("a long reason is shortened", () => {
    expect(describeSendProblem("x".repeat(500)).detail!.length).toBeLessThanOrEqual(200);
  });
});
