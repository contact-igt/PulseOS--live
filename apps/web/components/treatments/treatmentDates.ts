import type { TreatmentRow } from "@pulseos/types";

// Three different dates, three different words — never one "procedure date":
//   Scheduled for → plannedDate (the procedure calendar)
//   Completed on  → completedAt (stamped when the treatment was completed)
//   Payment date  → a revenue event (shown on revenue screens, not here)
// A legacy row may lack one of them; it says so instead of showing a made-up date or breaking.

export const DATE_NOT_RECORDED = "Date not recorded";
export const DOCTOR_NOT_RECORDED = "Doctor not recorded";

export interface TreatmentDateLine {
  label: "Scheduled for" | "Completed on";
  /** "10 Oct" style date, or DATE_NOT_RECORDED. */
  text: string;
  recorded: boolean;
}

/** The one date line a treatment shows for its status; null for statuses that have none (advised, declined…). */
export function treatmentDateLine(row: Pick<TreatmentRow, "status" | "plannedDate" | "completedAt">, formatDate: (iso: string) => string): TreatmentDateLine | null {
  if (row.status === "SCHEDULED") return { label: "Scheduled for", text: row.plannedDate ? formatDate(row.plannedDate) : DATE_NOT_RECORDED, recorded: !!row.plannedDate };
  if (row.status === "COMPLETED") return { label: "Completed on", text: row.completedAt ? formatDate(row.completedAt) : DATE_NOT_RECORDED, recorded: !!row.completedAt };
  return null;
}

/** Who a scheduled/completed procedure is with; "Doctor not recorded" for a legacy row, "—" before one is expected. */
export function treatmentDoctorLabel(row: Pick<TreatmentRow, "status" | "resourceName" | "doctorName">): string {
  const name = row.resourceName ?? row.doctorName;
  if (name) return name;
  return row.status === "SCHEDULED" || row.status === "COMPLETED" ? DOCTOR_NOT_RECORDED : "—";
}
