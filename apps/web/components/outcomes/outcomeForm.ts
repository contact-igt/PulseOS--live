import { instantToWallTime, wallTimeToInstant } from "../../lib/hospitalTime";
import { normalizeFieldValues } from "@pulseos/ui";
import { buildInlineAppointment, type InlineAppointmentState } from "@/components/appointments/inlineAppointment";
import type { ClinicHours, CreateCrmOutcomeInput, CrmOutcomeVm, CustomFieldDefinitionVm, LogInteractionInput, OutcomeStage, TaskType, UpdateCrmOutcomeInput } from "@pulseos/types";
import { slugifyKey } from "@/components/settings/crmFieldForm";

/** tenants.timezone default — callers pass the session's zone. */
const DEFAULT_TZ = "Asia/Kolkata";

// Pure helpers behind the outcome editor (Settings → Workflow Outcomes) and the "Log outcome" form.

export interface OutcomeForm {
  label: string;
  stage: OutcomeStage;
  requiresFollowUp: boolean;
  allowsAppointment: boolean;
  asksReason: boolean;
  followUpType: TaskType;
  key: string | null;
}

export const blankOutcome = (): OutcomeForm => ({ label: "", stage: "contacted", requiresFollowUp: false, allowsAppointment: false, asksReason: false, followUpType: "FOLLOW_UP", key: null });

export const outcomeToForm = (o: CrmOutcomeVm): OutcomeForm => ({ label: o.label, stage: o.stage, requiresFollowUp: o.requiresFollowUp, allowsAppointment: o.allowsAppointment, asksReason: o.asksReason, followUpType: o.followUpType, key: o.key });

export const formToCreateInput = (f: OutcomeForm): CreateCrmOutcomeInput => ({
  key: f.key ?? slugifyKey(f.label),
  label: f.label.trim(),
  stage: f.stage,
  requiresFollowUp: f.requiresFollowUp,
  allowsAppointment: f.allowsAppointment,
  asksReason: f.asksReason,
  followUpType: f.followUpType,
});

/** An edit never sends the key: it is fixed once the outcome exists. */
export const formToUpdateInput = (f: OutcomeForm): UpdateCrmOutcomeInput => ({
  label: f.label.trim(),
  stage: f.stage,
  requiresFollowUp: f.requiresFollowUp,
  allowsAppointment: f.allowsAppointment,
  asksReason: f.asksReason,
  followUpType: f.followUpType,
});

export function validateOutcomeForm(f: OutcomeForm, opts: { editing?: boolean } = {}): string | null {
  if (!f.label.trim()) return "Give the outcome a label.";
  if (!opts.editing && !slugifyKey(f.label)) return "The label needs some letters or numbers.";
  return null;
}

/** What logging this outcome will do, in plain words. Empty when it does nothing special. */
export function outcomeHint(o: CrmOutcomeVm): string {
  const parts: string[] = [];
  if (o.requiresFollowUp) parts.push("Needs a follow-up date and time");
  if (o.stage === "lost") parts.push("Closes the journey as lost");
  if (o.asksReason) parts.push("asks why");
  if (o.allowsAppointment) parts.push("Offers to book an appointment");
  // "Closes the journey as lost · asks why" reads as one sentence; keep the capitalised lead item.
  return parts.join(" · ");
}

export interface LogState {
  note: string;
  reason: string;
  /** Optional follow-up the person chose to schedule (outcomes that do not require one). */
  scheduleFollowUp: boolean;
  /** datetime-local value (the hospital clock the person sees). */
  followUpLocal: string;
  fieldValues: Record<string, unknown>;
  /** Book the visit in this same save (only offered when the outcome allows appointments). It is the next step: no follow-up time. */
  bookAppointment?: boolean;
  appt?: InlineAppointmentState;
}

export function buildLogInput(
  outcome: CrmOutcomeVm | null,
  state: LogState,
  fields: CustomFieldDefinitionVm[],
  now: Date,
  taskId?: string,
  timeZone: string = DEFAULT_TZ,
  hours?: ClinicHours | null,
): { input: LogInteractionInput } | { error: string } {
  if (!outcome) return { error: "Choose what happened." };
  const booking = !!state.bookAppointment && outcome.allowsAppointment && !!state.appt;
  let appointment: LogInteractionInput["appointment"];
  if (booking) {
    const built = buildInlineAppointment(state.appt!, timeZone, now, hours);
    if ("error" in built) return built;
    appointment = built.input;
  }
  // A booked visit is the next step: no follow-up time is asked for or sent.
  const wantsFollowUp = !booking && (outcome.requiresFollowUp || state.scheduleFollowUp);
  let followUpAt: string | undefined;
  if (wantsFollowUp) {
    if (!state.followUpLocal) return { error: "Choose when to follow up." };
    // The picker shows hospital wall time ("2026-10-02T17:00" = 17:00 in the hospital), whatever the browser's zone.
    const [date, time] = state.followUpLocal.split("T");
    const at = date && time ? wallTimeToInstant(date, time.slice(0, 5), timeZone) : null;
    if (!at) return { error: "Choose when to follow up." };
    if (at.getTime() <= now.getTime()) return { error: "Pick a follow-up time in the future." };
    followUpAt = at.toISOString();
  }
  const missing = fields.filter((f) => f.required && (state.fieldValues[f.key] === undefined || state.fieldValues[f.key] === "" || (Array.isArray(state.fieldValues[f.key]) && (state.fieldValues[f.key] as unknown[]).length === 0)));
  if (missing.length > 0) return { error: `Fill in: ${missing.map((f) => f.label).join(", ")}.` };

  const note = state.note.trim();
  const reason = outcome.asksReason ? state.reason.trim() : "";
  const fieldValues = normalizeFieldValues(fields, state.fieldValues);
  return {
    input: {
      outcomeKey: outcome.key,
      ...(note ? { note } : {}),
      ...(reason ? { reason } : {}),
      ...(followUpAt ? { followUpAt } : {}),
      ...(appointment ? { appointment } : {}),
      ...(taskId ? { taskId } : {}),
      ...(fieldValues ? { fieldValues } : {}),
    },
  };
}

/** A sensible suggestion for the follow-up picker: tomorrow (in the hospital) at 10:00, as a datetime-local value. */
export function defaultFollowUpLocal(now: Date, timeZone: string = DEFAULT_TZ): string {
  const today = instantToWallTime(now, timeZone).date;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${tomorrow}T10:00`;
}
