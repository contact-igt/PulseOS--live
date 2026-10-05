import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { departments, specialtyTemplates } from "../../db/schema.js";
import { ensureLeadSources } from "../lead/lead-source.service.js";
import { ensureFollowUpTypes } from "../task/followup-type.service.js";
import { DEPARTMENT_TEMPLATES, departmentKeyForTemplate, findDepartmentTemplate } from "./department-templates.js";
import { ensureSpecialties } from "./specialty.service.js";
import { ensureTreatmentCatalog } from "./treatment-catalog.service.js";
import type { DepartmentTemplateVm, DepartmentVm, UpdateDepartmentInput } from "@pulseos/types";

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

export async function listDepartments(db: Db, tenantId: string): Promise<DepartmentVm[]> {
  const [deps, services] = await Promise.all([
    db.select().from(departments).where(eq(departments.tenantId, tenantId)).orderBy(asc(departments.sortOrder), asc(departments.displayName)),
    db.select().from(specialtyTemplates).where(eq(specialtyTemplates.tenantId, tenantId)).orderBy(asc(specialtyTemplates.sortOrder)),
  ]);
  return deps.map((d) => ({
    id: d.id,
    key: d.key,
    displayName: d.displayName,
    templateKey: d.templateKey,
    archived: d.archived,
    sortOrder: d.sortOrder,
    services: services.filter((s) => s.departmentId === d.id).map((s) => ({ key: s.key, displayName: s.displayName, enabled: s.enabled })),
  }));
}

/** The global templates, flagged with whether this tenant has already installed each. */
export async function listDepartmentTemplates(db: Db, tenantId: string): Promise<DepartmentTemplateVm[]> {
  const installed = await db.select({ templateKey: departments.templateKey }).from(departments).where(eq(departments.tenantId, tenantId));
  const installedKeys = new Set(installed.map((d) => d.templateKey));
  return DEPARTMENT_TEMPLATES.map((t) => ({ key: t.key, displayName: t.displayName, description: t.description, services: t.specialties.map((s) => s.displayName), installed: installedKeys.has(t.key) }));
}

/**
 * Installs a global department template into one tenant: the department, its services, their fields (origin
 * TEMPLATE) and its treatment catalogue become tenant-owned rows. Safe to run repeatedly and concurrently — it
 * only adds what is missing and never overwrites or un-archives what the hospital has changed.
 */
export async function installDepartmentTemplate(db: Db, tenantId: string, templateKey: string): Promise<Result<{ departmentId: string; created: boolean }>> {
  const template = findDepartmentTemplate(templateKey);
  if (!template) return { ok: false, reason: "template_not_found" };

  const key = departmentKeyForTemplate(template.key);
  const inserted = await db
    .insert(departments)
    .values({ tenantId, key, displayName: template.displayName, templateKey: template.key, sortOrder: DEPARTMENT_TEMPLATES.indexOf(template) })
    .onConflictDoNothing({ target: [departments.tenantId, departments.key] })
    .returning({ id: departments.id });
  const [department] = inserted.length ? inserted : await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.key, key))).limit(1);

  await ensureSpecialties(db, tenantId, template.specialties, { departmentId: department.id });
  await ensureTreatmentCatalog(db, tenantId, template.treatments);
  await ensureLeadSources(db, tenantId);
  await ensureFollowUpTypes(db, tenantId);
  return { ok: true, departmentId: department.id, created: inserted.length > 0 };
}

export async function updateDepartment(db: Db, tenantId: string, id: string, input: UpdateDepartmentInput): Promise<Result> {
  const [existing] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "department_not_found" };
  const name = input.displayName?.trim();
  if (input.displayName !== undefined && (!name || name.length > 80)) return { ok: false, reason: "invalid_request" };
  await db
    .update(departments)
    .set({ ...(name !== undefined ? { displayName: name } : {}), ...(input.archived !== undefined ? { archived: input.archived } : {}) })
    .where(eq(departments.id, id));
  return { ok: true };
}
