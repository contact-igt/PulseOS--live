import type { Db } from "../../db/client.js";
import { addDays, diffDays, isRealDate, localToday, tenantTimezone } from "../../lib/hospital-time.js";
import { resolveDatePreset, type ReportPeriod, type ReportRange } from "@pulseos/types";

/** A malformed period (bad preset, inverted or future dates...) — routes map this to HTTP 400. */
export class ReportInputError extends Error {}

export const REPORT_MAX_RANGE_DAYS = 366;

/**
 * Resolves a report period to inclusive hospital-local calendar days. "Today" is the hospital's today (tenants.timezone),
 * never the server's or UTC's — at 00:30 IST it is already the new day even though UTC is still on the previous one.
 * Pure: `today` is passed in so every boundary is testable without a clock.
 */
export function resolveReportRange(range: ReportRange, today: string, from?: string, to?: string): { from: string; to: string } {
  switch (range) {
    case "custom": {
      if (!from || !to || !isRealDate(from) || !isRealDate(to)) throw new ReportInputError("A custom range needs valid from and to dates (YYYY-MM-DD)");
      if (diffDays(from, to) < 0) throw new ReportInputError("'from' must not be after 'to'");
      if (diffDays(from, to) + 1 > REPORT_MAX_RANGE_DAYS) throw new ReportInputError(`A range can cover at most ${REPORT_MAX_RANGE_DAYS} days`);
      if (diffDays(today, to) > 0) throw new ReportInputError("'to' cannot be after today");
      return { from, to };
    }
    default:
      return resolveDatePreset(range, today);
  }
}

export async function resolveReportPeriod(db: Db, tenantId: string, q: { range?: ReportRange; from?: string; to?: string }, now: Date = new Date()): Promise<ReportPeriod> {
  const timezone = await tenantTimezone(db, tenantId);
  const today = await localToday(db, timezone, now);
  const range = q.range ?? "30d";
  const { from, to } = resolveReportRange(range, today, q.from, q.to);
  return { range, from, to, days: diffDays(from, to) + 1, timezone, today };
}

/** Every local day of the period, oldest first. */
export function periodDays(p: Pick<ReportPeriod, "from" | "days">): string[] {
  return Array.from({ length: p.days }, (_, i) => addDays(p.from, i));
}
