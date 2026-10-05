import { ApiError } from "@pulseos/api-client";
import { TREATMENT_STATUS_LABEL } from "@pulseos/ui";
import type { CalendarEvent } from "@pulseos/ui";
import type { TreatmentRow, TreatmentStatus } from "@pulseos/types";

export const TREATMENT_VIEWS = ["table", "pipeline", "calendar"] as const;
export type TreatmentView = (typeof TREATMENT_VIEWS)[number];

export const ALL_STATUSES: TreatmentStatus[] = ["ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED", "COMPLETED", "DECLINED", "CANCELLED"];

/**
 * Moves the Pipeline board offers. A subset of the server's VALID_TRANSITIONS
 * (apps/api/src/domain/treatment/treatment.service.ts) — the server stays the
 * authority and rejects anything else. Decline / Cancel are deliberately left
 * out: they take a patient out of the pipeline and keep their confirmation
 * dialog in the table.
 */
export const BOARD_MOVES: Partial<Record<TreatmentStatus, TreatmentStatus[]>> = {
  ADVISED: ["DECISION_PENDING", "ACCEPTED"],
  DECISION_PENDING: ["ACCEPTED"],
  ACCEPTED: ["SCHEDULED"],
  SCHEDULED: ["COMPLETED"],
};

export function allowedBoardMoves(status: TreatmentStatus): TreatmentStatus[] {
  return BOARD_MOVES[status] ?? [];
}

/** Every status column, plus LOST only when a row actually carries it — no row is ever left without a column. */
export function boardColumnKeys(rows: TreatmentRow[]): TreatmentStatus[] {
  const keys = [...ALL_STATUSES];
  for (const r of rows) if (!keys.includes(r.status)) keys.push(r.status);
  return keys;
}

export function countByStatus(rows: TreatmentRow[]): Partial<Record<TreatmentStatus, number>> {
  const counts: Partial<Record<TreatmentStatus, number>> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

/** Inline, specific copy for a rejected state change (shown on the card / above the table). */
export function moveErrorMessage(err: unknown, toLabel: string): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return `It changed elsewhere and can no longer move to ${toLabel}. Showing its latest state.`;
    if (err.status === 403) return "Your role can view treatments but not change their state.";
    if (err.status === 404) return "This treatment no longer exists.";
  }
  return "Could not save the change. Check your connection and try again.";
}

/**
 * Procedure Calendar data: ONLY treatments in Scheduled state that have a
 * planned date. Planned dates are points in time (no invented end).
 */
export function scheduledProcedures(rows: TreatmentRow[]): { events: CalendarEvent<TreatmentRow>[]; undated: number } {
  const scheduled = rows.filter((r) => r.status === "SCHEDULED");
  const events = scheduled
    .filter((r): r is TreatmentRow & { plannedDate: string } => !!r.plannedDate)
    .map((r) => ({
      id: r.id,
      start: r.plannedDate,
      title: r.patientName,
      subtitle: r.treatmentLabel,
      status: TREATMENT_STATUS_LABEL.SCHEDULED,
      tone: "primary" as const,
      data: r,
    }));
  return { events, undated: scheduled.length - events.length };
}

export interface TreatmentUrlFilters {
  status: TreatmentStatus | "";
  service: string;
  doctorId: string;
  ownerId: string;
  procedureId: string;
}

/** URL param names for the treatment filters (view/date/range belong to useViewState). */
export const TREATMENT_FILTER_PARAM: Record<keyof TreatmentUrlFilters, string> = {
  status: "state",
  service: "service",
  doctorId: "doctor",
  ownerId: "owner",
  procedureId: "procedure",
};

export function readTreatmentFilters(params: URLSearchParams): TreatmentUrlFilters {
  const rawState = params.get(TREATMENT_FILTER_PARAM.status);
  const knownStates: string[] = [...ALL_STATUSES, "LOST"];
  return {
    status: rawState && knownStates.includes(rawState) ? (rawState as TreatmentStatus) : "",
    service: params.get(TREATMENT_FILTER_PARAM.service) ?? "",
    doctorId: params.get(TREATMENT_FILTER_PARAM.doctorId) ?? "",
    ownerId: params.get(TREATMENT_FILTER_PARAM.ownerId) ?? "",
    procedureId: params.get(TREATMENT_FILTER_PARAM.procedureId) ?? "",
  };
}

/** Filter patch -> URL param patch (for replaceUrlParams). */
export function treatmentFilterPatch(patch: Partial<TreatmentUrlFilters>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch) as [keyof TreatmentUrlFilters, string | undefined][]) out[TREATMENT_FILTER_PARAM[key]] = value || undefined;
  return out;
}
