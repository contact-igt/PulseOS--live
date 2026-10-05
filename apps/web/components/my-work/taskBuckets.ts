import { addDays, dayStartInstant, localDayKey } from "@pulseos/ui";
import type { TaskRow } from "@pulseos/types";

/**
 * Due buckets for the My Work board. Day boundaries are the HOSPITAL's
 * (tenant timezone), never UTC or the browser's zone. Every task lands in
 * exactly one bucket, so the board always shows the same records as the list.
 */
export type DueBucket = "overdue" | "today" | "upcoming" | "done";
export const BUCKETS: DueBucket[] = ["overdue", "today", "upcoming", "done"];

const MINUTE = 60_000;
const SLOT = 15 * MINUTE;

const isOpen = (t: TaskRow) => t.status === "pending" || t.status === "in_progress";

export function dueBucket(task: TaskRow, now: Date, timeZone: string): DueBucket {
  if (!isOpen(task)) return "done";
  const due = new Date(task.dueAt);
  if (due.getTime() < now.getTime()) return "overdue";
  return localDayKey(due, timeZone) === localDayKey(now, timeZone) ? "today" : "upcoming";
}

export function groupByBucket(tasks: TaskRow[], now: Date, timeZone: string): Record<DueBucket, TaskRow[]> {
  const out: Record<DueBucket, TaskRow[]> = { overdue: [], today: [], upcoming: [], done: [] };
  for (const t of tasks) out[dueBucket(t, now, timeZone)].push(t);
  return out;
}

/** Minutes after local midnight (in `timeZone`) of an instant. */
function localMinutesOf(instant: Date, timeZone: string): number {
  return Math.round((instant.getTime() - dayStartInstant(localDayKey(instant, timeZone), timeZone).getTime()) / MINUTE);
}

/**
 * The new due instant a board move stands for (sent to the existing
 * reschedule endpoint):
 *  - Today: today at the task's original local time if still ahead, else the
 *    next 15-minute slot (capped at 23:59 local);
 *  - Upcoming: tomorrow (hospital day) at the original local time.
 */
export function rescheduleTarget(task: TaskRow, to: "today" | "upcoming", now: Date, timeZone: string): string {
  const minutes = localMinutesOf(new Date(task.dueAt), timeZone);
  const today = localDayKey(now, timeZone);
  if (to === "upcoming") {
    return new Date(dayStartInstant(addDays(today, 1), timeZone).getTime() + minutes * MINUTE).toISOString();
  }
  const start = dayStartInstant(today, timeZone).getTime();
  const sameTime = start + minutes * MINUTE;
  if (sameTime > now.getTime()) return new Date(sameTime).toISOString();
  const nextSlot = start + Math.ceil((now.getTime() - start + 1) / SLOT) * SLOT;
  const lastMinute = dayStartInstant(addDays(today, 1), timeZone).getTime() - MINUTE;
  return new Date(Math.min(nextSlot, lastMinute)).toISOString();
}

/** Columns a card may move to. Each maps to a real endpoint: Today/Upcoming = reschedule, Done = complete. */
export function allowedBucketMoves(task: TaskRow, canManage: boolean, now: Date, timeZone: string): DueBucket[] {
  if (!canManage || !isOpen(task)) return [];
  const from = dueBucket(task, now, timeZone);
  return (["today", "upcoming", "done"] as const).filter((b) => b !== from);
}

const dueFormatCache = new Map<string, Intl.DateTimeFormat>();
/** "30 Sept, 10:00 am" in the hospital's zone (the shared fmtDateTime helpers use the browser's zone). */
export function formatDueInZone(iso: string, timeZone: string): string {
  let f = dueFormatCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
    dueFormatCache.set(timeZone, f);
  }
  return f.format(new Date(iso));
}
