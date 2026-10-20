import { and, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { hasPlatformPermission, type PlatformSessionUser, type SessionUser } from "@pulseos/types";
import type { Db, DbOrTx } from "../../db/client.js";
import { platformUsers, supportSessions, tenants, users } from "../../db/schema.js";
import { resolveTenantCapabilities } from "../capability/capability.service.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";
import { getPlatformSettings } from "./platform-settings.service.js";
import { UUID } from "./tenants.service.js";

// Support Mode: a platform staff member sees one hospital the way its admin does - for a stated reason, for a limited time,
// under a persistent banner that names them. Read-only unless edits were explicitly enabled (another reason, a shorter
// limit). It is never invisible and never masquerades: the session carries the staff member's identity, every write is
// recorded in the platform audit as that staff member in Support Mode, and inside the hospital's own records the actor is
// the hospital's "PulseOS Support" system account - never a client user.

export const SUPPORT_COOKIE = "pulseos_support";
const SUPPORT_ACCOUNT_NAME = "PulseOS Support";

export const startSupportSchema = z.object({ reason: z.string().trim().min(5).max(500), minutes: z.number().int().min(5).max(480).optional() }).strict();
export const enableEditsSchema = z.object({ reason: z.string().trim().min(5).max(500), minutes: z.number().int().min(5).max(120) }).strict();

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number };

/** The hospital's "PulseOS Support" account: the actor of record for audited support edits. Never signs in, never listed as staff. */
async function ensureSupportAccount(tx: DbOrTx, tenantId: string): Promise<string> {
  const [existing] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.isSystem, true))).limit(1);
  if (existing) return existing.id;
  const [created] = await tx
    .insert(users)
    .values({ tenantId, name: SUPPORT_ACCOUNT_NAME, email: `support@${tenantId}.support.pulseos.invalid`, role: "HOSPITAL_ADMIN", status: "ACTIVE", isSystem: true, passwordHash: null })
    .returning({ id: users.id });
  return created!.id;
}

export interface SupportSessionVm {
  id: string;
  tenantId: string;
  tenantName: string;
  staffName: string;
  staffEmail: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  active: boolean;
  writeEnabled: boolean;
  writeExpiresAt: string | null;
  writeReason: string | null;
}

function vm(s: typeof supportSessions.$inferSelect, tenantName: string, staff: { name: string; email: string }): SupportSessionVm {
  const now = Date.now();
  const active = !s.endedAt && s.expiresAt.getTime() > now;
  return {
    id: s.id,
    tenantId: s.tenantId,
    tenantName,
    staffName: staff.name,
    staffEmail: staff.email,
    reason: s.reason,
    startedAt: s.startedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    endReason: s.endReason,
    active,
    writeEnabled: active && !!s.writeExpiresAt && s.writeExpiresAt.getTime() > now,
    writeExpiresAt: s.writeExpiresAt?.toISOString() ?? null,
    writeReason: s.writeReason,
  };
}

/** Start Support Mode for one hospital. A staff member has at most one active support session; starting another ends it. */
export async function startSupportSession(db: Db, tenantId: string, input: z.infer<typeof startSupportSchema>, actor: AuditActor & { platformUserId: string }): Promise<Result<{ session: SupportSessionVm }>> {
  if (!UUID.test(tenantId)) return { ok: false, reason: "not_found", status: 404 };
  const settings = await getPlatformSettings(db);
  const minutes = Math.min(input.minutes ?? settings.supportSessionDefaultMinutes, settings.supportSessionMaxMinutes);
  return db.transaction(async (tx) => {
    const [t] = await tx.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    const [staff] = await tx.select({ name: platformUsers.name, email: platformUsers.email }).from(platformUsers).where(eq(platformUsers.id, actor.platformUserId)).limit(1);
    const now = new Date();
    const previous = await tx
      .update(supportSessions)
      .set({ endedAt: now, endReason: "replaced" })
      .where(and(eq(supportSessions.platformUserId, actor.platformUserId), isNull(supportSessions.endedAt), gt(supportSessions.expiresAt, now)))
      .returning({ id: supportSessions.id, tenantId: supportSessions.tenantId });
    for (const p of previous) await recordPlatformAudit(tx, actor, { action: "support.ended", summary: "Support session replaced by a new one", targetType: "support_session", targetId: p.id, tenantId: p.tenantId, context: "SUPPORT_MODE", supportSessionId: p.id, metadata: { endReason: "replaced" } });
    await ensureSupportAccount(tx, tenantId);
    const [s] = await tx.insert(supportSessions).values({ platformUserId: actor.platformUserId, tenantId, reason: input.reason, expiresAt: new Date(now.getTime() + minutes * 60_000) }).returning();
    await recordPlatformAudit(tx, actor, { action: "support.started", summary: `Opened ${t.name} in Support Mode (read-only, ${minutes} min)`, targetType: "support_session", targetId: s!.id, tenantId, context: "SUPPORT_MODE", supportSessionId: s!.id, reason: input.reason, metadata: { minutes } });
    return { ok: true as const, session: vm(s!, t.name, staff!) };
  });
}

async function loadOwn(tx: DbOrTx, id: string, platformUserId: string) {
  if (!UUID.test(id)) return null;
  const [row] = await tx.select({ s: supportSessions, tenantName: tenants.name }).from(supportSessions).innerJoin(tenants, eq(tenants.id, supportSessions.tenantId)).where(and(eq(supportSessions.id, id), eq(supportSessions.platformUserId, platformUserId))).for("update", { of: supportSessions }).limit(1);
  return row ?? null;
}

/** Enable support edits on your own active session: a separate reason and a shorter limit, never beyond the session itself. */
export async function enableSupportEdits(db: Db, id: string, input: z.infer<typeof enableEditsSchema>, actor: AuditActor & { platformUserId: string }): Promise<Result<{ session: SupportSessionVm }>> {
  const settings = await getPlatformSettings(db);
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, id, actor.platformUserId);
    if (!row) return { ok: false as const, reason: "not_found", status: 404 };
    const now = new Date();
    if (row.s.endedAt || row.s.expiresAt <= now) return { ok: false as const, reason: "support_session_ended", status: 409 };
    const minutes = Math.min(input.minutes, settings.supportEditsMaxMinutes);
    const until = new Date(Math.min(now.getTime() + minutes * 60_000, row.s.expiresAt.getTime()));
    const [s] = await tx.update(supportSessions).set({ writeEnabledAt: now, writeExpiresAt: until, writeReason: input.reason }).where(eq(supportSessions.id, id)).returning();
    await recordPlatformAudit(tx, actor, { action: "support.edits_enabled", summary: `Enabled support edits in ${row.tenantName} until ${until.toISOString()}`, targetType: "support_session", targetId: id, tenantId: row.s.tenantId, context: "SUPPORT_MODE", supportSessionId: id, reason: input.reason, metadata: { minutes } });
    const [staff] = await tx.select({ name: platformUsers.name, email: platformUsers.email }).from(platformUsers).where(eq(platformUsers.id, actor.platformUserId)).limit(1);
    return { ok: true as const, session: vm(s!, row.tenantName, staff!) };
  });
}

/** End your own support session (or just switch edits off). */
export async function endSupportSession(db: Db, id: string, mode: "end" | "disable-edits", actor: AuditActor & { platformUserId: string }): Promise<Result<object>> {
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, id, actor.platformUserId);
    if (!row) return { ok: false as const, reason: "not_found", status: 404 };
    const now = new Date();
    if (row.s.endedAt) return { ok: true as const };
    if (mode === "disable-edits") {
      await tx.update(supportSessions).set({ writeExpiresAt: now }).where(eq(supportSessions.id, id));
      await recordPlatformAudit(tx, actor, { action: "support.edits_disabled", summary: `Switched support edits off in ${row.tenantName}`, targetType: "support_session", targetId: id, tenantId: row.s.tenantId, context: "SUPPORT_MODE", supportSessionId: id });
      return { ok: true as const };
    }
    await tx.update(supportSessions).set({ endedAt: now, endReason: "ended", writeExpiresAt: row.s.writeExpiresAt && row.s.writeExpiresAt > now ? now : row.s.writeExpiresAt }).where(eq(supportSessions.id, id));
    await recordPlatformAudit(tx, actor, { action: "support.ended", summary: `Left Support Mode for ${row.tenantName}`, targetType: "support_session", targetId: id, tenantId: row.s.tenantId, context: "SUPPORT_MODE", supportSessionId: id, metadata: { durationSeconds: Math.round((now.getTime() - row.s.startedAt.getTime()) / 1000) } });
    return { ok: true as const };
  });
}

export const listSupportSchema = z
  .object({ tenantId: z.string().regex(UUID).optional(), active: z.enum(["true", "false"]).optional(), mine: z.enum(["true", "false"]).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

export async function listSupportSessions(db: Db, f: z.infer<typeof listSupportSchema>, me: string) {
  const conds: SQL[] = [];
  if (f.tenantId) conds.push(eq(supportSessions.tenantId, f.tenantId));
  if (f.mine === "true") conds.push(eq(supportSessions.platformUserId, me));
  if (f.active === "true") conds.push(isNull(supportSessions.endedAt), gt(supportSessions.expiresAt, new Date()));
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [c]] = await Promise.all([
    db
      .select({ s: supportSessions, tenantName: tenants.name, staffName: platformUsers.name, staffEmail: platformUsers.email })
      .from(supportSessions)
      .innerJoin(tenants, eq(tenants.id, supportSessions.tenantId))
      .innerJoin(platformUsers, eq(platformUsers.id, supportSessions.platformUserId))
      .where(where)
      .orderBy(desc(supportSessions.startedAt))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(supportSessions).where(where),
  ]);
  return { rows: rows.map((r) => vm(r.s, r.tenantName, { name: r.staffName, email: r.staffEmail })), total: c?.n ?? 0, page: f.page, pageSize: f.pageSize };
}

export interface SupportContext {
  staff: PlatformSessionUser & { sessionId: string };
  session: SupportSessionVm;
}

/**
 * Resolve a support session into a tenant session user - only for the SAME staff member's live platform session, only
 * while the support session is active, and only while that staff member may start support sessions.
 */
export async function resolveSupportSession(db: Db, supportId: string, staff: PlatformSessionUser & { sessionId: string }): Promise<{ user: SessionUser; context: SupportContext } | null> {
  if (!UUID.test(supportId) || !hasPlatformPermission(staff.role, "START_SUPPORT_SESSION")) return null;
  const now = new Date();
  const [row] = await db
    .select({ s: supportSessions, t: tenants })
    .from(supportSessions)
    .innerJoin(tenants, eq(tenants.id, supportSessions.tenantId))
    .where(and(eq(supportSessions.id, supportId), eq(supportSessions.platformUserId, staff.id), isNull(supportSessions.endedAt), gt(supportSessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  const [account] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, row.t.id), eq(users.isSystem, true))).limit(1);
  if (!account) return null;
  const session = vm(row.s, row.t.name, staff);
  const user: SessionUser = {
    id: account.id,
    tenantId: row.t.id,
    tenantName: row.t.name,
    loginSlug: row.t.loginSlug,
    name: `${SUPPORT_ACCOUNT_NAME} (${staff.name})`,
    email: staff.email,
    role: "HOSPITAL_ADMIN",
    branchId: null,
    branchName: null,
    timezone: row.t.timezone,
    surfaceStyle: (row.t.surfaceStyle as SessionUser["surfaceStyle"]) ?? "balanced",
    edition: row.t.edition,
    capabilities: await resolveTenantCapabilities(db, row.t.id, row.t.edition),
    support: { sessionId: session.id, staffName: staff.name, staffEmail: staff.email, expiresAt: session.expiresAt, writeEnabled: session.writeEnabled, writeExpiresAt: session.writeExpiresAt, tenantStatus: row.t.status },
  };
  return { user, context: { staff, session } };
}
