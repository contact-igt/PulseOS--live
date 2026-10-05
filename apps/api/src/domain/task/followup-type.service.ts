import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import { departments, followUpTypes } from "../../db/schema.js";
import { FOLLOW_UP_BEHAVIOURS, FOLLOW_UP_KEYS, type CreateFollowUpTypeInput, type FollowUpTypeVm, type TaskType, type UpdateFollowUpTypeInput } from "@pulseos/types";

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

// The Beta V1 defaults every tenant starts from, then owns. Labels are product wording; each maps onto a stable
// canonical Task type so nothing that reads tasks by type changes. Appointment Risk asks for a note because
// "why is this at risk?" is the whole point of it — an Admin can switch that off.
export const DEFAULT_FOLLOW_UP_TYPES: { key: string; label: string; canonicalTaskType: TaskType; defaultPriority: "normal" | "high"; requiresNote: boolean }[] = [
  { key: FOLLOW_UP_KEYS.callback, label: "Callback", canonicalTaskType: "CALLBACK", defaultPriority: "normal", requiresNote: false },
  { key: FOLLOW_UP_KEYS.appointmentFollowUp, label: "Appointment Follow-up", canonicalTaskType: "FOLLOW_UP", defaultPriority: "normal", requiresNote: false },
  { key: FOLLOW_UP_KEYS.appointmentRisk, label: "Appointment Risk", canonicalTaskType: "FOLLOW_UP", defaultPriority: "high", requiresNote: true },
  { key: FOLLOW_UP_KEYS.general, label: "General Follow-up", canonicalTaskType: "FOLLOW_UP", defaultPriority: "normal", requiresNote: false },
  { key: FOLLOW_UP_KEYS.surgery, label: "Surgery Follow-up", canonicalTaskType: "FOLLOW_UP", defaultPriority: "normal", requiresNote: false },
];

const ALLOWED_CANONICAL = new Set<string>(FOLLOW_UP_BEHAVIOURS.map((b) => b.key));
const OWNERS = new Set(["JOURNEY_OWNER", "ACTOR", "UNASSIGNED"]);

type Row = typeof followUpTypes.$inferSelect;
const toVm = (r: Row, departmentName: string | null): FollowUpTypeVm => ({
  id: r.id, key: r.key, label: r.label, canonicalTaskType: r.canonicalTaskType, defaultPriority: r.defaultPriority, defaultOwner: r.defaultOwner,
  requiresNote: r.requiresNote, isActive: r.isActive, sortOrder: r.sortOrder, departmentId: r.departmentId, departmentName,
});

/** Installs the defaults the first time a tenant needs them; a hospital's later edits are never overwritten. */
export async function ensureFollowUpTypes(db: DbOrTx, tenantId: string): Promise<void> {
  const [existing] = await db.select({ id: followUpTypes.id }).from(followUpTypes).where(eq(followUpTypes.tenantId, tenantId)).limit(1);
  if (existing) return;
  await db
    .insert(followUpTypes)
    .values(DEFAULT_FOLLOW_UP_TYPES.map((t, i) => ({ tenantId, key: t.key, label: t.label, canonicalTaskType: t.canonicalTaskType, defaultPriority: t.defaultPriority, requiresNote: t.requiresNote, sortOrder: i })))
    .onConflictDoNothing({ target: [followUpTypes.tenantId, followUpTypes.key] });
}

export async function listFollowUpTypes(db: Db, tenantId: string, opts: { includeInactive?: boolean; forDepartmentId?: string | null } = {}): Promise<FollowUpTypeVm[]> {
  await ensureFollowUpTypes(db, tenantId);
  const rows = await db
    .select({ type: followUpTypes, departmentName: departments.displayName })
    .from(followUpTypes)
    .leftJoin(departments, eq(followUpTypes.departmentId, departments.id))
    .where(
      and(
        eq(followUpTypes.tenantId, tenantId),
        opts.includeInactive ? undefined : eq(followUpTypes.isActive, true),
        // A journey sees the types for everyone plus its own department's.
        opts.forDepartmentId !== undefined ? (opts.forDepartmentId ? or(isNull(followUpTypes.departmentId), eq(followUpTypes.departmentId, opts.forDepartmentId)) : isNull(followUpTypes.departmentId)) : undefined,
      ),
    )
    .orderBy(asc(followUpTypes.sortOrder), asc(followUpTypes.label));
  return rows.map((r) => toVm(r.type, r.departmentName));
}

const slug = (label: string) => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

async function departmentOk(db: Db, tenantId: string, departmentId: string | null | undefined): Promise<boolean> {
  if (!departmentId) return true;
  const [d] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.id, departmentId))).limit(1);
  return !!d;
}

export async function createFollowUpType(db: Db, tenantId: string, input: CreateFollowUpTypeInput): Promise<Result<{ type: FollowUpTypeVm }>> {
  const label = input.label?.trim();
  if (!label || label.length > 60 || !slug(label)) return { ok: false, reason: "invalid_request" };
  const canonical = input.canonicalTaskType ?? "FOLLOW_UP";
  if (!ALLOWED_CANONICAL.has(canonical) || (input.defaultOwner && !OWNERS.has(input.defaultOwner)) || (input.defaultPriority && input.defaultPriority !== "normal" && input.defaultPriority !== "high")) return { ok: false, reason: "invalid_request" };
  if (!(await departmentOk(db, tenantId, input.departmentId))) return { ok: false, reason: "department_not_found" };
  await ensureFollowUpTypes(db, tenantId);
  const rows = await db.select().from(followUpTypes).where(eq(followUpTypes.tenantId, tenantId));
  if (rows.some((r) => r.label.toLowerCase() === label.toLowerCase())) return { ok: false, reason: "type_exists" };
  const base = `custom_${slug(label)}`;
  const key = rows.some((r) => r.key === base) ? `${base}_${rows.length}` : base;
  const [row] = await db
    .insert(followUpTypes)
    .values({
      tenantId, departmentId: input.departmentId ?? null, key, label, canonicalTaskType: canonical, defaultPriority: input.defaultPriority ?? "normal",
      defaultOwner: input.defaultOwner ?? "JOURNEY_OWNER", requiresNote: input.requiresNote ?? false, sortOrder: rows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1,
    })
    .returning();
  const [dept] = row!.departmentId ? await db.select({ n: departments.displayName }).from(departments).where(eq(departments.id, row!.departmentId)).limit(1) : [];
  return { ok: true, type: toVm(row!, dept?.n ?? null) };
}

export async function updateFollowUpType(db: Db, tenantId: string, id: string, input: UpdateFollowUpTypeInput): Promise<Result<{ type: FollowUpTypeVm }>> {
  const [existing] = await db.select().from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "type_not_found" };
  const label = input.label?.trim();
  if (input.label !== undefined && (!label || label.length > 60)) return { ok: false, reason: "invalid_request" };
  if (input.canonicalTaskType !== undefined && !ALLOWED_CANONICAL.has(input.canonicalTaskType)) return { ok: false, reason: "invalid_request" };
  if ((input.defaultOwner && !OWNERS.has(input.defaultOwner)) || (input.defaultPriority && input.defaultPriority !== "normal" && input.defaultPriority !== "high")) return { ok: false, reason: "invalid_request" };
  if (input.departmentId !== undefined && !(await departmentOk(db, tenantId, input.departmentId))) return { ok: false, reason: "department_not_found" };
  if (label && label.toLowerCase() !== existing.label.toLowerCase()) {
    const others = await db.select({ label: followUpTypes.label }).from(followUpTypes).where(eq(followUpTypes.tenantId, tenantId));
    if (others.some((o) => o.label.toLowerCase() === label.toLowerCase())) return { ok: false, reason: "type_exists" };
  }
  if (input.isActive === false && existing.isActive) {
    // Staff must always have something to choose: the last active type cannot be archived.
    const active = await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.isActive, true)));
    if (active.length <= 1) return { ok: false, reason: "last_active_type" };
  }
  const [row] = await db
    .update(followUpTypes)
    .set({
      ...(label !== undefined ? { label } : {}),
      ...(input.canonicalTaskType !== undefined ? { canonicalTaskType: input.canonicalTaskType } : {}),
      ...(input.defaultPriority !== undefined ? { defaultPriority: input.defaultPriority } : {}),
      ...(input.defaultOwner !== undefined ? { defaultOwner: input.defaultOwner } : {}),
      ...(input.requiresNote !== undefined ? { requiresNote: input.requiresNote } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(followUpTypes.id, id))
    .returning();
  const [dept] = row!.departmentId ? await db.select({ n: departments.displayName }).from(departments).where(eq(departments.id, row!.departmentId)).limit(1) : [];
  return { ok: true, type: toVm(row!, dept?.n ?? null) };
}

export async function reorderFollowUpTypes(db: Db, tenantId: string, orderedIds: string[]): Promise<Result> {
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  const rows = await db.select().from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), inArray(followUpTypes.id, orderedIds)));
  if (rows.length !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  let slots = rows.map((r) => r.sortOrder).sort((a, b) => a - b);
  if (new Set(slots).size !== slots.length) slots = slots.map((_, i) => slots[0]! + i);
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(followUpTypes).set({ sortOrder: slots[i]! }).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.id, id)));
  });
  return { ok: true };
}
