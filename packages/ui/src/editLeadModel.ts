import type { LeadEditModel, TaskPriority, UpdateLeadInput } from "@pulseos/types";
import { hospitalLocalInput } from "./format";

// The pure half of Edit Lead: the form's values, which of them differ from what the server holds, and the request.
// Only changed fields are sent, and only the groups this person may change (the server checks again).

export interface EditLeadForm {
  name: string;
  dateOfBirth: string;
  /** Typed as text; a number on the way out. */
  age: string;
  phone: string;
  email: string;
  preferredLanguage: string;
  branchId: string;
  marketingConsent: boolean;
  journeyType: string;
  specialtyKey: string;
  sourceKey: string;
  sourceReason: string;
  priority: TaskPriority;
  notes: string;
  /** "" = unassigned. */
  ownerId: string;
  customFieldValues: Record<string, unknown>;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function toEditForm(model: LeadEditModel): EditLeadForm {
  const values: Record<string, unknown> = {};
  for (const f of model.fields) {
    const v = model.fieldValues[f.key];
    if (isEmpty(v)) continue;
    // The picker holds hospital wall time; the stored value is an instant.
    values[f.key] = f.fieldType === "DATETIME" && typeof v === "string" ? hospitalLocalInput(v) : v;
  }
  return {
    name: model.patient.name ?? "",
    dateOfBirth: model.patient.dateOfBirth ?? "",
    age: model.patient.age === null ? "" : String(model.patient.age),
    phone: model.patient.phone,
    email: model.patient.email ?? "",
    preferredLanguage: model.patient.preferredLanguage,
    branchId: model.patient.branchId ?? "",
    marketingConsent: model.patient.marketingConsent,
    journeyType: model.journey.journeyType,
    specialtyKey: model.journey.specialtyKey ?? "",
    sourceKey: model.journey.sourceKey ?? "",
    sourceReason: "",
    priority: model.journey.priority,
    notes: model.journey.notes ?? "",
    ownerId: model.journey.ownerId ?? "",
    customFieldValues: values,
  };
}

const text = (s: string) => s.trim();
const orNull = (s: string) => text(s) || null;

/** The request for what changed, or null when nothing did. */
export function toUpdateLeadInput(model: LeadEditModel, form: EditLeadForm): UpdateLeadInput | null {
  const initial = toEditForm(model);
  const { can } = model;

  const patient: NonNullable<UpdateLeadInput["patient"]> = {};
  if (can.editPatient) {
    if (text(form.name) !== text(initial.name)) patient.name = orNull(form.name);
    if (form.dateOfBirth !== initial.dateOfBirth) patient.dateOfBirth = orNull(form.dateOfBirth);
    if (text(form.age) !== text(initial.age)) patient.age = text(form.age) === "" ? null : Number(form.age);
    if (text(form.phone) !== text(initial.phone)) patient.phone = text(form.phone);
    if (text(form.email) !== text(initial.email)) patient.email = orNull(form.email);
    if (text(form.preferredLanguage) !== text(initial.preferredLanguage)) patient.preferredLanguage = text(form.preferredLanguage);
    if (form.branchId !== initial.branchId) patient.branchId = form.branchId || null;
    if (form.marketingConsent !== initial.marketingConsent) patient.marketingConsent = form.marketingConsent;
  }

  const journey: NonNullable<UpdateLeadInput["journey"]> = {};
  if (can.editJourney) {
    if (text(form.journeyType) !== text(initial.journeyType)) journey.journeyType = text(form.journeyType);
    if (form.specialtyKey !== initial.specialtyKey && form.specialtyKey) journey.specialtyKey = form.specialtyKey;
    if (form.priority !== initial.priority) journey.priority = form.priority;
    if (text(form.notes) !== text(initial.notes)) journey.notes = orNull(form.notes);
  }
  if (can.changeOwner && form.ownerId !== initial.ownerId) journey.ownerId = form.ownerId || null;
  if (can.changeSource && form.sourceKey !== initial.sourceKey && form.sourceKey) {
    journey.sourceKey = form.sourceKey;
    journey.sourceReason = text(form.sourceReason);
  }

  const customFieldValues: Record<string, unknown> = {};
  if (can.editJourney) {
    for (const f of model.fields) {
      const now = form.customFieldValues[f.key];
      const before = initial.customFieldValues[f.key];
      if (isEmpty(now) && isEmpty(before)) continue;
      if (JSON.stringify(now ?? null) === JSON.stringify(before ?? null)) continue;
      customFieldValues[f.key] = isEmpty(now) ? "" : f.fieldType === "DATETIME" && typeof now === "string" ? new Date(now).toISOString() : now;
    }
  }

  const has = (o: object) => Object.keys(o).length > 0;
  if (!has(patient) && !has(journey) && !has(customFieldValues)) return null;
  return { versions: model.versions, ...(has(patient) ? { patient } : {}), ...(has(journey) ? { journey } : {}), ...(has(customFieldValues) ? { customFieldValues } : {}) };
}

/** Can this be saved, and if not, what is missing — in words a person can act on. */
export function editReadiness(model: LeadEditModel, form: EditLeadForm): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (model.can.editPatient && form.phone.replace(/\D/g, "").length < 6) reasons.push("Add the patient's phone number.");
  if (model.can.editJourney && !text(form.journeyType)) reasons.push("Add what the patient enquired about.");
  if (model.can.changeSource && form.sourceKey && form.sourceKey !== (model.journey.sourceKey ?? "") && !text(form.sourceReason)) reasons.push("Say why the original source is being changed.");
  if (model.can.editJourney && model.fields.some((f) => f.required && isEmpty(form.customFieldValues[f.key]))) reasons.push("Fill in the required details.");
  return { ok: reasons.length === 0, reasons };
}

/** What the person should do next — a sentence, never a status code. */
export const EDIT_LEAD_ERROR_COPY: Record<string, string> = {
  stale_version: "Someone else changed this lead while you were editing. Your changes were not saved — reopen it to see the latest.",
  phone_in_use: "That phone number already belongs to another patient. Two patients can't share a number.",
  forbidden_field_group: "You don't have permission to change one of these details.",
  missing_required_fields: "Fill in the required details, then save again.",
  invalid_field_values: "Check the details, then save again.",
  invalid_request: "Check the details, then save again.",
  lead_not_found: "This lead is no longer available.",
};
