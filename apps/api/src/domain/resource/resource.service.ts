import { and, asc, eq, or } from "drizzle-orm";
import type { CreateScheduleResourceInput, ScheduleResourceVm, UpdateScheduleResourceInput } from "@pulseos/types";
import type { DbOrTx } from "../../db/client.js";
import { departments, scheduleResources } from "../../db/schema.js";

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

const MAX_NAME = 120;

async function departmentOk(db: DbOrTx, tenantId: string, departmentId: string): Promise<boolean> {
  const [d] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.id, departmentId))).limit(1);
  return !!d;
}

async function loadVm(db: DbOrTx, tenantId: string, id: string): Promise<ScheduleResourceVm | null> {
  const [row] = await db
    .select({ r: scheduleResources, departmentName: departments.displayName })
    .from(scheduleResources)
    .leftJoin(departments, eq(scheduleResources.departmentId, departments.id))
    .where(and(eq(scheduleResources.tenantId, tenantId), eq(scheduleResources.id, id)))
    .limit(1);
  return row ? { id: row.r.id, name: row.r.name, departmentId: row.r.departmentId, departmentName: row.departmentName, hasLogin: !!row.r.linkedUserId, isActive: row.r.isActive } : null;
}

/** The hospital's scheduling profiles (doctors and the like), A→Z. Inactive ones only when asked. */
export async function listResources(db: DbOrTx, tenantId: string, opts: { includeInactive?: boolean } = {}): Promise<ScheduleResourceVm[]> {
  const rows = await db
    .select({ r: scheduleResources, departmentName: departments.displayName })
    .from(scheduleResources)
    .leftJoin(departments, eq(scheduleResources.departmentId, departments.id))
    .where(and(eq(scheduleResources.tenantId, tenantId), opts.includeInactive ? undefined : eq(scheduleResources.isActive, true)))
    .orderBy(asc(scheduleResources.name));
  return rows.map(({ r, departmentName }) => ({ id: r.id, name: r.name, departmentId: r.departmentId, departmentName, hasLogin: !!r.linkedUserId, isActive: r.isActive }));
}

/**
 * The resource if — and only if — it is an active profile of THIS hospital. A doctor's login id is accepted too and
 * resolves to the profile linked to it (older clients still book with the user id).
 */
export async function findActiveResource(db: DbOrTx, tenantId: string, id: string) {
  const [row] = await db
    .select()
    .from(scheduleResources)
    .where(and(eq(scheduleResources.tenantId, tenantId), or(eq(scheduleResources.id, id), eq(scheduleResources.linkedUserId, id)), eq(scheduleResources.isActive, true)))
    .limit(1);
  return row ?? null;
}

/** Adds a doctor/resource who may have no PulseOS login. */
export async function createResource(db: DbOrTx, tenantId: string, input: CreateScheduleResourceInput): Promise<Result<{ resource: ScheduleResourceVm }>> {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME) return { ok: false, reason: "invalid_request" };
  if (input.departmentId && !(await departmentOk(db, tenantId, input.departmentId))) return { ok: false, reason: "department_invalid" };
  const [row] = await db.insert(scheduleResources).values({ tenantId, name, departmentId: input.departmentId ?? null }).returning();
  return { ok: true, resource: (await loadVm(db, tenantId, row!.id))! };
}

export async function updateResource(db: DbOrTx, tenantId: string, id: string, input: UpdateScheduleResourceInput): Promise<Result<{ resource: ScheduleResourceVm }>> {
  const [existing] = await db.select().from(scheduleResources).where(and(eq(scheduleResources.tenantId, tenantId), eq(scheduleResources.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "resource_not_found" };
  const patch: Partial<typeof scheduleResources.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > MAX_NAME) return { ok: false, reason: "invalid_request" };
    patch.name = name;
  }
  if (input.departmentId !== undefined) {
    if (input.departmentId && !(await departmentOk(db, tenantId, input.departmentId))) return { ok: false, reason: "department_invalid" };
    patch.departmentId = input.departmentId;
  }
  if (input.isActive !== undefined) patch.isActive = !!input.isActive;
  if (Object.keys(patch).length > 0) await db.update(scheduleResources).set(patch).where(eq(scheduleResources.id, id));
  return { ok: true, resource: (await loadVm(db, tenantId, id))! };
}
