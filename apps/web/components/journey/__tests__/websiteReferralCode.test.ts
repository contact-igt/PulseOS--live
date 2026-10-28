import { describe, expect, it } from "vitest";
import { websiteReferralCode } from "../websiteReferralCode";

describe("websiteReferralCode", () => {
  it("reads a referral code from a website lead only", () => {
    expect(websiteReferralCode([{ eventType: "website_form_submitted", sourceChannel: "website", description: "Referral code: NAMOKAR10", id: "1", title: "Website enquiry received", occurredAt: "2026-10-28T00:00:00.000Z", category: "other", relatedEntityType: null, relatedEntityId: null, endpointLabel: null, channel: null, call: null, summaryMode: null, notificationStatus: null }])).toBe("NAMOKAR10");
    expect(websiteReferralCode([])).toBeNull();
  });
});
