import type { ClinicHours, LogCallAppointmentInput } from "@pulseos/types";
import { clinicHoursError } from "@pulseos/ui";
import { instantToWallTime, wallTimeToInstant } from "@/lib/hospitalTime";

/**
 * The visit a person books from inside another form (Log Call, Log outcome): date, time and "confirmed with patient". ONE model for
 * every such form, so the rules and the wording cannot drift apart. Doctor / branch stay "" when the hospital has only one of each.
 */
export interface InlineAppointmentState {
  apptDate: string;
  apptTime: string;
  apptDoctorId: string;
  apptBranchId: string;
  /** The patient agreed to this slot → CONFIRMED (confirmation + reminder follow); off → only BOOKED, nothing is sent. */
  apptConfirmed: boolean;
}

/** Tomorrow, no time chosen yet, confirmed (the common case: the patient agrees while on the phone). */
export function initialInlineAppointment(now: Date, timeZone: string): InlineAppointmentState {
  const tomorrow = instantToWallTime(new Date(now.getTime() + 24 * 3_600_000), timeZone);
  return { apptDate: tomorrow.date, apptTime: "", apptDoctorId: "", apptBranchId: "", apptConfirmed: true };
}

/** The request body for the visit, or the first problem in plain words. Checked here so the typist sees it at once; the server stays the authority. */
export function buildInlineAppointment(state: InlineAppointmentState, timeZone: string, now: Date, hours: ClinicHours | null | undefined): { input: LogCallAppointmentInput } | { error: string } {
  if (!state.apptDate || !state.apptTime) return { error: "Choose the appointment date and time." };
  const closed = clinicHoursError(hours, state.apptDate, state.apptTime);
  if (closed) return { error: closed };
  const at = wallTimeToInstant(state.apptDate, state.apptTime, timeZone);
  if (!at) return { error: "Choose the appointment date and time." };
  if (at.getTime() < now.getTime() - 60_000) return { error: "That time has already passed. Choose a later time." };
  return {
    input: {
      scheduledAt: at.toISOString(),
      confirmed: state.apptConfirmed,
      ...(state.apptDoctorId ? { doctorId: state.apptDoctorId } : {}),
      ...(state.apptBranchId ? { branchId: state.apptBranchId } : {}),
    },
  };
}

/** What the primary button says: the action and whether the visit will be confirmed. */
export function appointmentSaveLabel(base: "call" | "outcome", confirmed: boolean): string {
  const what = base === "call" ? "Save call" : "Save outcome";
  return `${what} & ${confirmed ? "confirm" : "book"} appointment`;
}

/** Server refusals for a booking, in plain words (shared by every form that books inline). */
export const APPOINTMENT_SERVER_ERRORS: Record<string, string> = {
  appointment_time_in_past: "That time has already passed. Choose a later time.",
  outside_clinic_hours: "That time is outside clinic hours. Choose another.",
  resource_unavailable: "The doctor already has a patient at that time. Choose another time.",
  doctor_required: "Choose a doctor.",
  branch_required: "Choose a branch.",
  doctor_not_found: "That doctor is no longer available. Choose another.",
  branch_not_found: "That branch is no longer available. Choose another.",
  forbidden: "You don't have permission to book appointments.",
  outcome_disallows_appointment: "This outcome doesn't book a visit. Choose another outcome or another next step.",
};
