import { z } from "zod";
import { diffDays, isRealDate } from "./hospital-time.js";

/** The longest hospital-day span a log/report range may cover. */
export const MAX_LOG_RANGE_DAYS = 366;

/**
 * `from` + `to` query params: hospital-local days (YYYY-MM-DD), given together, in order, within a year. Add them to a
 * route's `z.object({...})` and `.superRefine(refineDayRange)`: a bad or half-given range is a 400, never silently
 * "everything".
 */
export const dayRangeShape = {
  from: z.string().refine(isRealDate, "Use a real date as YYYY-MM-DD").optional(),
  to: z.string().refine(isRealDate, "Use a real date as YYYY-MM-DD").optional(),
};

export function refineDayRange(q: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (!q.from !== !q.to) {
    ctx.addIssue({ code: "custom", path: [q.from ? "to" : "from"], message: "from and to go together" });
    return;
  }
  if (q.from && q.to) {
    const span = diffDays(q.from, q.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
    else if (span + 1 > MAX_LOG_RANGE_DAYS) ctx.addIssue({ code: "custom", path: ["to"], message: `at most ${MAX_LOG_RANGE_DAYS} days` });
  }
}

/**
 * Reads a day window out of a query under custom key names (e.g. completedFrom / completedTo). Undefined when neither is
 * given; { error } when it is half-given, malformed, inverted or over a year.
 */
export function readDayWindow(query: unknown, fromKey: string, toKey: string): { from: string; to: string } | undefined | { error: string } {
  const q = (query ?? {}) as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const from = clean(q[fromKey]);
  const to = clean(q[toKey]);
  const parsed = z.object(dayRangeShape).superRefine(refineDayRange).safeParse({ from, to });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid range" };
  return parsed.data.from && parsed.data.to ? { from: parsed.data.from, to: parsed.data.to } : undefined;
}
