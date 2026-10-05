import {
  DEFAULT_FIELD_PLACEMENTS,
  FIELD_PLACEMENTS,
  type CreateCrmFieldInput,
  type CrmFieldVm,
  type CustomFieldType,
  type FieldGroupKey,
  type FieldPlacement,
  type FieldRule,
  type FieldVisibility,
  type UpdateCrmFieldInput,
} from "@pulseos/types";

// Pure helpers behind the CRM field editor: what the form holds, how it maps to the API, and what can
// be said about it before the server does. No raw JSON ever reaches the admin.

export interface FieldForm {
  specialtyKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
  groupKey: FieldGroupKey;
  placements: FieldPlacement[];
  visibleTo: FieldVisibility;
  /** The default value as the admin types it; parsed by type on save. */
  defaultText: string;
  /** Existing fields keep their key; a new field's key is generated from its label. */
  key: string | null;
  readOnly: boolean;
  filterable: boolean;
  carryForward: boolean;
  rules: FieldRule[];
}

const CHOICE = new Set<CustomFieldType>(["SELECT", "MULTI_SELECT"]);
export const isChoiceType = (t: CustomFieldType) => CHOICE.has(t);

/** Lowercase, underscores, starts with a letter, at most 48 characters — the API's key rule. */
export function slugifyKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
  if (!slug) return "";
  return /^[a-z]/.test(slug) ? slug : `f_${slug}`.slice(0, 48);
}

export function blankField(specialtyKey: string): FieldForm {
  return { specialtyKey, label: "", fieldType: "TEXT", options: [], required: false, groupKey: "enquiry_details", placements: [...DEFAULT_FIELD_PLACEMENTS], visibleTo: "everyone", defaultText: "", key: null, readOnly: false, filterable: false, carryForward: false, rules: [] };
}

export function defaultToText(type: CustomFieldType, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (type === "BOOLEAN") return value === true ? "true" : value === false ? "false" : "";
  return String(value);
}

export function defaultFromText(type: CustomFieldType, text: string): unknown {
  const t = text.trim();
  if (t === "") return null;
  if (type === "NUMBER") return Number(t);
  if (type === "BOOLEAN") return t === "true";
  if (type === "MULTI_SELECT") return t.split(",").map((s) => s.trim()).filter(Boolean);
  return t;
}

export function fieldToForm(f: CrmFieldVm): FieldForm {
  return {
    specialtyKey: f.specialtyKey,
    label: f.label,
    fieldType: f.fieldType,
    options: f.options ?? [],
    required: f.required,
    groupKey: f.groupKey,
    placements: f.placements,
    visibleTo: f.visibleTo,
    defaultText: defaultToText(f.fieldType, f.defaultValue),
    key: f.key,
    readOnly: f.readOnly,
    filterable: f.filterable,
    carryForward: f.carryForward,
    rules: f.rules,
  };
}

/** Trimmed, de-duplicated, blanks removed — in the order the admin arranged them. */
export const cleanOptions = (options: string[]): string[] => [...new Set(options.map((o) => o.trim()).filter(Boolean))];

export function formToCreateInput(f: FieldForm): CreateCrmFieldInput {
  const label = f.label.trim();
  return {
    specialtyKey: f.specialtyKey,
    key: f.key ?? slugifyKey(label),
    label,
    fieldType: f.fieldType,
    options: isChoiceType(f.fieldType) ? cleanOptions(f.options) : undefined,
    required: f.required,
    groupKey: f.groupKey,
    placements: f.placements,
    defaultValue: defaultFromText(f.fieldType, f.defaultText),
    visibleTo: f.visibleTo,
    readOnly: f.readOnly,
    filterable: filterableAllowed(f) && f.filterable,
    carryForward: carryForwardAllowed(f) && f.carryForward,
    rules: f.rules,
  };
}

/** An edit never sends the key or the service: those are fixed once a field exists. */
export function formToUpdateInput(f: FieldForm): UpdateCrmFieldInput {
  return {
    label: f.label.trim(),
    fieldType: f.fieldType,
    options: isChoiceType(f.fieldType) ? cleanOptions(f.options) : undefined,
    required: f.required,
    groupKey: f.groupKey,
    placements: f.placements,
    defaultValue: defaultFromText(f.fieldType, f.defaultText),
    visibleTo: f.visibleTo,
    readOnly: f.readOnly,
    filterable: filterableAllowed(f) && f.filterable,
    carryForward: carryForwardAllowed(f) && f.carryForward,
    rules: f.rules,
  };
}

/** Only choice and Yes/No fields can be filtered on (a free-text answer has nothing to pick from). */
export const filterableAllowed = (f: Pick<FieldForm, "fieldType">) => f.fieldType === "SELECT" || f.fieldType === "MULTI_SELECT" || f.fieldType === "BOOLEAN";
/** Carrying a value forward only makes sense on a form that asks for it again. */
export const carryForwardAllowed = (f: Pick<FieldForm, "placements">) => f.placements.includes("add_lead") || f.placements.includes("followup_outcome");

export function validateFieldForm(f: FieldForm, opts: { editing?: boolean } = {}): string | null {
  if (!f.label.trim()) return "Give the field a label.";
  if (!opts.editing && !slugifyKey(f.label)) return "The label needs some letters or numbers.";
  if (isChoiceType(f.fieldType) && cleanOptions(f.options).length === 0) return "Add at least one option.";
  if (f.placements.length === 0) return "Choose where this field should appear.";
  if (f.rules.length > 5) return "A field can have at most 5 rules.";
  return null;
}

const PLACEMENT_LABEL = new Map(FIELD_PLACEMENTS.map((p) => [p.key, p.label]));
export function placementSummary(placements: FieldPlacement[]): string {
  if (placements.length === 0) return "Nowhere";
  const names = placements.map((p) => PLACEMENT_LABEL.get(p) ?? p);
  return names.join(" · ");
}
