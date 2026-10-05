import { describe, expect, it } from "vitest";
import { buildTouchpointValues } from "../touchpoint.js";
import type { NormalizedLead } from "../types.js";

function lead(overrides: Partial<NormalizedLead> = {}): NormalizedLead {
  return {
    externalLeadId: "lead-1",
    externalFormId: "form-1",
    externalAccountId: "act-1",
    externalCampaignId: "camp-1",
    externalAdGroupId: "adgroup-1",
    externalAdId: "ad-1",
    name: "Test Patient",
    phone: "+919876500001",
    email: null,
    source: "meta",
    medium: "paid_social",
    utmCampaign: "fertility-q3",
    utmContent: "carousel-a",
    utmTerm: null,
    gclid: null,
    gbraid: null,
    wbraid: null,
    fbclid: "fb.123.456",
    occurredAt: new Date("2026-09-01T10:00:00Z"),
    metadata: { raw: true },
    ...overrides,
  };
}

describe("buildTouchpointValues", () => {
  it("maps every NormalizedLead field onto the matching campaign_touchpoints column", () => {
    const values = buildTouchpointValues({
      details: lead(),
      tenantId: "tenant-1",
      patientId: "patient-1",
      journeyId: "journey-1",
      campaignId: "campaign-row-1",
      touchType: "first_touch",
    });

    expect(values).toEqual({
      tenantId: "tenant-1",
      patientId: "patient-1",
      journeyId: "journey-1",
      campaignId: "campaign-row-1",
      source: "meta",
      touchType: "first_touch",
      medium: "paid_social",
      utmCampaign: "fertility-q3",
      utmContent: "carousel-a",
      utmTerm: null,
      externalAccountId: "act-1",
      externalCampaignId: "camp-1",
      externalAdGroupId: "adgroup-1",
      externalAdId: "ad-1",
      externalFormId: "form-1",
      externalLeadId: "lead-1",
      gclid: null,
      gbraid: null,
      wbraid: null,
      fbclid: "fb.123.456",
      occurredAt: lead().occurredAt,
      metadata: { raw: true },
    });
  });

  it("allows a null resolved campaignId — the raw external/UTM context is still preserved", () => {
    const values = buildTouchpointValues({
      details: lead({ externalCampaignId: null, utmCampaign: "unrecognized-campaign" }),
      tenantId: "tenant-1",
      patientId: "patient-1",
      journeyId: "journey-1",
      campaignId: null,
      touchType: "last_touch",
    });

    expect(values.campaignId).toBeNull();
    expect(values.utmCampaign).toBe("unrecognized-campaign");
    expect(values.touchType).toBe("last_touch");
  });
});
