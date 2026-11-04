import type { TimelineEventVm } from "@pulseos/types";

export function websiteReferralCode(events: TimelineEventVm[]): string | null {
  const description = [...events].reverse().find((event) => (event.eventType === "website_form_submitted" || event.eventType === "website_form_resubmitted") && event.sourceChannel === "website" && event.description?.includes("Referral code:"))?.description;
  return description?.match(/(?:^| · )Referral code: ([^·]+)/)?.[1]?.trim() || null;
}
