import { afterEach, describe, expect, it, vi } from "vitest";
import { googleAdsLeadFormsAdapter } from "../google-ads-lead-forms.js";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    lead_id: "LEAD_G_1",
    api_version: "1.0",
    form_id: "FORM_G_1",
    campaign_id: "CAMPAIGN_G_1",
    adgroup_id: "ADGROUP_G_1",
    gcl_id: "gclid-google-1",
    google_key: "correct-google-key",
    is_test: false,
    lead_submit_time: "2026-09-01T10:00:00Z",
    user_column_data: [
      { column_id: "FULL_NAME", string_value: "Priya Sharma" },
      { column_id: "PHONE_NUMBER", string_value: "+919876500022" },
      { column_id: "EMAIL", string_value: "priya@example.com" },
      { column_id: "CITY", string_value: "Bangalore" }, // not mapped — must be ignored, not trusted
    ],
    ...overrides,
  };
}

describe("googleAdsLeadFormsAdapter.verifyWebhookKey", () => {
  it("accepts a matching google_key", () => {
    expect(googleAdsLeadFormsAdapter.verifyWebhookKey!(payload(), { googleKey: "correct-google-key" })).toBe(true);
  });

  it("rejects a mismatched google_key", () => {
    expect(googleAdsLeadFormsAdapter.verifyWebhookKey!(payload({ google_key: "wrong" }), { googleKey: "correct-google-key" })).toBe(false);
  });

  it("rejects when no google_key is configured on the connector", () => {
    expect(googleAdsLeadFormsAdapter.verifyWebhookKey!(payload(), {})).toBe(false);
  });

  it("rejects a payload missing google_key entirely", () => {
    const withoutKey = payload();
    delete (withoutKey as { google_key?: string }).google_key;
    expect(googleAdsLeadFormsAdapter.verifyWebhookKey!(withoutKey, { googleKey: "correct-google-key" })).toBe(false);
  });
});

describe("googleAdsLeadFormsAdapter.parseWebhookLead", () => {
  it("maps only the whitelisted user_column_data fields (FULL_NAME/PHONE_NUMBER/EMAIL) — an unmapped column is never trusted", () => {
    const [lead] = googleAdsLeadFormsAdapter.parseWebhookLead!(payload());
    expect(lead.externalLeadId).toBe("LEAD_G_1");
    expect(lead.externalFormId).toBe("FORM_G_1");
    expect(lead.externalCampaignId).toBe("CAMPAIGN_G_1");
    expect(lead.externalAdGroupId).toBe("ADGROUP_G_1");
    expect(lead.gclid).toBe("gclid-google-1");
    expect(lead.name).toBe("Priya Sharma");
    expect(lead.phone).toBe("+919876500022");
    expect(lead.email).toBe("priya@example.com");
    expect(lead.source).toBe("google");
    expect(lead.occurredAt).toEqual(new Date("2026-09-01T10:00:00Z"));
    // CITY was submitted but there is no mapping for it — must not leak
    // into any NormalizedLead field or be trusted as anything meaningful.
    expect(JSON.stringify(lead)).not.toContain("Bangalore");
  });

  it("marks a Google-flagged test lead honestly in metadata rather than silently treating it as real", () => {
    const [lead] = googleAdsLeadFormsAdapter.parseWebhookLead!(payload({ is_test: true }));
    expect(lead.metadata.isTestLead).toBe(true);
  });

  it("handles a lead missing optional fields (no phone submitted) without throwing", () => {
    const [lead] = googleAdsLeadFormsAdapter.parseWebhookLead!(payload({
      user_column_data: [{ column_id: "FULL_NAME", string_value: "No Phone Person" }],
    }));
    expect(lead.name).toBe("No Phone Person");
    expect(lead.phone).toBeNull();
    expect(lead.email).toBeNull();
  });
});

describe("googleAdsLeadFormsAdapter.syncCampaigns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("in fixture mode, returns deterministic fixture campaigns", async () => {
    const records = await googleAdsLeadFormsAdapter.syncCampaigns!({ mode: "fixture" }, {});
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.currency).toBe("INR");
    expect(await googleAdsLeadFormsAdapter.syncCampaigns!({ mode: "fixture" }, {})).toEqual(records);
  });

  it("throws when live mode is missing customerId/accessToken/developerToken", async () => {
    await expect(googleAdsLeadFormsAdapter.syncCampaigns!({ mode: "live" }, {})).rejects.toThrow(/customerId/);
    await expect(googleAdsLeadFormsAdapter.syncCampaigns!({ mode: "live", customerId: "123" }, {})).rejects.toThrow(/accessToken/);
    await expect(googleAdsLeadFormsAdapter.syncCampaigns!({ mode: "live", customerId: "123" }, { accessToken: "t" })).rejects.toThrow(/developerToken/);
  });

  it("in live mode, calls searchStream with a GAQL query and converts cost_micros to whole-rupee spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        { results: [{ campaign: { id: "111", name: "IVF Search", status: "ENABLED", startDate: "2026-08-01", endDate: null }, metrics: { costMicros: "482500000" } }] },
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const records = await googleAdsLeadFormsAdapter.syncCampaigns!({ mode: "live", customerId: "123-456-7890" }, { accessToken: "TOKEN", developerToken: "DEV_TOKEN" });
    expect(records).toEqual([{
      externalCampaignId: "111",
      externalAccountId: "123-456-7890",
      name: "IVF Search",
      source: "google",
      spendAmount: 483,
      currency: "INR",
      startDate: new Date("2026-08-01"),
      endDate: null,
      status: "active",
    }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("customers/123-456-7890/googleAds:searchStream");
    expect((init.headers as Record<string, string>)["developer-token"]).toBe("DEV_TOKEN");
    expect(JSON.parse(init.body as string).query).toContain("FROM campaign");
  });
});

describe("googleAdsLeadFormsAdapter.buildConversionPayload", () => {
  it("builds a Data Manager API IngestEventsRequest — never sends it (pure function, no fetch)", () => {
    const payload = {
      eventType: "TREATMENT_COMPLETED" as const,
      externalCampaignId: "CAMP_1",
      gclid: "gclid-test-123",
      gbraid: null,
      wbraid: null,
      fbclid: null,
      occurredAt: new Date("2026-09-01T10:00:00Z"),
      value: 45000,
      currency: "INR",
      idempotencyKey: "journey-1:TREATMENT_COMPLETED",
    };

    const body = googleAdsLeadFormsAdapter.buildConversionPayload!(payload, { customerId: "123-456-7890", conversionActionId: "CONV_ACTION_1" });
    const event = (body.events as Record<string, unknown>[])[0];
    expect(event.transactionId).toBe("journey-1:TREATMENT_COMPLETED");
    expect(event.currency).toBe("INR");
    expect(event.conversionValue).toBe(45000);
    expect((event.adIdentifiers as Record<string, unknown>).gclid).toBe("gclid-test-123");
    expect((event.consent as Record<string, unknown>).adUserData).toBe("GRANTED"); // only ever built for consent-eligible patients
    const destination = (body.destinations as Record<string, unknown>[])[0];
    expect(destination.productDestinationId).toBe("CONV_ACTION_1");
  });

  it("uses gbraid/wbraid instead of gclid when that's what the touchpoint carries", () => {
    const body = googleAdsLeadFormsAdapter.buildConversionPayload!(
      { eventType: "QUALIFIED_ENQUIRY", externalCampaignId: null, gclid: null, gbraid: "gbraid-1", wbraid: null, fbclid: null, occurredAt: new Date(), value: null, currency: null, idempotencyKey: "j:x" },
      { customerId: "123" },
    );
    const adIdentifiers = (body.events as Record<string, unknown>[])[0].adIdentifiers as Record<string, unknown>;
    expect(adIdentifiers.gbraid).toBe("gbraid-1");
    expect(adIdentifiers.gclid).toBeUndefined();
  });
});
