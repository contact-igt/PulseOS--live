import type { campaignTouchpoints, SourceChannelDb } from "../../db/schema.js";

type NewCampaignTouchpoint = typeof campaignTouchpoints.$inferInsert;

// Deliberately narrower than a full provider-sourced lead payload (that
// shape belongs to each adapter once ported — website/Meta/Google) — this
// is just what recordTouchpoint needs to persist a row, so a manual Add
// Lead touchpoint (only source + occurredAt) and a future ad-platform
// touchpoint (every field populated) both fit the same insert path.
export interface TouchpointDetails {
  source: SourceChannelDb;
  occurredAt: Date;
  medium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  externalAccountId?: string | null;
  externalCampaignId?: string | null;
  externalAdGroupId?: string | null;
  externalAdId?: string | null;
  externalFormId?: string | null;
  externalLeadId?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function buildTouchpointValues(input: {
  details: TouchpointDetails;
  tenantId: string;
  patientId: string;
  journeyId: string;
  campaignId: string | null;
  touchType: "first_touch" | "last_touch";
}): NewCampaignTouchpoint {
  const { details, tenantId, patientId, journeyId, campaignId, touchType } = input;
  return {
    tenantId,
    patientId,
    journeyId,
    campaignId,
    source: details.source,
    touchType,
    medium: details.medium ?? null,
    utmCampaign: details.utmCampaign ?? null,
    utmContent: details.utmContent ?? null,
    utmTerm: details.utmTerm ?? null,
    externalAccountId: details.externalAccountId ?? null,
    externalCampaignId: details.externalCampaignId ?? null,
    externalAdGroupId: details.externalAdGroupId ?? null,
    externalAdId: details.externalAdId ?? null,
    externalFormId: details.externalFormId ?? null,
    externalLeadId: details.externalLeadId ?? null,
    gclid: details.gclid ?? null,
    gbraid: details.gbraid ?? null,
    wbraid: details.wbraid ?? null,
    fbclid: details.fbclid ?? null,
    occurredAt: details.occurredAt,
    metadata: details.metadata ?? null,
  };
}
