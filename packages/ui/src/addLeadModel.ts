import { INTERACTION_CHANNEL_LABEL, type CrmOutcomeVm, type CreateLeadInput, type InteractionChannel, type TaskPriority } from "@pulseos/types";

// The rules of the Add Lead form as pure functions: which next steps an outcome allows, whether the form can be saved,
// and the request it builds. The drawer only renders; nothing here touches React or the network.

export type NextStepKind = "callback" | "appointment" | "follow_up" | "none";

/** Channels staff can honestly record by hand. IVR is not among them: it only ever arrives from the phone system. */
export const LEAD_CHANNEL_OPTIONS: { key: InteractionChannel; label: string }[] = (["MANUAL_CALL", "WHATSAPP", "INSTAGRAM_DM", "FACEBOOK_DM", "WALK_IN"] as const).map((key) => ({
  key,
  label: key === "MANUAL_CALL" ? "Phone call" : INTERACTION_CHANNEL_LABEL[key],
}));

export interface LeadFormValues {
  patientId: string | undefined;
  phone: string;
  name: string;
  age: string;
  dateOfBirth: string;
  specialtyKey: string;
  journeyType: string;
  branchId: string;
  sourceKey: string;
  channel: InteractionChannel | "";
  outcomeKey: string;
  outcomeReason: string;
  nextStep: NextStepKind;
  callbackDate: string;
  callbackTime: string;
  callbackOwner: string;
  callbackNote: string;
  apptDate: string;
  apptTime: string;
  apptDoctorId: string;
  apptBranchId: string;
  apptNote: string;
  followUpDate: string;
  followUpTime: string;
  followUpNote: string;
  callEnabled: boolean;
  callDirection: "inbound" | "outbound";
  callConnected: boolean;
  callMinutes: string;
  callNote: string;
  email: string;
  preferredLanguage: string;
  doctorId: string;
  campaignId: string;
  ownerId: string;
  priority: TaskPriority;
  notes: string;
  customFieldValues: Record<string, unknown>;
}

export interface NextStepAvailability {
  callback: boolean;
  follow_up: boolean;
  appointment: boolean;
  none: boolean;
  /** Why an option is closed, in plain words. */
  hint?: string;
}

/** What the chosen outcome allows next. No outcome yet: everything. */
export function nextStepAvailability(outcome: CrmOutcomeVm | undefined): NextStepAvailability {
  if (!outcome) return { callback: true, follow_up: true, appointment: true, none: true };
  if (outcome.stage === "lost") return { callback: false, follow_up: false, appointment: false, none: true, hint: "This outcome closes the journey, so there is no next step." };
  if (outcome.requiresFollowUp) return { callback: true, follow_up: true, appointment: false, none: false, hint: "This outcome needs a follow-up: add when to call back." };
  if (!outcome.allowsAppointment) return { callback: true, follow_up: true, appointment: false, none: true, hint: "This outcome can't have an appointment." };
  return { callback: true, follow_up: true, appointment: true, none: true };
}

/** Keeps the current next step when the outcome allows it, otherwise the nearest allowed one. */
export function reconcileNextStep(current: NextStepKind, outcome: CrmOutcomeVm | undefined): NextStepKind {
  const a = nextStepAvailability(outcome);
  if (a[current]) return current;
  return (["callback", "follow_up", "none", "appointment"] as const).find((k) => a[k]) ?? "none";
}

const hasPhoneDigits = (p: string) => p.replace(/\D/g, "").length >= 6;
const wall = (date: string, time: string) => (date && time ? `${date}T${time}` : "");

export interface ReadinessContext {
  /** The hospital's current wall time ("YYYY-MM-DDTHH:mm"). */
  nowLocal: string;
  outcome?: CrmOutcomeVm;
  /** Keys of required CRM fields configured for Add Lead (in this service). */
  requiredFieldKeys: string[];
  hasAppointmentDoctors: boolean;
}

/** Can this form be saved, and if not, what is missing — in words a person can act on. */
export function saveReadiness(f: LeadFormValues, ctx: ReadinessContext): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!hasPhoneDigits(f.phone)) reasons.push("Add the patient's phone number.");
  if (!f.specialtyKey) reasons.push("Choose the service they asked about.");
  if (!f.sourceKey) reasons.push("Choose where they came from.");
  if (!f.branchId) reasons.push("Choose a branch.");

  const needsFollowUp = !!ctx.outcome?.requiresFollowUp;
  if (needsFollowUp && f.nextStep !== "callback" && f.nextStep !== "follow_up") reasons.push("This outcome needs a follow-up: add when to call back.");

  const future = (at: string, what: string) => {
    if (!at) reasons.push(`Add the ${what} date and time.`);
    else if (at < ctx.nowLocal) reasons.push(`Choose a future ${what} time.`);
  };
  if (f.nextStep === "callback") future(wall(f.callbackDate, f.callbackTime), "callback");
  if (f.nextStep === "follow_up") future(wall(f.followUpDate, f.followUpTime), "follow-up");
  if (f.nextStep === "appointment") {
    if (!f.apptDoctorId) reasons.push("Choose a doctor for the appointment.");
    future(wall(f.apptDate, f.apptTime), "appointment");
  }
  for (const key of ctx.requiredFieldKeys) {
    const v = f.customFieldValues[key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      reasons.push("Fill in the required details.");
      break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const blank = (s: string) => s.trim() || undefined;

/** The request: hospital wall times, and only the details that apply to the chosen next step and channel. */
export function toCreateLeadInput(f: LeadFormValues, ctx: { normalizeFields: (v: Record<string, unknown>) => Record<string, unknown> | undefined }): CreateLeadInput {
  let nextStep: CreateLeadInput["nextStep"];
  if (f.nextStep === "callback") nextStep = { kind: "callback", dueAt: wall(f.callbackDate, f.callbackTime), ...(f.callbackOwner ? { assignedTo: f.callbackOwner } : {}), ...(blank(f.callbackNote) ? { note: blank(f.callbackNote) } : {}) };
  else if (f.nextStep === "follow_up") nextStep = { kind: "follow_up", dueAt: wall(f.followUpDate, f.followUpTime), ...(blank(f.followUpNote) ? { note: blank(f.followUpNote) } : {}) };
  else if (f.nextStep === "appointment") nextStep = { kind: "appointment", scheduledAt: wall(f.apptDate, f.apptTime), doctorId: f.apptDoctorId, ...(f.apptBranchId ? { branchId: f.apptBranchId } : {}), ...(blank(f.apptNote) ? { note: blank(f.apptNote) } : {}) };
  else nextStep = { kind: "none" };

  const minutes = f.callMinutes.trim() === "" ? undefined : Math.max(0, Math.round(Number(f.callMinutes) * 60));
  const call: CreateLeadInput["call"] =
    f.channel === "MANUAL_CALL" && f.callEnabled
      ? { direction: f.callDirection, connected: f.callConnected, durationSeconds: f.callConnected && minutes !== undefined && Number.isFinite(minutes) ? minutes : undefined, ...(blank(f.callNote) ? { note: blank(f.callNote) } : {}) }
      : undefined;

  return {
    patientId: f.patientId,
    name: blank(f.name),
    age: f.age.trim() ? Number(f.age) : undefined,
    dateOfBirth: f.dateOfBirth || undefined,
    phone: f.phone.trim(),
    email: blank(f.email),
    preferredLanguage: blank(f.preferredLanguage),
    specialtyKey: f.specialtyKey,
    branchId: f.branchId,
    doctorId: f.doctorId || undefined,
    sourceKey: f.sourceKey,
    channel: f.channel || undefined,
    campaignId: f.campaignId || undefined,
    journeyType: f.journeyType.trim(),
    ownerId: f.ownerId || undefined,
    priority: f.priority,
    notes: blank(f.notes),
    customFieldValues: ctx.normalizeFields(f.customFieldValues),
    outcomeKey: f.outcomeKey || undefined,
    ...(f.outcomeKey && blank(f.outcomeReason) ? { outcomeReason: blank(f.outcomeReason) } : {}),
    nextStep,
    call,
  };
}

/** What the person should do next — a sentence, never a status code, never who holds the other slot. */
export const LEAD_ERROR_COPY: Record<string, string> = {
  appointment_time_in_past: "Choose a future appointment time.",
  outside_clinic_hours: "That time is outside the clinic's hours. Choose a time inside them.",
  resource_unavailable: "This doctor already has another appointment at this time. Choose a different time or doctor.",
  doctor_not_found: "Choose a doctor for the appointment.",
  branch_not_found: "Choose a valid branch for the appointment.",
  due_in_past: "Choose a future time for the follow-up.",
  assignee_invalid: "Choose a valid team member for this follow-up.",
  follow_up_required: "This outcome needs a follow-up: add when to call back.",
  outcome_closes_journey: "A lost outcome has no next step. Choose “No follow-up”.",
  outcome_disallows_appointment: "This outcome can't have an appointment. Choose another next step or outcome.",
  outcome_not_found: "That outcome is no longer available. Choose another.",
  missing_required_fields: "Fill in the required details, then save again.",
  invalid_field_values: "Check the highlighted details, then save again.",
  type_invalid: "That follow-up type isn't available. Ask an admin to check Settings → Follow-up Types.",
  note_required: "Add a note for this follow-up.",
  invalid_request: "Check the dates and times, then save again.",
};
