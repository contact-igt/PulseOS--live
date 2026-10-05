import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { crmOutcomes, customFieldDefinitions, customFieldValues, specialtyTemplates } from "../../db/schema.js";
import {
  ALL_SERVICES_KEY,
  CUSTOM_FIELD_TYPES,
  DEFAULT_FIELD_PLACEMENTS,
  FIELD_GROUPS,
  FIELD_PLACEMENTS,
  FIELD_VISIBILITY,
  MAX_FIELD_RULES,
  canRoleSeeField,
  evaluateFieldRules,
  type CreateCrmFieldInput,
  type FieldRule,
  type CrmFieldVm,
  type CustomFieldType,
  type FieldGroupKey,
  type FieldPlacement,
  type FieldVisibility,
  type JourneyCustomFieldVm,
  type Role,
  type UpdateCrmFieldInput,
} from "@pulseos/types";

// One field system. A definition says what is captured, where it appears and who sees it;
// values stay Journey-scoped in custom_field_values. Archiving retires a field from new entry
// only — values already recorded stay visible.

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
const GROUP_ORDER = new Map<string, number>(FIELD_GROUPS.map((g, i) => [g.key, i]));
const GROUP_KEYS = new Set<string>(FIELD_GROUPS.map((g) => g.key));
const PLACEMENT_KEYS = new Set<string>(FIELD_PLACEMENTS.map((p) => p.key));
const VISIBILITY_KEYS = new Set<string>(FIELD_VISIBILITY.map((v) => v.key));
const TYPE_KEYS = new Set<string>(CUSTOM_FIELD_TYPES.map((t) => t.key));
const CHOICE_TYPES = new Set<CustomFieldType>(["SELECT", "MULTI_SELECT"]);

export const isGroupKey = (v: unknown): v is FieldGroupKey => typeof v === "string" && GROUP_KEYS.has(v);
export const isPlacement = (v: unknown): v is FieldPlacement => typeof v === "string" && PLACEMENT_KEYS.has(v);
export const isFieldType = (v: unknown): v is CustomFieldType => typeof v === "string" && TYPE_KEYS.has(v);
export const isVisibility = (v: unknown): v is FieldVisibility => typeof v === "string" && VISIBILITY_KEYS.has(v);

type Row = typeof customFieldDefinitions.$inferSelect;

/** Stored rules are re-checked on read: anything malformed is dropped rather than trusted. */
function parseRules(raw: unknown): FieldRule[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldRule[] = [];
  for (const r of raw) {
    const w = (r as { when?: Record<string, unknown> })?.when;
    const then = (r as { then?: unknown })?.then;
    if (then !== "show" && then !== "require") continue;
    if (w && Array.isArray(w.outcome) && w.outcome.every((x) => typeof x === "string")) out.push({ when: { outcome: w.outcome as string[] }, then });
    else if (w && typeof w.field === "string" && Array.isArray(w.equals) && w.equals.every((x) => typeof x === "string")) out.push({ when: { field: w.field, equals: w.equals as string[] }, then });
  }
  return out;
}

function toVm(r: Row): CrmFieldVm {
  return {
    id: r.id,
    specialtyKey: r.specialtyKey,
    key: r.key,
    label: r.label,
    fieldType: r.fieldType,
    options: (r.options as string[] | null) ?? null,
    required: r.required,
    sortOrder: r.sortOrder,
    archived: r.archived,
    origin: r.origin,
    groupKey: (isGroupKey(r.groupKey) ? r.groupKey : "enquiry_details") as FieldGroupKey,
    placements: ((r.placements as unknown[]) ?? []).filter(isPlacement),
    defaultValue: r.defaultValue ?? null,
    visibleTo: (isVisibility(r.visibleTo) ? r.visibleTo : "everyone") as FieldVisibility,
    readOnly: r.readOnly,
    filterable: r.filterable,
    carryForward: r.carryForward,
    rules: parseRules(r.rules),
  };
}

const byGroupThenOrder = (a: CrmFieldVm, b: CrmFieldVm) =>
  (GROUP_ORDER.get(a.groupKey) ?? 99) - (GROUP_ORDER.get(b.groupKey) ?? 99) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);

// ---------------------------------------------------------------------------
// Value validation (pure). Returns the value to store, or an error message.
// ---------------------------------------------------------------------------

export type ValueCheck = { ok: true; value: unknown } | { ok: false; error: string };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9\s-]{5,17}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function checkFieldValue(def: { fieldType: CustomFieldType; options: string[] | null; label: string }, raw: unknown): ValueCheck {
  const bad = (what: string): ValueCheck => ({ ok: false, error: `${def.label}: ${what}` });
  switch (def.fieldType) {
    case "TEXT":
      return typeof raw === "string" && raw.length <= 500 ? { ok: true, value: raw.trim() } : bad("expected text up to 500 characters");
    case "LONG_TEXT":
      return typeof raw === "string" && raw.length <= 5000 ? { ok: true, value: raw.trim() } : bad("expected text up to 5000 characters");
    case "NUMBER": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : bad("expected a number");
    }
    case "PHONE":
      return typeof raw === "string" && PHONE.test(raw.trim()) ? { ok: true, value: raw.trim() } : bad("expected a phone number");
    case "EMAIL":
      return typeof raw === "string" && EMAIL.test(raw.trim()) ? { ok: true, value: raw.trim() } : bad("expected an email address");
    case "DATE": {
      if (typeof raw !== "string" || !DAY.test(raw)) return bad("expected a date (YYYY-MM-DD)");
      const d = new Date(`${raw}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? { ok: true, value: raw } : bad("expected a real date");
    }
    case "DATETIME": {
      const d = typeof raw === "string" ? new Date(raw) : null;
      return d && !Number.isNaN(d.getTime()) ? { ok: true, value: d.toISOString() } : bad("expected a date and time");
    }
    case "BOOLEAN":
      return typeof raw === "boolean" ? { ok: true, value: raw } : bad("expected yes or no");
    case "SELECT":
      return typeof raw === "string" && (def.options ?? []).includes(raw) ? { ok: true, value: raw } : bad("choose one of the listed options");
    case "MULTI_SELECT":
      return Array.isArray(raw) && raw.every((v) => typeof v === "string" && (def.options ?? []).includes(v)) ? { ok: true, value: [...new Set(raw as string[])] } : bad("choose from the listed options");
  }
}

/** A stored value as a person reads it. Dates and date-times are shown in the hospital timezone. */
export function formatFieldValue(type: CustomFieldType, value: unknown, timezone: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (type === "DATE" && typeof value === "string" && DAY.test(value)) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00Z`));
  }
  if (type === "DATETIME" && typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(d);
      const time = new Intl.DateTimeFormat("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s?(am|pm)$/i, (_, m: string) => ` ${m.toLowerCase()}`);
      return `${day}, ${time}`;
    }
  }
  return String(value);
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Fields in a service scope: that service's own fields plus the "all services" ones. */
const scopeCondition = (tenantId: string, specialtyKey: string) =>
  and(eq(customFieldDefinitions.tenantId, tenantId), or(eq(customFieldDefinitions.specialtyKey, specialtyKey), eq(customFieldDefinitions.specialtyKey, ALL_SERVICES_KEY)));

/** For Settings: every definition in the tenant (optionally one service scope, archived optional). */
export async function listCrmFields(db: Db, tenantId: string, opts: { specialtyKey?: string; includeArchived?: boolean } = {}): Promise<CrmFieldVm[]> {
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(opts.specialtyKey ? scopeCondition(tenantId, opts.specialtyKey) : eq(customFieldDefinitions.tenantId, tenantId), opts.includeArchived ? undefined : eq(customFieldDefinitions.archived, false)))
    .orderBy(asc(customFieldDefinitions.sortOrder));
  return rows.map(toVm).sort(byGroupThenOrder);
}

/**
 * Fields an entry form should show: in scope, not archived, placed here, visible to the viewer.
 * A service-specific field wins over an all-services field with the same key.
 */
export async function listFieldsForEntry(db: Db, tenantId: string, role: Role, opts: { placement: FieldPlacement; specialtyKey: string }): Promise<CrmFieldVm[]> {
  const fields = (await listCrmFields(db, tenantId, { specialtyKey: opts.specialtyKey })).filter((f) => f.placements.includes(opts.placement) && canRoleSeeField(role, f.visibleTo));
  const byKey = new Map<string, CrmFieldVm>();
  for (const f of fields) {
    const seen = byKey.get(f.key);
    if (!seen || (seen.specialtyKey === ALL_SERVICES_KEY && f.specialtyKey !== ALL_SERVICES_KEY)) byKey.set(f.key, f);
  }
  return [...byKey.values()].sort(byGroupThenOrder);
}

/**
 * Values recorded on a Journey, for display. Deliberately NOT filtered on archived: a value entered while
 * a field was active stays visible after the field is archived. Filtered by where the field is placed and
 * by who may see it.
 */
export async function loadJourneyFieldValues(db: Db, tenantId: string, journeyId: string, role: Role, placement: "journey_detail" | "patient_360", timezone: string): Promise<JourneyCustomFieldVm[]> {
  const rows = await db
    .select({ def: customFieldDefinitions, value: customFieldValues.value })
    .from(customFieldValues)
    .innerJoin(customFieldDefinitions, eq(customFieldValues.fieldDefinitionId, customFieldDefinitions.id))
    .where(and(eq(customFieldValues.tenantId, tenantId), eq(customFieldValues.journeyId, journeyId)));
  return rows
    .map((r) => ({ vm: toVm(r.def), value: r.value }))
    .filter(({ vm }) => vm.placements.includes(placement) && canRoleSeeField(role, vm.visibleTo))
    .sort((a, b) => byGroupThenOrder(a.vm, b.vm))
    .map(({ vm, value }) => ({ label: vm.label, value: formatFieldValue(vm.fieldType, value, timezone), fieldKey: vm.key, groupKey: vm.groupKey }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string; message?: string };

function validateConfig(input: { fieldType: CustomFieldType; options?: string[] | null; defaultValue?: unknown; label: string }): string | null {
  if (CHOICE_TYPES.has(input.fieldType)) {
    const options = input.options ?? [];
    if (options.length === 0 || options.some((o) => typeof o !== "string" || o.trim() === "") || new Set(options).size !== options.length) return "options_invalid";
  }
  if (!isEmpty(input.defaultValue)) {
    const check = checkFieldValue({ fieldType: input.fieldType, options: input.options ?? null, label: input.label }, input.defaultValue);
    if (!check.ok) return "default_invalid";
  }
  return null;
}

/**
 * Rules must point at real things and never loop: an outcome rule names outcomes this hospital has; a field rule names ANOTHER
 * field in the same scope (and, for a choice field, only its own options). A field cannot depend, directly or through
 * others, on itself. Declarative only — there is nothing else a rule can say.
 */
export async function validateRules(db: Db, tenantId: string, specialtyKey: string, selfKey: string, rules: FieldRule[] | undefined): Promise<string | null> {
  if (!rules || rules.length === 0) return null;
  if (rules.length > MAX_FIELD_RULES) return "too_many_rules";
  const siblings = (await listCrmFields(db, tenantId, { specialtyKey })).filter((f) => !f.archived && f.key !== selfKey);
  const byKey = new Map(siblings.map((f) => [f.key, f]));
  // (Lazy import: the outcome service already depends on this one.)
  await (await import("./crm-outcome.service.js")).ensureDefaultOutcomes(db, tenantId);
  const outcomeKeys = new Set((await db.select({ key: crmOutcomes.key }).from(crmOutcomes).where(eq(crmOutcomes.tenantId, tenantId))).map((o) => o.key));
  for (const r of rules) {
    if ("outcome" in r.when) {
      if (r.when.outcome.length === 0 || !r.when.outcome.every((k) => outcomeKeys.has(k))) return "rule_unknown_outcome";
      continue;
    }
    const parent = byKey.get(r.when.field);
    if (!parent) return "rule_unknown_field";
    if (r.when.equals.length === 0) return "rule_invalid";
    const allowed = parent.fieldType === "BOOLEAN" ? ["true", "false"] : parent.options;
    if (!allowed || !r.when.equals.every((v) => allowed.includes(v))) return "rule_unknown_option";
  }
  // No cycles: walk field-to-field dependencies from this field.
  const deps = (key: string): string[] => (key === selfKey ? rules : byKey.get(key)?.rules ?? []).flatMap((r) => ("field" in r.when ? [r.when.field] : []));
  const seen = new Set<string>();
  const visit = (key: string): boolean => {
    if (key === selfKey && seen.size > 0) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return deps(key).some(visit);
  };
  return visit(selfKey) ? "rule_cycle" : null;
}

export async function createCrmField(db: Db, tenantId: string, input: CreateCrmFieldInput): Promise<Result<{ field: CrmFieldVm }>> {
  if (!FIELD_KEY_PATTERN.test(input.key)) return { ok: false, reason: "invalid_key" };
  if (!isFieldType(input.fieldType)) return { ok: false, reason: "invalid_type" };
  const groupKey = input.groupKey ?? "enquiry_details";
  const placements = input.placements ?? DEFAULT_FIELD_PLACEMENTS;
  const visibleTo = input.visibleTo ?? "everyone";
  if (!isGroupKey(groupKey) || !placements.every(isPlacement) || placements.length === 0 || !isVisibility(visibleTo)) return { ok: false, reason: "invalid_request" };
  const configError = validateConfig({ ...input, label: input.label });
  if (configError) return { ok: false, reason: configError };
  if (input.carryForward && placements.every((p) => p !== "followup_outcome" && p !== "add_lead")) return { ok: false, reason: "carry_forward_needs_entry_form" };

  if (input.specialtyKey !== ALL_SERVICES_KEY) {
    const [template] = await db.select({ id: specialtyTemplates.id }).from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, input.specialtyKey))).limit(1);
    if (!template) return { ok: false, reason: "specialty_not_found" };
  }
  const siblings = await db.select({ key: customFieldDefinitions.key, sortOrder: customFieldDefinitions.sortOrder }).from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.specialtyKey, input.specialtyKey)));
  if (siblings.some((s) => s.key === input.key)) return { ok: false, reason: "key_exists" };
  const ruleError = await validateRules(db, tenantId, input.specialtyKey, input.key, input.rules);
  if (ruleError) return { ok: false, reason: ruleError };

  const [row] = await db
    .insert(customFieldDefinitions)
    .values({
      tenantId,
      specialtyKey: input.specialtyKey,
      key: input.key,
      label: input.label.trim(),
      fieldType: input.fieldType,
      options: CHOICE_TYPES.has(input.fieldType) ? input.options : null,
      // A hospital can only ever make CUSTOM fields; TEMPLATE comes from a template install, SYSTEM from the platform.
      origin: "CUSTOM",
      required: input.required ?? false,
      sortOrder: siblings.reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1,
      groupKey,
      placements,
      defaultValue: isEmpty(input.defaultValue) ? null : input.defaultValue,
      visibleTo,
      readOnly: input.readOnly ?? false,
      filterable: input.filterable ?? false,
      carryForward: input.carryForward ?? false,
      rules: input.rules ?? [],
    })
    .returning();
  return { ok: true, field: toVm(row) };
}

export async function updateCrmField(db: Db, tenantId: string, fieldId: string, input: UpdateCrmFieldInput): Promise<Result<{ field: CrmFieldVm }>> {
  const [existing] = await db.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.id, fieldId))).limit(1);
  if (!existing) return { ok: false, reason: "field_not_found" };
  // SYSTEM fields are platform-owned: never archived, retyped or made optional by a tenant.
  if (existing.origin === "SYSTEM" && (input.archived === true || (input.fieldType !== undefined && input.fieldType !== existing.fieldType) || (input.required === false && existing.required))) {
    return { ok: false, reason: "system_field_locked" };
  }

  const nextType = input.fieldType ?? existing.fieldType;
  if (input.fieldType !== undefined) {
    if (!isFieldType(input.fieldType)) return { ok: false, reason: "invalid_type" };
    if (input.fieldType !== existing.fieldType) {
      const [value] = await db.select({ id: customFieldValues.id }).from(customFieldValues).where(eq(customFieldValues.fieldDefinitionId, fieldId)).limit(1);
      if (value) return { ok: false, reason: "field_has_values" };
    }
  }
  if (input.groupKey !== undefined && !isGroupKey(input.groupKey)) return { ok: false, reason: "invalid_request" };
  if (input.placements !== undefined && (input.placements.length === 0 || !input.placements.every(isPlacement))) return { ok: false, reason: "invalid_request" };
  if (input.visibleTo !== undefined && !isVisibility(input.visibleTo)) return { ok: false, reason: "invalid_request" };

  const nextOptions = input.options !== undefined ? input.options : (existing.options as string[] | null);
  const nextDefault = input.defaultValue !== undefined ? input.defaultValue : existing.defaultValue;
  const configError = validateConfig({ fieldType: nextType, options: nextOptions, defaultValue: nextDefault, label: input.label ?? existing.label });
  if (configError) return { ok: false, reason: configError };

  if (input.rules !== undefined) {
    const ruleError = await validateRules(db, tenantId, existing.specialtyKey, existing.key, input.rules);
    if (ruleError) return { ok: false, reason: ruleError };
  }
  // Same carry-forward rule as create: it only makes sense on a field captured in an entry form.
  const nextPlacements = input.placements ?? (existing.placements as string[]);
  const nextCarry = input.carryForward ?? existing.carryForward;
  if (nextCarry && nextPlacements.every((p) => p !== "followup_outcome" && p !== "add_lead")) return { ok: false, reason: "carry_forward_needs_entry_form" };
  // Changing a field's choices or type must not strand rules that match on one of its options.
  if (input.options !== undefined || (input.fieldType !== undefined && input.fieldType !== existing.fieldType)) {
    const dependants = (await listCrmFields(db, tenantId, { specialtyKey: existing.specialtyKey })).filter((f) => !f.archived && f.rules.some((r) => "field" in r.when && r.when.field === existing.key && r.when.equals.some((v) => !(nextOptions ?? []).includes(v) && !(nextType === "BOOLEAN" && (v === "true" || v === "false")))));
    if (dependants.length > 0) return { ok: false, reason: "field_has_dependants" };
  }
  // Archiving a field other fields depend on would leave their rules pointing at nothing visible: refuse and say so.
  if (input.archived === true && !existing.archived) {
    const dependants = (await listCrmFields(db, tenantId, { specialtyKey: existing.specialtyKey })).filter((f) => !f.archived && f.rules.some((r) => "field" in r.when && r.when.field === existing.key));
    if (dependants.length > 0) return { ok: false, reason: "field_has_dependants" };
  }

  const [row] = await db
    .update(customFieldDefinitions)
    .set({
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
      ...(input.filterable !== undefined ? { filterable: input.filterable } : {}),
      ...(input.carryForward !== undefined ? { carryForward: input.carryForward } : {}),
      ...(input.rules !== undefined ? { rules: input.rules } : {}),
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.fieldType !== undefined ? { fieldType: input.fieldType } : {}),
      ...(input.options !== undefined || input.fieldType !== undefined ? { options: CHOICE_TYPES.has(nextType) ? nextOptions : null } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.groupKey !== undefined ? { groupKey: input.groupKey } : {}),
      ...(input.placements !== undefined ? { placements: input.placements } : {}),
      ...(input.defaultValue !== undefined ? { defaultValue: isEmpty(input.defaultValue) ? null : input.defaultValue } : {}),
      ...(input.visibleTo !== undefined ? { visibleTo: input.visibleTo } : {}),
    })
    .where(eq(customFieldDefinitions.id, fieldId))
    .returning();
  return { ok: true, field: toVm(row) };
}

/** Re-order the fields of one group in one service scope. The group's existing sort slots are reused, so other groups are untouched. */
export async function reorderCrmFields(db: Db, tenantId: string, input: { specialtyKey: string; groupKey: FieldGroupKey; orderedIds: string[] }): Promise<Result> {
  if (!isGroupKey(input.groupKey) || new Set(input.orderedIds).size !== input.orderedIds.length || input.orderedIds.length === 0) return { ok: false, reason: "invalid_request" };
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.specialtyKey, input.specialtyKey), eq(customFieldDefinitions.groupKey, input.groupKey), inArray(customFieldDefinitions.id, input.orderedIds)));
  if (rows.length !== input.orderedIds.length) return { ok: false, reason: "invalid_request" };

  let slots = rows.map((r) => r.sortOrder).sort((a, b) => a - b);
  if (new Set(slots).size !== slots.length) slots = slots.map((_, i) => slots[0]! + i);
  await db.transaction(async (tx) => {
    for (const [i, id] of input.orderedIds.entries()) {
      await tx.update(customFieldDefinitions).set({ sortOrder: slots[i]! }).where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.id, id)));
    }
  });
  return { ok: true };
}

/**
 * Validate and normalise submitted values against the fields active in a placement.
 * A field the rules hide for these answers is ignored (whatever was sent); one they require must be present. Required
 * fields in that placement must be present; unknown / archived / not-visible keys are ignored.
 * `existing` = what the Journey already holds: a read-only field that already has a value cannot be changed.
 */
export function resolveSubmittedValues(
  fields: CrmFieldVm[],
  submitted: Record<string, unknown> | undefined,
  ctx: { outcomeKey?: string | null; existing?: Record<string, unknown> } = {},
): { ok: true; values: { field: CrmFieldVm; value: unknown }[] } | { ok: false; missing: string[]; invalid: string[]; readOnly?: string[] } {
  const provided = submitted ?? {};
  const state = evaluateFieldRules(fields, { outcomeKey: ctx.outcomeKey, values: provided });
  const missing: string[] = [];
  const invalid: string[] = [];
  const readOnly: string[] = [];
  const values: { field: CrmFieldVm; value: unknown }[] = [];
  for (const field of fields) {
    if (!state[field.key]!.visible) continue;
    const raw = provided[field.key];
    if (isEmpty(raw)) {
      if (state[field.key]!.required) missing.push(field.key);
      continue;
    }
    const check = checkFieldValue(field, raw);
    if (!check.ok) {
      invalid.push(field.key);
      continue;
    }
    const current = ctx.existing?.[field.key];
    if (field.readOnly && !isEmpty(current) && JSON.stringify(current) !== JSON.stringify(check.value)) {
      readOnly.push(field.key);
      continue;
    }
    values.push({ field, value: check.value });
  }
  return missing.length || invalid.length || readOnly.length ? { ok: false, missing, invalid, ...(readOnly.length ? { readOnly } : {}) } : { ok: true, values };
}

/** Current values on a Journey, by field key (for read-only checks and carry-forward). */
export async function loadJourneyValuesByKey(db: Db, tenantId: string, journeyId: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ key: customFieldDefinitions.key, value: customFieldValues.value })
    .from(customFieldValues)
    .innerJoin(customFieldDefinitions, eq(customFieldValues.fieldDefinitionId, customFieldDefinitions.id))
    .where(and(eq(customFieldValues.tenantId, tenantId), eq(customFieldValues.journeyId, journeyId)));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** What the next interaction starts with: only fields the hospital marked "carry forward", at their current value. */
export async function carryForwardValues(db: Db, tenantId: string, role: Role, journeyId: string, specialtyKey: string, placement: FieldPlacement): Promise<Record<string, unknown>> {
  const fields = (await listFieldsForEntry(db, tenantId, role, { placement, specialtyKey })).filter((f) => f.carryForward);
  if (fields.length === 0) return {};
  const current = await loadJourneyValuesByKey(db, tenantId, journeyId);
  return Object.fromEntries(fields.filter((f) => !isEmpty(current[f.key])).map((f) => [f.key, current[f.key]]));
}
