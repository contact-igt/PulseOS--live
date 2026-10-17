import { isValidPastDate, MAX_AGE_YEARS } from "../../lib/age.js";
import type { LeadChange, TaskPriority, UpdateLeadInput } from "@pulseos/types";

// The part of Edit Lead that needs no database: which submitted values really change, which are unacceptable, and
// the before/after record. The service adds what needs the hospital's data (phone identity, branch, owner, source,
// service, custom fields).

export interface PatientSnapshot {
  name: string | null;
  dateOfBirth: string | null;
  reportedAge: number | null;
  email: string | null;
  preferredLanguage: string;
  marketingConsent: boolean;
}

export interface JourneySnapshot {
  journeyType: string;
  priority: TaskPriority;
  notes: string | null;
}

export type Plan<TSet> = { ok: true; set: TSet; changes: LeadChange[] } | { ok: false; invalid: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed text; blank means "no value". */
export const cleanText = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const change = (field: string, label: string, from: string | null, to: string | null): LeadChange => ({ field, label, from, to });
const yesNo = (v: boolean) => (v ? "Yes" : "No");

export function planPatientUpdate(current: PatientSnapshot, patch: NonNullable<UpdateLeadInput["patient"]>, todayKey: string): Plan<Partial<PatientSnapshot>> {
  const set: Partial<PatientSnapshot> = {};
  const changes: LeadChange[] = [];
  const invalid: string[] = [];

  if (patch.name !== undefined) {
    const name = cleanText(patch.name);
    if (name !== current.name) {
      set.name = name;
      changes.push(change("name", "Name", current.name, name));
    }
  }
  if (patch.dateOfBirth !== undefined) {
    const dob = cleanText(patch.dateOfBirth);
    if (dob !== null && !isValidPastDate(dob, todayKey)) invalid.push("dateOfBirth");
    else if (dob !== current.dateOfBirth) {
      set.dateOfBirth = dob;
      changes.push(change("dateOfBirth", "Date of birth", current.dateOfBirth, dob));
    }
  }
  if (patch.age !== undefined) {
    if (patch.age !== null && (!Number.isInteger(patch.age) || patch.age < 0 || patch.age > MAX_AGE_YEARS)) invalid.push("age");
    else if (patch.age !== current.reportedAge) {
      set.reportedAge = patch.age;
      changes.push(change("age", "Age", current.reportedAge === null ? null : String(current.reportedAge), patch.age === null ? null : String(patch.age)));
    }
  }
  if (patch.email !== undefined) {
    const email = cleanText(patch.email);
    if (email !== null && !EMAIL.test(email)) invalid.push("email");
    else if (email !== current.email) {
      set.email = email;
      changes.push(change("email", "Email", current.email, email));
    }
  }
  if (patch.preferredLanguage !== undefined) {
    const language = cleanText(patch.preferredLanguage);
    if (!language) invalid.push("preferredLanguage");
    else if (language !== current.preferredLanguage) {
      set.preferredLanguage = language;
      changes.push(change("preferredLanguage", "Preferred language", current.preferredLanguage, language));
    }
  }
  if (patch.marketingConsent !== undefined && patch.marketingConsent !== current.marketingConsent) {
    set.marketingConsent = patch.marketingConsent;
    changes.push(change("marketingConsent", "Marketing consent", yesNo(current.marketingConsent), yesNo(patch.marketingConsent)));
  }

  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, set, changes };
}

/** Enquiry type, priority and notes. Notes can hold anything staff typed, so the record says they changed, never what they say. */
export function planJourneyUpdate(current: JourneySnapshot, patch: Pick<NonNullable<UpdateLeadInput["journey"]>, "journeyType" | "priority" | "notes">): Plan<Partial<JourneySnapshot>> {
  const set: Partial<JourneySnapshot> = {};
  const changes: LeadChange[] = [];
  const invalid: string[] = [];

  if (patch.journeyType !== undefined) {
    const type = cleanText(patch.journeyType);
    if (!type) invalid.push("journeyType");
    else if (type !== current.journeyType) {
      set.journeyType = type;
      changes.push(change("journeyType", "Enquiry", current.journeyType, type));
    }
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    set.priority = patch.priority;
    changes.push(change("priority", "Priority", current.priority, patch.priority));
  }
  if (patch.notes !== undefined) {
    const notes = cleanText(patch.notes);
    if (notes !== current.notes) {
      set.notes = notes;
      changes.push(change("notes", "Notes", current.notes ? "Had notes" : null, notes ? "Updated" : "Cleared"));
    }
  }

  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, set, changes };
}

export const summarizeChanges = (changes: LeadChange[]): string => `Changed: ${changes.map((c) => c.label).join(", ")}`;
