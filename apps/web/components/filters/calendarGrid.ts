import { addDays, diffDays } from "@pulseos/ui";

/**
 * Pure calendar math for the PulseOS date pickers. Everything is a plain `YYYY-MM-DD` hospital day (or `YYYY-MM`
 * month) string: no Date objects, no browser timezone, so the picker can never disagree with the hospital's calendar.
 */

/** "2026-10-03" -> "2026-10". */
export const monthOf = (day: string): string => day.slice(0, 7);

/** The month `n` months after (or before) `month`. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Six Sunday-first weeks (42 days) covering `month`, including the trailing/leading days of its neighbours. */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export interface DisabledOptions {
  today: string;
  allowFuture: boolean;
  /** Start of a range that has no end yet: only days within `maxSpanDays` of it can complete the range. */
  pendingFrom?: string;
  maxSpanDays?: number;
}

export function dayDisabled(day: string, o: DisabledOptions): boolean {
  if (!o.allowFuture && day > o.today) return true;
  if (o.pendingFrom && o.maxSpanDays && Math.abs(diffDays(o.pendingFrom, day)) + 1 > o.maxSpanDays) return true;
  return false;
}

export interface DraftRange {
  from: string | undefined;
  to: string | undefined;
}

/** What a click on `day` does to a range being picked. */
export function clickRangeDay(draft: DraftRange, day: string): DraftRange {
  if (!draft.from || draft.to) return { from: day, to: undefined };
  return day < draft.from ? { from: day, to: draft.from } : { from: draft.from, to: day };
}
