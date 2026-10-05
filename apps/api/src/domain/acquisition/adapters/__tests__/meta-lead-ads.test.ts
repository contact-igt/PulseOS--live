import { afterEach, describe, expect, it, vi } from "vitest";
import { metaLeadAdsAdapter } from "../meta-lead-ads.js";

const LEADGEN_WEBHOOK_PAYLOAD = {
  object: "page",
  entry: [{
    id: "FIXTURE_PAGE_ID",
    time: 1440120384,
    changes: [{
      field: "leadgen",
      value: {
        leadgen_id: "123123123123",
        page_id: "FIXTURE_PAGE_ID",
        form_id: "FORM_1",
        adgroup_id: "ADSET_1",
        ad_id: "AD_1",
        created_time: 1440120384,
      },
    }],
  }],
};

describe("metaLeadAdsAdapter.parseWebhookLeadReferences", () => {
  it("extracts every leadgen change entry into a LeadReference", () => {
    const refs = metaLeadAdsAdapter.parseWebhookLeadReferences!(LEADGEN_WEBHOOK_PAYLOAD);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      externalLeadId: "123123123123",
      externalFormId: "FORM_1",
      externalAdGroupId: "ADSET_1",
      externalAdId: "AD_1",
      occurredAt: new Date(1440120384 * 1000),
    });
  });

  it("ignores change entries for fields other than leadgen", () => {
    const refs = metaLeadAdsAdapter.parseWebhookLeadReferences!({
      entry: [{ changes: [{ field: "feed", value: {} }] }],
    });
    expect(refs).toHaveLength(0);
  });

  it("returns an empty array for a payload with no entries", () => {
    expect(metaLeadAdsAdapter.parseWebhookLeadReferences!({})).toEqual([]);
  });
});

describe("metaLeadAdsAdapter.fetchLead", () => {
  const ref = { externalLeadId: "LEAD_1", externalFormId: "FORM_1", externalAdGroupId: "ADSET_1", externalAdId: "AD_1", occurredAt: new Date("2026-09-01T00:00:00Z") };

  it("in fixture mode, returns a deterministic, clearly-labeled stand-in lead — never a real fetch", async () => {
    const lead = await metaLeadAdsAdapter.fetchLead!(ref, { mode: "fixture" }, {});
    expect(lead.source).toBe("meta");
    expect(lead.externalLeadId).toBe("LEAD_1");
    expect(lead.externalFormId).toBe("FORM_1");
    expect(lead.phone).toMatch(/^\+919\d{9}$/);
    expect(lead.metadata.fixture).toBe(true);

    const again = await metaLeadAdsAdapter.fetchLead!(ref, { mode: "fixture" }, {});
    expect(again.phone).toBe(lead.phone); // deterministic, not random
    expect(again.name).toBe(lead.name);
  });

  describe("in live mode", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("throws when no pageAccessToken secret is configured", async () => {
      await expect(metaLeadAdsAdapter.fetchLead!(ref, { mode: "live" }, {})).rejects.toThrow(/pageAccessToken/);
    });

    it("fetches the full lead via the Graph API and normalizes field_data into name/phone/email", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "LEAD_1",
          form_id: "FORM_1",
          ad_id: "AD_1",
          adset_id: "ADSET_1",
          campaign_id: "CAMPAIGN_1",
          created_time: "1725000000",
          field_data: [
            { name: "full_name", values: ["Priya Sharma"] },
            { name: "phone_number", values: ["+919876500011"] },
            { name: "email", values: ["priya@example.com"] },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const lead = await metaLeadAdsAdapter.fetchLead!(ref, { mode: "live" }, { pageAccessToken: "REAL_TOKEN" });
      expect(lead.name).toBe("Priya Sharma");
      expect(lead.phone).toBe("+919876500011");
      expect(lead.email).toBe("priya@example.com");
      expect(lead.externalCampaignId).toBe("CAMPAIGN_1");
      expect(lead.externalAdGroupId).toBe("ADSET_1");

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/LEAD_1");
      expect(calledUrl).toContain("access_token=REAL_TOKEN");
      expect(calledUrl).not.toContain("v20.0"); // not the sunset version
    });

    it("throws a descriptive error when the Graph API call fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "Invalid OAuth access token" }));
      await expect(metaLeadAdsAdapter.fetchLead!(ref, { mode: "live" }, { pageAccessToken: "BAD_TOKEN" })).rejects.toThrow(/400/);
    });
  });
});

describe("metaLeadAdsAdapter.syncCampaigns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("in fixture mode, returns deterministic fixture campaigns — never a real fetch", async () => {
    const records = await metaLeadAdsAdapter.syncCampaigns!({ mode: "fixture" }, {});
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.currency).toBe("INR");
      expect(r.spendAmount).toBeGreaterThan(0);
    }
    const again = await metaLeadAdsAdapter.syncCampaigns!({ mode: "fixture" }, {});
    expect(again).toEqual(records); // deterministic
  });

  it("throws when live mode is missing an adAccountId or pageAccessToken", async () => {
    await expect(metaLeadAdsAdapter.syncCampaigns!({ mode: "live" }, {})).rejects.toThrow(/adAccountId|pageAccessToken/);
  });

  it("in live mode, fetches campaigns and merges in spend from insights", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "CAMP_1", name: "Fertility Awareness", status: "ACTIVE", start_time: "2026-08-01T00:00:00+0000", stop_time: null }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ campaign_id: "CAMP_1", spend: "482.50" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const records = await metaLeadAdsAdapter.syncCampaigns!({ mode: "live", adAccountId: "act_123" }, { pageAccessToken: "REAL_TOKEN" });
    expect(records).toEqual([{
      externalCampaignId: "CAMP_1",
      externalAccountId: "act_123",
      name: "Fertility Awareness",
      source: "meta",
      spendAmount: 483, // rounded rupees
      currency: "INR",
      startDate: new Date("2026-08-01T00:00:00+0000"),
      endDate: null,
      status: "active",
    }]);
  });
});

describe("metaLeadAdsAdapter.buildConversionPayload", () => {
  it("builds a Meta Conversions API event object — never sends it (pure function, no fetch)", () => {
    const payload = {
      eventType: "TREATMENT_COMPLETED" as const,
      externalCampaignId: "CAMP_1",
      gclid: null, gbraid: null, wbraid: null,
      fbclid: "fbclid-test-123",
      occurredAt: new Date("2026-09-01T10:00:00Z"),
      value: 45000,
      currency: "INR",
      idempotencyKey: "journey-1:TREATMENT_COMPLETED",
    };

    const body = metaLeadAdsAdapter.buildConversionPayload!(payload, { pixelId: "PIXEL_1" });
    const event = (body.data as Record<string, unknown>[])[0];
    expect(event.event_name).toBe("Purchase"); // TREATMENT_COMPLETED maps to a value event, not "Lead"
    expect(event.action_source).toBe("system_generated"); // CRM-driven, not "website"
    expect(event.event_id).toBe("journey-1:TREATMENT_COMPLETED"); // dedup key
    expect((event.custom_data as Record<string, unknown>).value).toBe(45000);
    expect((event.custom_data as Record<string, unknown>).currency).toBe("INR");
    expect(((event.user_data as Record<string, unknown>).fbc as string)).toContain("fbclid-test-123");
  });

  it("maps QUALIFIED_ENQUIRY to the standard Lead event name", () => {
    const body = metaLeadAdsAdapter.buildConversionPayload!(
      { eventType: "QUALIFIED_ENQUIRY", externalCampaignId: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, occurredAt: new Date(), value: null, currency: null, idempotencyKey: "j:QUALIFIED_ENQUIRY" },
      {},
    );
    expect((body.data as Record<string, unknown>[])[0].event_name).toBe("Lead");
  });

  it("omits user_data.fbc entirely when no fbclid is present, rather than sending a malformed value", () => {
    const body = metaLeadAdsAdapter.buildConversionPayload!(
      { eventType: "TREATMENT_COMPLETED", externalCampaignId: null, gclid: null, gbraid: null, wbraid: null, fbclid: null, occurredAt: new Date(), value: 1000, currency: "INR", idempotencyKey: "j:x" },
      {},
    );
    const userData = (body.data as Record<string, unknown>[])[0].user_data as Record<string, unknown>;
    expect(userData.fbc).toBeUndefined();
  });
});
