import type { ScheduleSurgeryInput, TreatmentDefinitionVm } from "@pulseos/types";
import { instantToWallTime, wallTimeToInstant } from "@/lib/hospitalTime";

export interface SurgeryFormState {
  treatmentDefinitionId: string;
  date: string;
  time: string;
  resourceId: string;
  branchId: string;
  note: string;
}

/**
 * The procedures offered for a Journey: the tenant's active catalogue narrowed to that Journey's service when the
 * catalogue has entries for it, else the whole catalogue — a hospital's own configuration, never hard-coded options.
 */
export function proceduresFor(catalog: TreatmentDefinitionVm[], serviceKey: string | null | undefined): TreatmentDefinitionVm[] {
  const forService = serviceKey ? catalog.filter((d) => d.specialtyKey === serviceKey) : [];
  return forService.length > 0 ? forService : catalog;
}

/** Procedure unchosen (staff pick); date and time unchosen; doctor and branch pre-filled from the appointment. */
export function initialSurgeryForm(defaults: { resourceId?: string | null; branchId?: string | null }): SurgeryFormState {
  return { treatmentDefinitionId: "", date: "", time: "", resourceId: defaults.resourceId ?? "", branchId: defaults.branchId ?? "", note: "" };
}

export function buildSurgeryInput(state: SurgeryFormState, timeZone: string, now: Date): { input: ScheduleSurgeryInput } | { error: string } {
  if (!state.treatmentDefinitionId) return { error: "Choose the procedure." };
  if (!state.date || !state.time) return { error: "Choose the surgery date and time." };
  const at = wallTimeToInstant(state.date, state.time, timeZone);
  if (!at) return { error: "Choose the surgery date and time." };
  if (at.getTime() <= now.getTime()) return { error: "Pick a surgery time in the future." };
  if (!state.resourceId) return { error: "Choose the doctor." };
  if (!state.branchId) return { error: "Choose the branch." };
  const note = state.note.trim();
  return { input: { treatmentDefinitionId: state.treatmentDefinitionId, scheduledAt: at.toISOString(), resourceId: state.resourceId, branchId: state.branchId, ...(note ? { note } : {}) } };
}

/** Pre-fill a reschedule with the surgery's current time in the hospital's clock. */
export function rescheduleSurgeryDefaults(plannedDate: string | null, timeZone: string): { date: string; time: string } {
  return plannedDate ? instantToWallTime(new Date(plannedDate), timeZone) : { date: "", time: "" };
}

/** A reschedule keeps the procedure: just when, with whom and where. */
export function buildSurgeryReschedule(state: SurgeryFormState, timeZone: string, now: Date): { input: { scheduledAt: string; resourceId: string; branchId: string; note?: string } } | { error: string } {
  const built = buildSurgeryInput({ ...state, treatmentDefinitionId: "keep" }, timeZone, now);
  if ("error" in built) return built;
  const { scheduledAt, resourceId, branchId, note } = built.input;
  return { input: { scheduledAt, resourceId, branchId, ...(note ? { note } : {}) } };
}
