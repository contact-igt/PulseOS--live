import { afterEach, describe, expect, it, vi } from "vitest";
import { googleBusinessProfileAdapter } from "../google-business-profile.js";

describe("googleBusinessProfileAdapter.capabilities", () => {
  it("declares SYNC_PERFORMANCE only — never RECEIVE_LEAD/RECEIVE_FORM (aggregate-only, never creates Patients)", () => {
    expect(googleBusinessProfileAdapter.capabilities).toEqual(["SYNC_PERFORMANCE"]);
    expect(googleBusinessProfileAdapter.parseWebhookLead).toBeUndefined();
    expect(googleBusinessProfileAdapter.parseWebhookLeadReferences).toBeUndefined();
    expect(googleBusinessProfileAdapter.fetchLead).toBeUndefined();
  });
});

describe("googleBusinessProfileAdapter.syncPerformance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("in fixture mode, returns deterministic daily aggregate metrics — never a real fetch", async () => {
    const records = await googleBusinessProfileAdapter.syncPerformance!({ mode: "fixture" }, {});
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.externalCampaignId).toBeNull(); // a listing, not a campaign
      expect(typeof r.searchImpressions).toBe("number");
      expect(typeof r.websiteClicks).toBe("number");
      expect(typeof r.callClicks).toBe("number");
      expect(typeof r.directionRequests).toBe("number");
    }
    const again = await googleBusinessProfileAdapter.syncPerformance!({ mode: "fixture" }, {});
    expect(again).toEqual(records); // deterministic
  });

  it("throws when live mode is missing locationId or accessToken", async () => {
    await expect(googleBusinessProfileAdapter.syncPerformance!({ mode: "live" }, {})).rejects.toThrow(/locationId/);
    await expect(googleBusinessProfileAdapter.syncPerformance!({ mode: "live", locationId: "locations/123" }, {})).rejects.toThrow(/accessToken/);
  });

  it("in live mode, fetches fetchMultiDailyMetricsTimeSeries and merges same-date metrics into one record per day", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        multiDailyMetricTimeSeries: [{
          dailyMetricTimeSeries: [
            { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "12" }] } },
            { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "5" }] } },
            { dailyMetric: "BUSINESS_DIRECTION_REQUESTS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "3" }] } },
            { dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "40" }] } },
            { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "60" }] } },
          ],
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const records = await googleBusinessProfileAdapter.syncPerformance!({ mode: "live", locationId: "locations/999" }, { accessToken: "TOKEN" });
    expect(records).toEqual([{
      externalCampaignId: null,
      metricDate: new Date(Date.UTC(2026, 8, 1)),
      impressions: 100, // desktop + mobile search impressions summed
      clicks: 12, // website clicks
      searchImpressions: 100,
      websiteClicks: 12,
      callClicks: 5,
      directionRequests: 3,
      raw: expect.any(Object),
    }]);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("locations/999:fetchMultiDailyMetricsTimeSeries");
    expect(url).toContain("dailyMetrics=WEBSITE_CLICKS");
    expect(url).toContain("dailyMetrics=CALL_CLICKS");
  });
});
