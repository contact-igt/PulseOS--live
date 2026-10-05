import { and, asc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, timelineEvents } from "../../db/schema.js";
import type { DueJob } from "../../jobs/runner.js";
import { planForSubject } from "./notification.service.js";

// Safety net for the one gap the in-process "appointment.confirmed" event cannot close: the visit is CONFIRMED and committed,
// but the process died before the confirmation / reminders were planned (and a second Confirm click is, by design, a no-op).
//
// The appointment row is the truth about what SHOULD exist; the notification rows are what DOES. This pass does not decide
// anything itself: for each confirmed, upcoming visit it asks the same idempotent planner the event uses. Planning is keyed
// in the database (unique tenant + rule + visit + start time), so a visit that is already fully planned costs a few reads and
// writes nothing, a partly planned one is completed, and concurrent runs cannot double anything. The planner also owns every
// rule: capability off, rule off, no reminder in the past, a visit that is no longer confirmed. Sending stays with the
// worker, which re-reads the visit and refuses anything that is no longer confirmed.
//
// Two deliberate limits, so that the safety net can never itself cause a bad message:
//  * it only FILLS GAPS: a notification that was cancelled (rule off, visit moved, worker late) is never brought back here;
//  * it plans the immediate CONFIRMATION only for a visit confirmed in the last 24 hours (read from the confirm event that is
//    committed together with the status). A visit confirmed days ago, or while WhatsApp was off, is never "confirmed" again
//    to the patient just because a switch was turned on; its reminders (which are always in the future) still follow.

/** Visits further out than this are picked up by a later run. Past visits are never touched: a confirmation for a visit that has started is useless. */
export const RECONCILE_HORIZON_DAYS = 7;
/** A confirmation is recovered only for a visit confirmed this recently. */
export const RECONCILE_CONFIRMATION_WINDOW_HOURS = 24;
const DEFAULT_PAGE = 200;
/** One run stops after this long; the next run carries on from where it stopped (so a large backlog is never starved). */
const RUN_BUDGET_MS = 20_000;
/** One pass every few minutes is plenty for the pilot; override with NOTIFICATION_RECONCILE_INTERVAL_MS. */
export const RECONCILE_DEFAULT_INTERVAL_MS = 5 * 60_000;

export interface ReconcileCursor { at: Date; id: string }

export interface ReconcileResult {
  /** Confirmed upcoming visits looked at. */
  inspected: number;
  /** Notifications that were missing and are now planned (confirmations + reminders). */
  recovered: number;
  /** Visits whose planning threw; the next run tries them again. */
  errors: number;
  /** A few failure causes (visit id + message, never patient data) so a visit that always fails is diagnosable. */
  errorSamples: { visitId: string; message: string }[];
  /** Set when the run stopped on its time budget: pass it back as `after` to continue. */
  next: ReconcileCursor | null;
}

export async function reconcileAppointmentNotifications(
  db: Db,
  now: Date = new Date(),
  opts: { horizonDays?: number; after?: ReconcileCursor | null; tenantIds?: string[]; budgetMs?: number; pageSize?: number } = {},
): Promise<ReconcileResult> {
  const horizon = new Date(now.getTime() + (opts.horizonDays ?? RECONCILE_HORIZON_DAYS) * 86_400_000);
  const deadline = Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS);
  const result: ReconcileResult = { inspected: 0, recovered: 0, errors: 0, errorSamples: [], next: null };
  let cursor = opts.after ?? null;
  const page = opts.pageSize ?? DEFAULT_PAGE;

  for (;;) {
    const visits = await db
      .select({ id: appointments.id, tenantId: appointments.tenantId, at: appointments.scheduledAt })
      .from(appointments)
      .where(and(
        eq(appointments.status, "confirmed"),
        gt(appointments.scheduledAt, now),
        lte(appointments.scheduledAt, horizon),
        ...(opts.tenantIds ? [inArray(appointments.tenantId, opts.tenantIds)] : []),
        ...(cursor ? [or(gt(appointments.scheduledAt, cursor.at), and(eq(appointments.scheduledAt, cursor.at), gt(appointments.id, cursor.id)))!] : []),
      ))
      .orderBy(asc(appointments.scheduledAt), asc(appointments.id))
      .limit(page);
    if (visits.length === 0) return result;

    const since = new Date(now.getTime() - RECONCILE_CONFIRMATION_WINDOW_HOURS * 3_600_000);
    const recentlyConfirmed = new Set(
      (await db
        .select({ id: timelineEvents.relatedEntityId })
        .from(timelineEvents)
        .where(and(eq(timelineEvents.eventType, "appointment_confirmed"), gte(timelineEvents.occurredAt, since), inArray(timelineEvents.relatedEntityId, visits.map((v) => v.id)))))
        .map((r) => r.id),
    );

    for (const v of visits) {
      result.inspected++;
      try {
        result.recovered += (await planForSubject(db, v.tenantId, "APPOINTMENT", v.id, now, { onlyGaps: true, confirmations: recentlyConfirmed.has(v.id) })).planned;
      } catch (err) {
        result.errors++;
        if (result.errorSamples.length < 3) result.errorSamples.push({ visitId: v.id, message: err instanceof Error ? err.message.slice(0, 200) : "error" });
      }
    }
    const last = visits[visits.length - 1]!;
    cursor = { at: last.at, id: last.id };
    if (visits.length < page) return result;
    if (Date.now() > deadline) return { ...result, next: cursor };
  }
}

/**
 * The runner wakes every few seconds; this job runs the pass only when its own interval has elapsed. State is just the last
 * run time (and, after a long run, where to carry on) - losing it on a restart means one extra, harmless, idempotent pass.
 */
export function reconcileJob(db: Db, log: (msg: string, detail?: unknown) => void, intervalMs = RECONCILE_DEFAULT_INTERVAL_MS): DueJob {
  let last = 0;
  let resume: ReconcileCursor | null = null;
  return {
    name: "notification-reconcile",
    run: async (now) => {
      if (now.getTime() - last < intervalMs) return;
      const r = await reconcileAppointmentNotifications(db, now, { after: resume });
      last = now.getTime(); // only after the pass could read: a database blip retries on the next tick, not in 5 minutes
      resume = r.next;
      // Counts and visit ids only: nothing about a patient, a phone number or a message ever reaches the log.
      if (r.recovered > 0 || r.errors > 0) log("notification reconcile", { inspected: r.inspected, recovered: r.recovered, errors: r.errors, errorSamples: r.errorSamples });
      return { inspected: r.inspected, recovered: r.recovered, errors: r.errors };
    },
  };
}
