import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { customFieldDefinitions, departments, specialtyTemplates } from "../../db/schema.js";
import { createCrmField } from "../crm/crm-field.service.js";
import type {
  CreateCustomFieldInput,
  CustomFieldDefinitionVm,
  SpecialtyDetailVm,
  SpecialtyTemplateVm,
  UpdateCustomFieldInput,
  UpdateSpecialtyInput,
} from "@pulseos/types";

function toFieldVm(r: typeof customFieldDefinitions.$inferSelect): CustomFieldDefinitionVm {
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
  };
}

export async function listSpecialties(db: Db, tenantId: string, includeDisabled = false): Promise<SpecialtyTemplateVm[]> {
  // A service whose department the hospital has archived is not offered for new work (it stays readable on old journeys).
  const rows = await db
    .select({ template: specialtyTemplates, departmentArchived: departments.archived, departmentName: departments.displayName })
    .from(specialtyTemplates)
    .leftJoin(departments, eq(specialtyTemplates.departmentId, departments.id))
    .where(and(eq(specialtyTemplates.tenantId, tenantId), includeDisabled ? undefined : eq(specialtyTemplates.enabled, true)))
    .orderBy(asc(specialtyTemplates.sortOrder));
  const visible = rows.filter((r) => includeDisabled || !r.departmentArchived);
  const templates = visible.map((r) => r.template);
  const departmentNameByKey = new Map(visible.map((r) => [r.template.key, r.departmentName]));

  const fields = await db
    .select({ specialtyKey: customFieldDefinitions.specialtyKey })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.archived, false)));

  const fieldCountByKey = new Map<string, number>();
  for (const f of fields) fieldCountByKey.set(f.specialtyKey, (fieldCountByKey.get(f.specialtyKey) ?? 0) + 1);

  return templates.map((t) => ({
    key: t.key,
    displayName: t.displayName,
    defaultJourneyType: t.defaultJourneyType,
    departmentName: departmentNameByKey.get(t.key) ?? null,
    enabled: t.enabled,
    sortOrder: t.sortOrder,
    fieldCount: fieldCountByKey.get(t.key) ?? 0,
  }));
}

export async function getSpecialtyDetail(db: Db, tenantId: string, key: string): Promise<SpecialtyDetailVm | null> {
  const [template] = await db
    .select()
    .from(specialtyTemplates)
    .where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, key)))
    .limit(1);
  if (!template) return null;
  const [department] = template.departmentId ? await db.select({ displayName: departments.displayName }).from(departments).where(eq(departments.id, template.departmentId)).limit(1) : [];

  const fields = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.specialtyKey, key), eq(customFieldDefinitions.archived, false)))
    .orderBy(asc(customFieldDefinitions.sortOrder));

  return {
    key: template.key,
    displayName: template.displayName,
    defaultJourneyType: template.defaultJourneyType,
    departmentName: department?.displayName ?? null,
    enabled: template.enabled,
    sortOrder: template.sortOrder,
    fieldCount: fields.length,
    fields: fields.map(toFieldVm),
  };
}

/** Active (non-archived) fields for a specialty — used by the Add Lead drawer. */
export async function listActiveFields(db: Db, tenantId: string, specialtyKey: string): Promise<CustomFieldDefinitionVm[]> {
  const fields = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.specialtyKey, specialtyKey), eq(customFieldDefinitions.archived, false)))
    .orderBy(asc(customFieldDefinitions.sortOrder));
  return fields.map(toFieldVm);
}

const SERVICE_NAME_MAX = 60;

/** "Laser Vision Correction" -> LASER_VISION_CORRECTION. The key is permanent (journeys and fields point at it); the name can change. */
export function serviceKeyFrom(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/**
 * Add a service the hospital offers (what an enquiry is about). Same table the department templates install into, so it appears in
 * Add Lead, filters and reports like any other, and can have its own CRM fields. Never hard-deleted later: disable it instead.
 */
export async function createSpecialty(db: Db, tenantId: string, input: { displayName: string; defaultJourneyType?: string }): Promise<{ ok: true; service: SpecialtyTemplateVm } | { ok: false; reason: string }> {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > SERVICE_NAME_MAX) return { ok: false, reason: "invalid_request" };
  const base = serviceKeyFrom(displayName);
  if (!base) return { ok: false, reason: "invalid_request" };
  const existing = await db.select({ key: specialtyTemplates.key, displayName: specialtyTemplates.displayName, sortOrder: specialtyTemplates.sortOrder }).from(specialtyTemplates).where(eq(specialtyTemplates.tenantId, tenantId));
  if (existing.some((s) => s.displayName.trim().toLowerCase() === displayName.toLowerCase())) return { ok: false, reason: "service_exists" };
  let key = base;
  for (let i = 2; existing.some((s) => s.key === key); i++) key = `${base.slice(0, 36)}_${i}`;
  const sortOrder = existing.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1;
  const journeyType = input.defaultJourneyType?.trim() || displayName;
  const [row] = await db.insert(specialtyTemplates).values({ tenantId, key, displayName, defaultJourneyType: journeyType, enabled: true, sortOrder }).onConflictDoNothing().returning();
  if (!row) return { ok: false, reason: "service_exists" };
  return { ok: true, service: { key: row.key, displayName: row.displayName, defaultJourneyType: row.defaultJourneyType, departmentName: null, enabled: row.enabled, sortOrder: row.sortOrder, fieldCount: 0 } };
}

export async function updateSpecialty(db: Db, tenantId: string, key: string, input: UpdateSpecialtyInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db
    .select({ id: specialtyTemplates.id })
    .from(specialtyTemplates)
    .where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, key)))
    .limit(1);
  if (!existing) return { ok: false, reason: "specialty_not_found" };

  await db
    .update(specialtyTemplates)
    .set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.defaultJourneyType !== undefined ? { defaultJourneyType: input.defaultJourneyType } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    })
    .where(eq(specialtyTemplates.id, existing.id));
  return { ok: true };
}

export async function createCustomField(db: Db, tenantId: string, specialtyKey: string, input: CreateCustomFieldInput): Promise<{ ok: true; field: CustomFieldDefinitionVm } | { ok: false; reason: string }> {
  // One field system: creation goes through the CRM field service (key rules, uniqueness, validation).
  const created = await createCrmField(db, tenantId, { ...input, specialtyKey });
  if (!created.ok) return { ok: false, reason: created.reason };
  return { ok: true, field: created.field };
}

export async function updateCustomField(db: Db, tenantId: string, fieldId: string, input: UpdateCustomFieldInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db
    .select({ id: customFieldDefinitions.id, origin: customFieldDefinitions.origin, required: customFieldDefinitions.required })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.id, fieldId)))
    .limit(1);
  if (!existing) return { ok: false, reason: "field_not_found" };
  if (existing.origin === "SYSTEM" && (input.archived === true || (input.required === false && existing.required))) return { ok: false, reason: "system_field_locked" };

  await db
    .update(customFieldDefinitions)
    .set({
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
    })
    .where(eq(customFieldDefinitions.id, fieldId));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Specialty definitions are data (see gynecology.templates.ts and
// ophthalmology.templates.ts) — this installs any set of them for a tenant.
// ---------------------------------------------------------------------------

export interface SpecialtyDefinition {
  key: string;
  displayName: string;
  defaultJourneyType: string;
  sortOrder: number;
  fields: CreateCustomFieldInput[];
}

/**
 * Idempotently installs the given specialty definitions for a tenant: a service or field that already exists is
 * never touched (so a hospital's edits, archives and renames survive a re-install), a missing one is added. Every
 * field installed here is origin TEMPLATE. Passing `departmentId` also attaches the services to that department
 * (an existing service with no department is attached; one that already has a department is left alone).
 */
export async function ensureSpecialties(db: Db, tenantId: string, definitions: SpecialtyDefinition[], opts: { departmentId?: string } = {}): Promise<void> {
  for (const spec of definitions) {
    await db
      .insert(specialtyTemplates)
      .values({ tenantId, key: spec.key, displayName: spec.displayName, defaultJourneyType: spec.defaultJourneyType, departmentId: opts.departmentId ?? null, enabled: true, sortOrder: spec.sortOrder })
      .onConflictDoNothing({ target: [specialtyTemplates.tenantId, specialtyTemplates.key] });

    if (opts.departmentId) {
      await db
        .update(specialtyTemplates)
        .set({ departmentId: opts.departmentId })
        .where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, spec.key), isNull(specialtyTemplates.departmentId)));
    }

    if (spec.fields.length === 0) continue;
    await db
      .insert(customFieldDefinitions)
      .values(
        spec.fields.map((field, i) => ({
          tenantId,
          specialtyKey: spec.key,
          key: field.key,
          label: field.label,
          fieldType: field.fieldType,
          origin: "TEMPLATE" as const,
          options: field.options ?? null,
          required: field.required ?? false,
          sortOrder: i,
        })),
      )
      .onConflictDoNothing({ target: [customFieldDefinitions.tenantId, customFieldDefinitions.specialtyKey, customFieldDefinitions.key] });
  }
}
