import type { Db } from "../../db/client.js";
import { ingestNormalizedLead } from "./lead-ingestion.service.js";
import type { NormalizedLead } from "./types.js";

export interface WebsiteFormSubmissionInput {
  formId: string;
  name: string;
  phone: string;
  email: string | null;
  service: string | null;
  /** What the person typed in the "I am interested" box (capped upstream). Shown on the Timeline entry. */
  message?: string | null;
  /** A hospital that records every website enquiry as "Website" regardless of the page's UTM tags. */
  fixedSource?: "website" | null;
  language: string | null;
  branchId: string | null;
  pageUrl: string | null;
  submissionId: string;
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
  clickIds: { gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null };
  occurredAt: Date;
}

// Derives the CampaignTouchpoint's `source` enum from the submitted UTM
// source — website-form traffic almost always names a real channel, but
// falls back to "website" (never an invented value) when it doesn't.
const KNOWN_SOURCES = new Set(["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"]);
function resolveSourceChannel(utmSource: string | null): NormalizedLead["source"] {
  const normalized = utmSource?.trim().toLowerCase() ?? "";
  return (KNOWN_SOURCES.has(normalized) ? normalized : "website") as NormalizedLead["source"];
}

export async function processWebsiteFormSubmission(
  db: Db,
  tenantId: string,
  input: WebsiteFormSubmissionInput,
): Promise<{ patientId: string; journeyId: string; touchpointId: string; deduped: boolean }> {
  const lead: NormalizedLead = {
    externalLeadId: input.submissionId,
    externalFormId: input.formId,
    externalAccountId: null,
    externalCampaignId: null,
    externalAdGroupId: null,
    externalAdId: null,
    name: input.name,
    phone: input.phone,
    email: input.email,
    source: input.fixedSource ?? resolveSourceChannel(input.utm.source),
    medium: input.utm.medium,
    utmCampaign: input.utm.campaign,
    utmContent: input.utm.content,
    utmTerm: input.utm.term,
    gclid: input.clickIds.gclid,
    gbraid: input.clickIds.gbraid,
    wbraid: input.clickIds.wbraid,
    fbclid: input.clickIds.fbclid,
    occurredAt: input.occurredAt,
    metadata: { pageUrl: input.pageUrl, formId: input.formId },
  };

  // All-or-nothing for this source: a failure part-way (after the patient, before the follow-up task) must not leave a half-made
  // lead behind, because the retry would then reuse that journey and never create the task. The shared pipeline is unchanged.
  const result = await db.transaction((tx) => ingestNormalizedLead(tx as unknown as Db, tenantId, lead, {
    branchId: input.branchId,
    journeyTypeFallback: input.service ?? "Website Enquiry",
    campaignNameFallback: "Website – Direct",
    sourceLabel: "website",
    taskDueInHours: 2,
    firstTouchEventType: "website_form_submitted",
    firstTouchTitle: "Website enquiry received",
    additionalTouchEventType: "website_form_resubmitted",
    additionalTouchTitle: "Website form resubmitted",
    description: [input.message, input.pageUrl].filter((x): x is string => !!x).join(" · ") || null,
  }));

  return { patientId: result.patientId, journeyId: result.journeyId, touchpointId: result.touchpointId, deduped: result.journeyReused };
}
