import type { OperationsKpis, ReportQuery } from "@pulseos/types";

// Rates for the Analytics workspace. Every rate says what it is divided by; no denominator means no rate (null), never
// 0% or NaN. A cancelled visit was never expected to happen, so it is not in the attendance / no-show denominator.

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** Visits the hospital expected to happen: scheduled in the period, not cancelled. */
const expected = (k: OperationsKpis) => k.appointmentsScheduled - k.appointmentsCancelled;

/** Checked in ÷ (scheduled − cancelled). */
export const attendanceRate = (k: OperationsKpis) => ratio(k.appointmentsAttended, expected(k));
/** No-shows ÷ (scheduled − cancelled). */
export const noShowRate = (k: OperationsKpis) => ratio(k.appointmentsNoShow, expected(k));
/** Consultations completed ÷ patients who checked in. */
export const consultationRate = (k: OperationsKpis) => ratio(k.consultationsCompleted, k.appointmentsAttended);
/** Follow-ups completed ÷ (completed + still due) in the period. */
export const followUpCompletionRate = (k: OperationsKpis) => ratio(k.followUpsCompleted, k.followUpsCompleted + k.followUpsDue);

/** Drilling into one day of the daily view: a one-day custom range. */
export function drillDay(day: string): Pick<ReportQuery, "range" | "from" | "to"> {
  return { range: "custom", from: day, to: day };
}
