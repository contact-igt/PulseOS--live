import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { canManagePlatformRole, type PlatformRole } from "@pulseos/types";
import type { Db, DbOrTx } from "../../db/client.js";
import { accountTokens, platformSessions, platformUsers } from "../../db/schema.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";
import { deliverAccountToken, issueAccountToken, type IssuedToken } from "./account-tokens.service.js";
import { UUID } from "./tenants.service.js";

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number };
const PLATFORM_ROLE_KEYS = ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN", "SUPPORT_AGENT", "PLATFORM_AUDITOR"] as const;

export const inviteStaffSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254), role: z.enum(PLATFORM_ROLE_KEYS) }).strict();
export const staffRoleSchema = z.object({ role: z.enum(PLATFORM_ROLE_KEYS), version: z.number().int().positive() }).strict();
export const staffReasonSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export interface StaffActor extends AuditActor {
  platformUserId: string;
  role: PlatformRole;
}

export async function listStaff(db: Db) {
  const rows = await db.select().from(platformUsers).orderBy(asc(platformUsers.name));
  return rows.map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role, status: p.status, version: p.version, lastSignInAt: p.lastSignInAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString() }));
}

/**
 * Every change to platform access runs under ONE lock, re-reads the actor inside the transaction (an actor suspended a
 * moment ago can no longer act) and refuses anything that would leave no active Platform Owner. Two owners suspending
 * each other at the same instant therefore cannot both succeed.
 */
async function lockStaff(tx: DbOrTx, actor: StaffActor): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('platform-staff'))`);
  const [me] = await tx.select({ status: platformUsers.status, role: platformUsers.role }).from(platformUsers).where(eq(platformUsers.id, actor.platformUserId)).limit(1);
  return !!me && me.status === "ACTIVE" && me.role === actor.role;
}

async function activeOwnersExcept(tx: DbOrTx, id: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(platformUsers).where(and(eq(platformUsers.role, "PLATFORM_OWNER"), eq(platformUsers.status, "ACTIVE"), sql`${platformUsers.id} <> ${id}::uuid`));
  return r?.n ?? 0;
}

export async function inviteStaff(db: Db, input: z.infer<typeof inviteStaffSchema>, actor: StaffActor): Promise<Result<{ id: string; invitation: { id: string; deliveryStatus: string } }>> {
  if (!canManagePlatformRole(actor.role, input.role)) return { ok: false, reason: "forbidden", status: 403 };
  let issued: IssuedToken | null = null;
  const r = await db.transaction(async (tx) => {
    if (!(await lockStaff(tx, actor))) return { ok: false as const, reason: "forbidden", status: 403 };
    const [existing] = await tx.select().from(platformUsers).where(sql`lower(${platformUsers.email}) = ${input.email}`).limit(1);
    if (existing) return { ok: false as const, reason: "already_member", status: 409 };
    const [p] = await tx.insert(platformUsers).values({ name: input.name, email: input.email, role: input.role, status: "INVITED", createdBy: actor.platformUserId }).returning({ id: platformUsers.id });
    issued = await issueAccountToken(tx, { platformUserId: p!.id, purpose: "INVITE", tenantId: null, email: input.email, role: input.role, createdBy: actor.platformUserId });
    await recordPlatformAudit(tx, actor, { action: "staff.invited", summary: `Invited ${input.email} as ${input.role}`, targetType: "platform_user", targetId: p!.id, metadata: { role: input.role } });
    return { ok: true as const, id: p!.id };
  });
  if (!r.ok) return r;
  const sent: IssuedToken = issued!;
  return { ok: true, id: r.id, invitation: { id: sent.id, deliveryStatus: await deliverAccountToken(db, sent, { name: input.name, workspace: null }) } };
}

export async function changeStaffRole(db: Db, id: string, input: z.infer<typeof staffRoleSchema>, actor: StaffActor): Promise<Result<object>> {
  if (!UUID.test(id)) return { ok: false, reason: "not_found", status: 404 };
  if (id === actor.platformUserId) return { ok: false, reason: "self_change", status: 409 };
  return db.transaction(async (tx) => {
    if (!(await lockStaff(tx, actor))) return { ok: false as const, reason: "forbidden", status: 403 };
    const [p] = await tx.select().from(platformUsers).where(eq(platformUsers.id, id)).limit(1);
    if (!p) return { ok: false as const, reason: "not_found", status: 404 };
    if (!canManagePlatformRole(actor.role, p.role) || !canManagePlatformRole(actor.role, input.role)) return { ok: false as const, reason: "forbidden", status: 403 };
    if (p.version !== input.version) return { ok: false as const, reason: "stale_version", status: 409 };
    if (p.role === "PLATFORM_OWNER" && input.role !== "PLATFORM_OWNER" && p.status === "ACTIVE" && (await activeOwnersExcept(tx, id)) === 0) return { ok: false as const, reason: "last_platform_owner", status: 409 };
    await tx.update(platformUsers).set({ role: input.role, updatedAt: new Date(), version: p.version + 1 }).where(eq(platformUsers.id, id));
    await recordPlatformAudit(tx, actor, { action: "staff.role_changed", summary: `${p.email}: ${p.role} → ${input.role}`, targetType: "platform_user", targetId: id, metadata: { from: p.role, to: input.role } });
    return { ok: true as const };
  });
}

export async function changeStaffStatus(db: Db, id: string, action: "suspend" | "reactivate", reason: string, actor: StaffActor): Promise<Result<object>> {
  if (!UUID.test(id)) return { ok: false, reason: "not_found", status: 404 };
  if (id === actor.platformUserId) return { ok: false, reason: "self_change", status: 409 };
  return db.transaction(async (tx) => {
    if (!(await lockStaff(tx, actor))) return { ok: false as const, reason: "forbidden", status: 403 };
    const [p] = await tx.select().from(platformUsers).where(eq(platformUsers.id, id)).limit(1);
    if (!p) return { ok: false as const, reason: "not_found", status: 404 };
    if (!canManagePlatformRole(actor.role, p.role)) return { ok: false as const, reason: "forbidden", status: 403 };
    const now = new Date();
    if (action === "suspend") {
      if (p.status === "SUSPENDED") return { ok: false as const, reason: "invalid_transition", status: 409 };
      if (p.role === "PLATFORM_OWNER" && p.status === "ACTIVE" && (await activeOwnersExcept(tx, id)) === 0) return { ok: false as const, reason: "last_platform_owner", status: 409 };
      await tx.update(platformUsers).set({ status: "SUSPENDED", updatedAt: now, version: p.version + 1 }).where(eq(platformUsers.id, id));
      await tx.delete(platformSessions).where(eq(platformSessions.platformUserId, id));
      await tx.update(accountTokens).set({ status: "REVOKED", revokedAt: now }).where(and(eq(accountTokens.platformUserId, id), eq(accountTokens.status, "PENDING")));
    } else {
      if (p.status !== "SUSPENDED") return { ok: false as const, reason: "invalid_transition", status: 409 };
      await tx.update(platformUsers).set({ status: p.passwordHash ? "ACTIVE" : "INVITED", updatedAt: now, version: p.version + 1 }).where(eq(platformUsers.id, id));
    }
    await recordPlatformAudit(tx, actor, { action: action === "suspend" ? "staff.suspended" : "staff.reactivated", summary: `${action === "suspend" ? "Suspended" : "Reactivated"} platform access of ${p.email}`, targetType: "platform_user", targetId: id, reason });
    return { ok: true as const };
  });
}

/** End a platform staff member's console sessions (one, or all). Staff may always end their own. */
export async function revokeStaffSessions(db: Db, id: string, sessionId: string | null, actor: StaffActor): Promise<Result<{ revoked: number }>> {
  if (!UUID.test(id) || (sessionId !== null && !UUID.test(sessionId))) return { ok: false, reason: "not_found", status: 404 };
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(platformUsers).where(eq(platformUsers.id, id)).limit(1);
    if (!p) return { ok: false as const, reason: "not_found", status: 404 };
    if (id !== actor.platformUserId && !canManagePlatformRole(actor.role, p.role)) return { ok: false as const, reason: "forbidden", status: 403 };
    const ended = await tx
      .delete(platformSessions)
      .where(and(eq(platformSessions.platformUserId, id), ...(sessionId ? [eq(platformSessions.id, sessionId)] : [])))
      .returning({ id: platformSessions.id });
    if (sessionId && ended.length === 0) return { ok: false as const, reason: "not_found", status: 404 };
    await recordPlatformAudit(tx, actor, { action: "platform_session.revoked", summary: `Ended ${ended.length} console session(s) of ${p.email}`, targetType: "platform_user", targetId: id, metadata: { revoked: ended.length, one: !!sessionId } });
    return { ok: true as const, revoked: ended.length };
  });
}
