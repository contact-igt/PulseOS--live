import { describe, expect, it } from "vitest";
import { describeWhatsAppFailure } from "../whatsappFailure";

describe("describeWhatsAppFailure", () => {
  it.each([
    ["TEMPLATE_NOT_APPROVED: Template is not approved (status: paused)", /no longer (has this message template approved|approved)/i, "Template is not approved (status: paused)"],
    ["TEMPLATE_NOT_FOUND: Template not found for this tenant", /no longer exists/i, "Template not found for this tenant"],
    ["TEMPLATE_LANGUAGE_MISMATCH: Approved template language is hi", /language/i, "Approved template language is hi"],
    ["TEMPLATE_PARAMETER_COUNT_MISMATCH: Template body expects 2 parameter(s), received 3", /placeholders/i, "Template body expects 2 parameter(s), received 3"],
  ])("explains %s in plain words and keeps WhatsNexus's own text", (reason, summary, detail) => {
    const d = describeWhatsAppFailure(reason);
    expect(d.summary).toMatch(summary);
    expect(d.summary).toMatch(/WhatsNexus WhatsApp → Reminders/);
    expect(d.detail).toBe(detail);
  });

  it("template problems are for an Admin to fix, other failures are not", () => {
    expect(describeWhatsAppFailure("INSUFFICIENT_BALANCE: wallet empty").summary).not.toMatch(/WhatsNexus WhatsApp → Reminders/);
    expect(describeWhatsAppFailure("INSUFFICIENT_BALANCE: wallet empty").summary).toMatch(/balance/i);
  });

  it("a failure with no known code still shows what it said, shortened, instead of a bare 'could not be sent'", () => {
    const d = describeWhatsAppFailure("WhatsNexus rejected the request: something odd");
    expect(d.summary).toBe("The message could not be sent.");
    expect(d.detail).toBe("WhatsNexus rejected the request: something odd");
    expect(describeWhatsAppFailure("x".repeat(500)).detail!.length).toBeLessThanOrEqual(200);
  });

  it("an unknown outcome says it may have been sent", () => {
    expect(describeWhatsAppFailure("OUTCOME_UNKNOWN: WhatsNexus request outcome unknown: timeout").summary).toMatch(/may have been sent/i);
  });

  it("no reason gives the generic message and no detail", () => {
    expect(describeWhatsAppFailure(null)).toEqual({ summary: "The message could not be sent.", detail: null });
  });
});
