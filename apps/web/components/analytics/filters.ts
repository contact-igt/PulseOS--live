import { DATE_PRESETS, type AnalyticsQuery, type AnalyticsRangePreset, type SourceChannel } from "@pulseos/types";
import { addDays } from "@pulseos/ui";

export type AnalyticsTab = "overview" | "acquisition" | "journey" | "revenue" | "ads" | "team";

export const ANALYTICS_TABS: { key: AnalyticsTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "acquisition", label: "Acquisition" },
  { key: "journey", label: "Journey" },
  { key: "revenue", label: "Revenue" },
  { key: "ads", label: "Ad accounts" },
  { key: "team", label: "Team" },
];



export interface AnalyticsFilters {
  tab: AnalyticsTab;
  range: AnalyticsRangePreset;
  from?: string;
  to?: string;
  branchId?: string;
  service?: string;
  source?: SourceChannel;
  campaignId?: string;
}

export const DEFAULT_FILTERS: AnalyticsFilters = { tab: "overview", range: "30d" };

const SOURCES: SourceChannel[] = ["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"];
// The shared presets plus the legacy 14-day link.
const RANGES: AnalyticsRangePreset[] = [...DATE_PRESETS.map((p) => p.key), "14d", "last_month"];

const isRealDate = (s: string | null): s is string => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function parseFilters(params: URLSearchParams): AnalyticsFilters {
  const tabParam = params.get("tab");
  const tab = ANALYTICS_TABS.some((t) => t.key === tabParam) ? (tabParam as AnalyticsTab) : "overview";
  let range = RANGES.includes(params.get("range") as AnalyticsRangePreset) ? (params.get("range") as AnalyticsRangePreset) : "30d";
  if (range === "last_month") range = "prev_month"; // an older link: same days, the one name
  const from = params.get("from");
  const to = params.get("to");
  let custom: Pick<AnalyticsFilters, "from" | "to"> = {};
  if (range === "custom") {
    if (isRealDate(from) && isRealDate(to) && from <= to) custom = { from, to };
    else range = "30d";
  }
  const source = params.get("source") as SourceChannel | null;
  return {
    tab,
    range,
    ...custom,
    branchId: params.get("branch") || undefined,
    service: params.get("service") || undefined,
    source: source && SOURCES.includes(source) ? source : undefined,
    campaignId: params.get("campaign") || undefined,
  };
}

/** Query string for the URL — defaults are omitted so a shared link stays short. */
export function toSearch(f: AnalyticsFilters): string {
  const p = new URLSearchParams();
  if (f.tab !== "overview") p.set("tab", f.tab);
  if (f.range !== "30d") p.set("range", f.range);
  if (f.range === "custom" && f.from && f.to) {
    p.set("from", f.from);
    p.set("to", f.to);
  }
  if (f.branchId) p.set("branch", f.branchId);
  if (f.service) p.set("service", f.service);
  if (f.source) p.set("source", f.source);
  if (f.campaignId) p.set("campaign", f.campaignId);
  return p.toString();
}

/** The one AnalyticsQuery every panel's request is built from. */
export function toApiQuery(f: AnalyticsFilters): AnalyticsQuery {
  const q: AnalyticsQuery = { range: f.range };
  if (f.range === "custom") {
    q.from = f.from;
    q.to = f.to;
  }
  if (f.branchId) q.branchId = f.branchId;
  if (f.service) q.service = f.service;
  if (f.source) q.source = f.source;
  if (f.campaignId) q.campaignId = f.campaignId;
  return q;
}

export type FilterKey = "range" | "branch" | "service" | "source" | "campaign";

export function activeFilters(f: AnalyticsFilters): { key: FilterKey }[] {
  const out: { key: FilterKey }[] = [];
  if (f.range !== "30d") out.push({ key: "range" });
  if (f.branchId) out.push({ key: "branch" });
  if (f.service) out.push({ key: "service" });
  if (f.source) out.push({ key: "source" });
  if (f.campaignId) out.push({ key: "campaign" });
  return out;
}

/** The API accepts custom ranges of at most this many inclusive days. */
const MAX_RANGE_DAYS = 366;

/** Default custom range: the last 30 hospital days ending on the hospital's `today` (YYYY-MM-DD). */
export function customRangeDefaults(today: string): { from: string; to: string } {
  return { from: addDays(today, -29), to: today };
}

/** Earliest `from` the API accepts for a range ending on `to`. */
export function earliestFrom(to: string): string {
  return addDays(to, -(MAX_RANGE_DAYS - 1));
}
