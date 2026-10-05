import type { AcquisitionProviderAdapter, PerformanceSyncRecord } from "../types.js";

// Verified live against developers.google.com/my-business/reference/
// performance on 2026-09-13 (Group AH): locations.fetchMultiDailyMetricsTimeSeries
// is a GET with no body — locationId + repeated dailyMetrics + a
// dailyRange query params — returning ONE time series per metric, keyed by
// date, that has to be merged client-side into one record per day. This
// adapter ONLY implements syncPerformance: no parseWebhookLead, no
// fetchLead, no leadgen capability of any kind — a Google Business Profile
// listing's aggregate search/click metrics are never, by themselves, a
// trackable event for a specific person, so there is nothing here that
// could ever construct a Patient. A patient reached via a GBP listing
// (e.g. tapping "Call") shows up through the normal call/message/form
// ingestion pipeline instead, tagged with whatever real source that
// channel carries — never invented from this aggregate feed.
const GBP_PERFORMANCE_API_BASE = "https://businessprofileperformance.googleapis.com/v1";
const GBP_DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "WEBSITE_CLICKS",
  "CALL_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
];

interface GbpDate {
  year: number;
  month: number;
  day: number;
}

interface GbpDatedValue {
  date: GbpDate;
  value?: string;
}

interface GbpDailyMetricTimeSeries {
  dailyMetric: string;
  timeSeries?: { datedValues?: GbpDatedValue[] };
}

interface GbpMultiDailyMetricTimeSeries {
  dailyMetricTimeSeries?: GbpDailyMetricTimeSeries[];
}

interface GbpFetchMultiResponse {
  multiDailyMetricTimeSeries?: GbpMultiDailyMetricTimeSeries[];
}

function dateKey(d: GbpDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function toDate(d: GbpDate): Date {
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

function dateQueryParams(prefix: "start" | "end", d: Date): string {
  return `dailyRange.${prefix}_date.year=${d.getUTCFullYear()}&dailyRange.${prefix}_date.month=${d.getUTCMonth() + 1}&dailyRange.${prefix}_date.day=${d.getUTCDate()}`;
}

export const googleBusinessProfileAdapter: AcquisitionProviderAdapter = {
  capabilities: ["SYNC_PERFORMANCE"],

  async syncPerformance(config, secrets): Promise<PerformanceSyncRecord[]> {
    if (config.mode === "fixture") {
      return [
        { externalCampaignId: null, metricDate: new Date("2026-09-01T00:00:00Z"), impressions: 340, clicks: 28, searchImpressions: 340, websiteClicks: 28, callClicks: 9, directionRequests: 6, raw: { fixture: true } },
        { externalCampaignId: null, metricDate: new Date("2026-09-02T00:00:00Z"), impressions: 305, clicks: 22, searchImpressions: 305, websiteClicks: 22, callClicks: 7, directionRequests: 5, raw: { fixture: true } },
      ];
    }

    const locationId = config.locationId;
    const accessToken = secrets.accessToken;
    if (typeof locationId !== "string" || !locationId) {
      throw new Error("Google Business Profile connector is missing a locationId configuration value");
    }
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Google Business Profile connector is missing an accessToken secret");
    }

    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const metricsParams = GBP_DAILY_METRICS.map((m) => `dailyMetrics=${m}`).join("&");
    const url = `${GBP_PERFORMANCE_API_BASE}/${locationId}:fetchMultiDailyMetricsTimeSeries?${metricsParams}&${dateQueryParams("start", start)}&${dateQueryParams("end", end)}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`GBP performance sync failed: ${res.status} ${errorBody}`);
    }

    const data = (await res.json()) as GbpFetchMultiResponse;
    const byDate = new Map<string, { date: Date; values: Record<string, number> }>();
    for (const multi of data.multiDailyMetricTimeSeries ?? []) {
      for (const series of multi.dailyMetricTimeSeries ?? []) {
        for (const dv of series.timeSeries?.datedValues ?? []) {
          const key = dateKey(dv.date);
          if (!byDate.has(key)) byDate.set(key, { date: toDate(dv.date), values: {} });
          byDate.get(key)!.values[series.dailyMetric] = Number(dv.value ?? 0);
        }
      }
    }

    return Array.from(byDate.values()).map(({ date, values }) => {
      const searchImpressions = (values.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH ?? 0) + (values.BUSINESS_IMPRESSIONS_MOBILE_SEARCH ?? 0);
      return {
        externalCampaignId: null,
        metricDate: date,
        impressions: searchImpressions,
        clicks: values.WEBSITE_CLICKS ?? 0,
        searchImpressions,
        websiteClicks: values.WEBSITE_CLICKS ?? 0,
        callClicks: values.CALL_CLICKS ?? 0,
        directionRequests: values.BUSINESS_DIRECTION_REQUESTS ?? 0,
        raw: values,
      };
    });
  },
};
