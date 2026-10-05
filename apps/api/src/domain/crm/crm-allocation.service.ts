import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { allocationRules, branches, specialtyTemplates, users } from "../../db/schema.js";
import type { AllocationRuleVm, CreateAllocationRuleInput, Role, SourceChannel, UpdateAllocationRuleInput } from "@pulseos/types";
import type { Result } from "./crm-field.service.js";

// Allocation: the minimum the demo workflows need. Ordered rules, first enabled match wins, each condition
// optional but at least one required, a pool of staff shared round-robin. Journey-level; manual assignment
// and reassignment are untouched and always win.

/** Roles that can own a Journey. Doctors do not own enquiries. */
const OWNER_ROLES: Role[] = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR"];

type Row = typeof allocationRules.$inferSelect;
const poolOf = (r: Row): string[] => ((r.pool as unknown[]) ?? []).filter((x): x is string => typeof x === "string");

async function toVms(db: Db, tenantId: string, rows: Row[]): Promise<AllocationRuleVm[]> {
  const ids = [...new Set(rows.flatMap(poolOf))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, ids))) : [];
  const name = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sortOrder: r.sortOrder,
    enabled: r.enabled,
    source: (r.matchSource as SourceChannel | null) ?? null,
    specialtyKey: r.matchSpecialtyKey,
    journeyType: r.matchJourneyType,
    branchId: r.matchBranchId,
    pool: poolOf(r).map((userId) => ({ userId, name: name.get(userId) ?? "(removed user)" })),
  }));
}

export async function listAllocationRules(db: Db, tenantId: string): Promise<AllocationRuleVm[]> {
  const rows = await db.select().from(allocationRules).where(eq(allocationRules.tenantId, tenantId)).orderBy(asc(allocationRules.sortOrder), asc(allocationRules.createdAt));
  return toVms(db, tenantId, rows);
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

async function validateRule(db: Db, tenantId: string, rule: { source: string | null; specialtyKey: string | null; journeyType: string | null; branchId: string | null; userIds: string[] }): Promise<string | null> {
  if (!rule.source && !rule.specialtyKey && !rule.journeyType && !rule.branchId) return "condition_required";
  if (rule.userIds.length === 0 || new Set(rule.userIds).size !== rule.userIds.length) return "pool_invalid";
  const people = await db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, rule.userIds)));
  if (people.length !== rule.userIds.length || people.some((p) => !OWNER_ROLES.includes(p.role))) return "pool_invalid";
  if (rule.branchId) {
    const [b] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, rule.branchId))).limit(1);
    if (!b) return "branch_invalid";
  }
  if (rule.specialtyKey) {
    const [t] = await db.select({ id: specialtyTemplates.id }).from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, rule.specialtyKey))).limit(1);
    if (!t) return "specialty_invalid";
  }
  return null;
}

export async function createAllocationRule(db: Db, tenantId: string, input: CreateAllocationRuleInput): Promise<Result<{ rule: AllocationRuleVm }>> {
  const rule = { source: clean(input.source), specialtyKey: clean(input.specialtyKey), journeyType: clean(input.journeyType), branchId: clean(input.branchId), userIds: input.userIds };
  if (!input.name.trim()) return { ok: false, reason: "invalid_request" };
  const problem = await validateRule(db, tenantId, rule);
  if (problem) return { ok: false, reason: problem };
  const siblings = await db.select({ sortOrder: allocationRules.sortOrder }).from(allocationRules).where(eq(allocationRules.tenantId, tenantId));
  const [row] = await db
    .insert(allocationRules)
    .values({
      tenantId,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      matchSource: rule.source,
      matchSpecialtyKey: rule.specialtyKey,
      matchJourneyType: rule.journeyType,
      matchBranchId: rule.branchId,
      pool: rule.userIds,
      sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1) + 1,
    })
    .returning();
  return { ok: true, rule: (await toVms(db, tenantId, [row!]))[0]! };
}

export async function updateAllocationRule(db: Db, tenantId: string, id: string, input: UpdateAllocationRuleInput): Promise<Result<{ rule: AllocationRuleVm }>> {
  const [existing] = await db.select().from(allocationRules).where(and(eq(allocationRules.tenantId, tenantId), eq(allocationRules.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "rule_not_found" };
  const next = {
    source: input.source !== undefined ? clean(input.source) : existing.matchSource,
    specialtyKey: input.specialtyKey !== undefined ? clean(input.specialtyKey) : existing.matchSpecialtyKey,
    journeyType: input.journeyType !== undefined ? clean(input.journeyType) : existing.matchJourneyType,
    branchId: input.branchId !== undefined ? clean(input.branchId) : existing.matchBranchId,
    userIds: input.userIds ?? poolOf(existing),
  };
  if (input.name !== undefined && !input.name.trim()) return { ok: false, reason: "invalid_request" };
  const problem = await validateRule(db, tenantId, next);
  if (problem) return { ok: false, reason: problem };
  const [row] = await db
    .update(allocationRules)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      matchSource: next.source,
      matchSpecialtyKey: next.specialtyKey,
      matchJourneyType: next.journeyType,
      matchBranchId: next.branchId,
      pool: next.userIds,
    })
    .where(eq(allocationRules.id, id))
    .returning();
  return { ok: true, rule: (await toVms(db, tenantId, [row!]))[0]! };
}

export async function deleteAllocationRule(db: Db, tenantId: string, id: string): Promise<Result> {
  const deleted = await db.delete(allocationRules).where(and(eq(allocationRules.tenantId, tenantId), eq(allocationRules.id, id))).returning({ id: allocationRules.id });
  return deleted.length ? { ok: true } : { ok: false, reason: "rule_not_found" };
}

export async function reorderAllocationRules(db: Db, tenantId: string, orderedIds: string[]): Promise<Result> {
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  const rows = await db.select().from(allocationRules).where(and(eq(allocationRules.tenantId, tenantId), inArray(allocationRules.id, orderedIds)));
  if (rows.length !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  let slots = rows.map((r) => r.sortOrder).sort((a, b) => a - b);
  if (new Set(slots).size !== slots.length) slots = slots.map((_, i) => slots[0]! + i);
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(allocationRules).set({ sortOrder: slots[i]! }).where(and(eq(allocationRules.tenantId, tenantId), eq(allocationRules.id, id)));
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Picking an owner for a new Journey
// ---------------------------------------------------------------------------

export interface AllocationContext {
  source: string;
  specialtyKey?: string | null;
  journeyType?: string | null;
  branchId?: string | null;
}

const matches = (r: Row, ctx: AllocationContext): boolean =>
  (!r.matchSource || r.matchSource === ctx.source) &&
  (!r.matchSpecialtyKey || r.matchSpecialtyKey === (ctx.specialtyKey ?? null)) &&
  (!r.matchJourneyType || r.matchJourneyType === (ctx.journeyType ?? null)) &&
  (!r.matchBranchId || r.matchBranchId === (ctx.branchId ?? null));

/**
 * The first enabled rule (in order) that matches, and one eligible person from its pool — shared round-robin.
 * The cursor is advanced with a single atomic UPDATE ... RETURNING, so leads arriving at the same moment get
 * different turns. Returns null when no rule applies (the Journey is simply left unassigned, as before).
 */
export async function pickOwnerForNewJourney(db: Db, tenantId: string, ctx: AllocationContext): Promise<{ userId: string; userName: string; ruleName: string } | null> {
  const rows = await db.select().from(allocationRules).where(and(eq(allocationRules.tenantId, tenantId), eq(allocationRules.enabled, true))).orderBy(asc(allocationRules.sortOrder), asc(allocationRules.createdAt));
  for (const rule of rows) {
    if (!matches(rule, ctx)) continue;
    // Only people who still exist in this hospital and can own a Journey take a turn.
    const pool = poolOf(rule);
    const people = pool.length ? await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, pool))) : [];
    const eligible = pool.map((id) => people.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p && OWNER_ROLES.includes(p.role));
    if (eligible.length === 0) continue;
    const [advanced] = await db
      .update(allocationRules)
      .set({ rrCursor: sql`${allocationRules.rrCursor} + 1` })
      .where(and(eq(allocationRules.id, rule.id), eq(allocationRules.tenantId, tenantId)))
      .returning({ cursor: allocationRules.rrCursor });
    const turn = ((advanced?.cursor ?? 1) - 1) % eligible.length;
    const person = eligible[turn]!;
    return { userId: person.id, userName: person.name, ruleName: rule.name };
  }
  return null;
}
