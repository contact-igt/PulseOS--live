import type { Db } from "../../db/client.js";
import { addDays, diffDays, isRealDate, localToday, tenantTimezone } from "../../lib/hospital-time.js";
import { resolveDatePreset, type AnalyticsBucket, AnalyticsGranularity, AnalyticsPeriod, AnalyticsQuery } from "@pulseos/types";

/** A malformed filter (bad range, inverted dates...) — the route maps this to HTTP 400. */
export class AnalyticsInputError extends Error {}

const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export { addDays, diffDays, inLocalRange, isRealDate, localDay, localToday, tenantTimezone, tzLiteral } from "../../lib/hospital-time.js";

export async function resolvePeriod(db: Db, tenantId: string, query: Pick<AnalyticsQuery, "range" | "from" | "to">, now: Date = new Date()): Promise<AnalyticsPeriod> {
  const timezone = await tenantTimezone(db, tenantId);
  const preset = query.range ?? "30d";
  const today = await localToday(db, timezone, now);
  let from: string;
  let to: string;

  if (preset === "custom") {
    if (!query.from || !query.to || !isRealDate(query.from) || !isRealDate(query.to)) {
      throw new AnalyticsInputError("A custom range needs valid from and to dates (YYYY-MM-DD)");
    }
    from = query.from;
    to = query.to;
    if (diffDays(from, to) < 0) throw new AnalyticsInputError("Invalid range: 'from' must not be after 'to'");
    if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) throw new AnalyticsInputError(`Invalid range: at most ${MAX_RANGE_DAYS} days`);
    if (diffDays(today, to) > 0) throw new AnalyticsInputError("Invalid range: 'to' cannot be in the future");
  } else {
    ({ from, to } = resolveDatePreset(preset, today));
  }

  const days = diffDays(from, to) + 1;
  const previousTo = addDays(from, -1);
  const previousUntil = to === today ? new Date(now.getTime() - days * DAY_MS).toISOString() : null;
  return { preset, from, to, days, previousFrom: addDays(previousTo, -(days - 1)), previousTo, timezone, today, previousUntil };
}

// --- Buckets: a local day, or a 7-day block anchored at the period start ---

export function leadsGranularity(days: number): AnalyticsGranularity {
  return days <= 31 ? "day" : "week";
}

export function revenueGranularity(days: number): AnalyticsGranularity {
  return days <= 7 ? "day" : "week";
}

export const binDays = (g: AnalyticsGranularity) => (g === "day" ? 1 : 7);

export function buildBuckets(from: string, days: number, granularity: AnalyticsGranularity): AnalyticsBucket[] {
  const size = binDays(granularity);
  const last = addDays(from, days - 1);
  const out: AnalyticsBucket[] = [];
  for (let offset = 0; offset < days; offset += size) {
    const key = addDays(from, offset);
    const to = addDays(key, size - 1) > last ? last : addDays(key, size - 1);
    const span = diffDays(key, to) + 1;
    out.push({ key, to, days: span, partial: span < size });
  }
  return out;
}

/** Index of the bucket a local day belongs to, or -1 when outside the period. */
export function bucketIndex(day: string, from: string, days: number, granularity: AnalyticsGranularity): number {
  const offset = diffDays(from, day);
  if (offset < 0 || offset >= days) return -1;
  return Math.floor(offset / binDays(granularity));
}
