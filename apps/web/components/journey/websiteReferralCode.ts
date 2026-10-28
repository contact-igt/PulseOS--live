import type { TimelineEventVm } from "@pulseos/types";

export function websiteReferralCode(events: TimelineEventVm[]): string | null {
  const description = events.find((event) => event.eventType === "website_form_submitted" && event.sourceChannel === "website")?.description;
  return description?.match(/(?:^| · )Referral code: ([^·]+)/)?.[1]?.trim() || null;
}
