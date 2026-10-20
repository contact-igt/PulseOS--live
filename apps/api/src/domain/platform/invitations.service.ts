import { and, desc, eq, gt, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { accountTokens, platformUsers, tenants, users } from "../../db/schema.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";
import { deliverAccountToken, issueAccountToken, type IssuedToken } from "./account-tokens.service.js";
import { UUID } from "./tenants.service.js";
import { tokenStatus } from "./users.service.js";

export const listInvitationsSchema = z
  .object({
    status: z.enum(["pending", "accepted", "expired", "revoked"]).optional(),
    tenantId: z.string().regex(UUID).optional(),
    kind: z.enum(["tenant", "platform"]).optional(),
    q: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const inviter = alias(platformUsers, "inviter");

/** Invitations (never password resets, never a token or its hash). Expired = pending past its expiry. */
export async function listInvitations(db: Db, f: z.infer<typeof listInvitationsSchema>) {
  const now = new Date();
  const conds: SQL[] = [eq(accountTokens.purpose, "INVITE")];
  if (f.status === "pending") conds.push(eq(accountTokens.status, "PENDING"), gt(accountTokens.expiresAt, now));
  if (f.status === "expired") conds.push(eq(accountTokens.status, "PENDING"), lte(accountTokens.expiresAt, now));
  if (f.status === "accepted") conds.push(eq(accountTokens.status, "ACCEPTED"));
  if (f.status === "revoked") conds.push(eq(accountTokens.status, "REVOKED"));
  if (f.tenantId) conds.push(eq(accountTokens.tenantId, f.tenantId));
  if (f.kind === "platform") conds.push(sql`${accountTokens.platformUserId} is not null`);
  if (f.kind === "tenant") conds.push(sql`${accountTokens.userId} is not null`);
  if (f.q) {
    const q = `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(${accountTokens.email} ilike ${q} or coalesce(${tenants.name}, '') ilike ${q})`);
  }
  const where = and(...conds);
  const [rows, [count], summary] = await Promise.all([
    db
      .select({ t: accountTokens, tenantName: tenants.name, invitedBy: inviter.name })
      .from(accountTokens)
      .leftJoin(tenants, eq(tenants.id, accountTokens.tenantId))
      .leftJoin(inviter, eq(inviter.id, accountTokens.createdByPlatformUserId))
      .where(where)
      .orderBy(desc(accountTokens.createdAt))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(accountTokens).leftJoin(tenants, eq(tenants.id, accountTokens.tenantId)).where(where),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${accountTokens.status} = 'PENDING' and ${accountTokens.expiresAt} > now())::int`,
        expired: sql<number>`count(*) filter (where ${accountTokens.status} = 'PENDING' and ${accountTokens.expiresAt} <= now())::int`,
        accepted: sql<number>`count(*) filter (where ${accountTokens.status} = 'ACCEPTED')::int`,
        revoked: sql<number>`count(*) filter (where ${accountTokens.status} = 'REVOKED')::int`,
      })
      .from(accountTokens)
      .where(eq(accountTokens.purpose, "INVITE")),
  ]);
  return {
    rows: rows.map(({ t, tenantName, invitedBy }) => ({
      id: t.id,
      email: t.email,
      tenantId: t.tenantId,
      tenantName: tenantName ?? null,
      kind: t.platformUserId ? ("platform" as const) : ("tenant" as const),
      accountId: t.platformUserId ?? t.userId!,
      role: t.role,
      invitedBy: invitedBy ?? null,
      status: tokenStatus(t),
      deliveryStatus: t.deliveryStatus,
      sendCount: t.sendCount,
      createdAt: t.createdAt.toISOString(),
      lastSentAt: t.lastSentAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
      acceptedAt: t.acceptedAt?.toISOString() ?? null,
    })),
    total: count?.n ?? 0,
    page: f.page,
    pageSize: f.pageSize,
    summary: summary[0] ?? { pending: 0, expired: 0, accepted: 0, revoked: 0 },
  };
}

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number };

/**
 * Send a fresh link for a pending or expired invitation whose account is still waiting (never an accepted or revoked one).
 * The old link stops working; the new one has the full lifetime again.
 */
export async function resendInvitation(db: Db, id: string, actor: AuditActor): Promise<Result<{ invitation: { id: string; deliveryStatus: string } }>> {
  if (!UUID.test(id)) return { ok: false, reason: "not_found", status: 404 };
  let issued: IssuedToken | null = null;
  let ctx = { name: "", workspace: null as string | null };
  const r = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(accountTokens).where(and(eq(accountTokens.id, id), eq(accountTokens.purpose, "INVITE"))).for("update").limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    if (t.status !== "PENDING") return { ok: false as const, reason: "not_pending", status: 409 };
    if (t.userId) {
      const [u] = await tx.select({ u: users, tenantName: tenants.name, tenantStatus: tenants.status }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId)).where(eq(users.id, t.userId)).limit(1);
      if (!u || u.u.status !== "INVITED") return { ok: false as const, reason: "not_pending", status: 409 };
      if (u.tenantStatus === "ARCHIVED" || u.tenantStatus === "SUSPENDED") return { ok: false as const, reason: "workspace_unavailable", status: 409 };
      ctx = { name: u.u.name, workspace: u.tenantName };
      issued = await issueAccountToken(tx, { userId: t.userId, purpose: "INVITE", tenantId: t.tenantId, email: t.email, role: t.role, createdBy: actor.platformUserId });
    } else {
      const [p] = await tx.select().from(platformUsers).where(eq(platformUsers.id, t.platformUserId!)).limit(1);
      if (!p || p.status !== "INVITED") return { ok: false as const, reason: "not_pending", status: 409 };
      ctx = { name: p.name, workspace: null };
      issued = await issueAccountToken(tx, { platformUserId: p.id, purpose: "INVITE", tenantId: null, email: t.email, role: t.role, createdBy: actor.platformUserId });
    }
    await tx.update(accountTokens).set({ sendCount: t.sendCount + 1 }).where(eq(accountTokens.id, issued!.id));
    await recordPlatformAudit(tx, actor, { action: "invitation.resent", summary: `Resent the invitation to ${t.email}`, targetType: t.userId ? "user" : "platform_user", targetId: t.userId ?? t.platformUserId, tenantId: t.tenantId });
    return { ok: true as const };
  });
  if (!r.ok) return r;
  const sent: IssuedToken = issued!;
  return { ok: true, invitation: { id: sent.id, deliveryStatus: await deliverAccountToken(db, sent, ctx) } };
}

export async function revokeInvitation(db: Db, id: string, reason: string, actor: AuditActor): Promise<Result<object>> {
  if (!UUID.test(id)) return { ok: false, reason: "not_found", status: 404 };
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(accountTokens).where(and(eq(accountTokens.id, id), eq(accountTokens.purpose, "INVITE"))).for("update").limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    if (t.status !== "PENDING") return { ok: false as const, reason: "not_pending", status: 409 };
    await tx.update(accountTokens).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(accountTokens.id, id));
    await recordPlatformAudit(tx, actor, { action: "invitation.revoked", summary: `Revoked the invitation to ${t.email}`, targetType: t.userId ? "user" : "platform_user", targetId: t.userId ?? t.platformUserId, tenantId: t.tenantId, reason });
    return { ok: true as const };
  });
}
