import type { CreateFollowUpInput, FollowUpTypeVm, TaskPriority } from "@pulseos/types";
import { instantToWallTime, wallTimeToInstant } from "@/lib/hospitalTime";

/** "" = use the type's own default; this sentinel = deliberately nobody. */
export const NO_OWNER = "__none__";

export interface FollowUpFormState {
  typeId: string;
  date: string;
  time: string;
  /** "" (type default) | NO_OWNER | a user id */
  ownerId: string;
  /** "" (type default) | "normal" | "high" */
  priority: "" | TaskPriority;
  note: string;
}

/** The tenant's default type is General Follow-up; failing that, the first type offered. */
export function defaultType(types: FollowUpTypeVm[]): FollowUpTypeVm | null {
  return types.find((t) => t.key === "general_followup") ?? types[0] ?? null;
}

/** Empty date and time: staff choose when — nothing is assumed. */
export function initialFollowUpForm(types: FollowUpTypeVm[], preset?: { typeKey?: string }): FollowUpFormState {
  const type = (preset?.typeKey ? types.find((t) => t.key === preset.typeKey) : null) ?? defaultType(types);
  return { typeId: type?.id ?? "", date: "", time: "", ownerId: "", priority: "", note: "" };
}

export function buildFollowUpInput(state: FollowUpFormState, types: FollowUpTypeVm[], timeZone: string, now: Date): { input: CreateFollowUpInput } | { error: string } {
  const type = types.find((t) => t.id === state.typeId);
  if (!type) return { error: "Choose a follow-up type." };
  if (!state.date || !state.time) return { error: "Choose the date and time." };
  const due = wallTimeToInstant(state.date, state.time, timeZone);
  if (!due) return { error: "Choose the date and time." };
  if (due.getTime() <= now.getTime()) return { error: "Pick a time in the future." };
  const note = state.note.trim();
  if (type.requiresNote && !note) return { error: `${type.label} needs a note — say what's happening.` };
  return {
    input: {
      followUpTypeId: type.id,
      dueAt: due.toISOString(),
      ...(state.ownerId === NO_OWNER ? { assignedTo: null } : state.ownerId ? { assignedTo: state.ownerId } : {}),
      ...(state.priority ? { priority: state.priority } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/** A reschedule is a new future time in the hospital's clock, with an optional reason. */
export function buildReschedule(date: string, time: string, note: string, timeZone: string, now: Date): { dueAt: string; note?: string } | { error: string } {
  const due = wallTimeToInstant(date, time, timeZone);
  if (!date || !time || !due) return { error: "Choose the new date and time." };
  if (due.getTime() <= now.getTime()) return { error: "Pick a time in the future." };
  return { dueAt: due.toISOString(), ...(note.trim() ? { note: note.trim() } : {}) };
}

/** Pre-fill a reschedule with the task's current time, moved to tomorrow when that has already passed. */
export function rescheduleDefaults(currentDueAt: string, timeZone: string, now: Date): { date: string; time: string } {
  const due = new Date(currentDueAt);
  const base = due.getTime() > now.getTime() ? due : new Date(now.getTime() + 24 * 3_600_000);
  const wall = instantToWallTime(base, timeZone);
  return { date: wall.date, time: due.getTime() > now.getTime() ? wall.time : instantToWallTime(due, timeZone).time };
}
