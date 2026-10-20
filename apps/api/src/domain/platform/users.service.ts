import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../../db/client.js";
import { accountTokens, platformAuditEvents, platformSessions, platformUsers, sessions, tenants, users } from "../../db/schema.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";
import { deliverAccountToken, issueAccountToken, type IssuedToken } from "./account-tokens.service.js";
import { UUID } from "./tenants.service.js";

// A "person" is an email: one or more tenant accounts (memberships - each a `users` row with its own role, status and
// credential) and, for Invictus staff, a platform account. Nothing here ever reads, returns or sets a password.

const TENANT_ROLES = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as const;
const ADMIN_ROLES = ["SUPER_ADMIN", "HOSPITAL_ADMIN"];
type Result<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number; detail?: unknown };

export const listUsersSchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    status: z.enum(["active", "invited", "suspended"]).optional(),
    kind: z.enum(["staff", "client"]).optional(),
    tenantId: z.string().regex(UUID).optional(),
    role: z.enum([...TENANT_ROLES, "PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN", "SUPPORT_AGENT", "PLATFORM_AUDITOR"]).optional(),
    sort: z.enum(["name", "created", "lastSignIn"]).default("name"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

type DirectoryRow = {
  e: string;
  name: string;
  key: string;
  created_at: Date;
  last_sign_in_at: Date | null;
  memberships: { userId: string; tenantId: string; tenantName: string; tenantStatus: string; role: string; status: string }[] | null;
  platform_role: string | null;
  platform_status: string | null;
  platform_user_id: string | null;
  any_active: boolean;
  any_invited: boolean;
  any_suspended: boolean;
  total: number;
};

function identityStatus(r: Pick<DirectoryRow, "any_active" | "any_invited" | "any_suspended">): "ACTIVE" | "INVITED" | "SUSPENDED" | "REMOVED" {
  return r.any_active ? "ACTIVE" : r.any_invited ? "INVITED" : r.any_suspended ? "SUSPENDED" : "REMOVED";
}

/** Every account of every person, grouped by email - one SQL statement, filtered, sorted and paged in the database. */
const ACCOUNTS = sql`
  select lower(u.email) as e, u.id, u.name, u.created_at, u.last_sign_in_at, 'tenant' as kind, u.tenant_id, t.name as tenant_name, t.status::text as tenant_status, u.role::text as role, u.status::text as status
  from ${users} u join ${tenants} t on t.id = u.tenant_id where not u.is_system
  union all
  select lower(p.email), p.id, p.name, p.created_at, p.last_sign_in_at, 'platform', null, null, null, p.role::text, p.status::text from ${platformUsers} p`;

export async function listUsers(db: Db, f: z.infer<typeof listUsersSchema>) {
  const where: ReturnType<typeof sql>[] = [];
  if (f.q) {
    const q = like(f.q);
    where.push(sql`(ids.e ilike ${q} or ids.name ilike ${q} or exists (select 1 from acct a where a.e = ids.e and (a.name ilike ${q} or a.tenant_name ilike ${q})))`);
  }
  if (f.status === "active") where.push(sql`ids.any_active`);
  if (f.status === "invited") where.push(sql`ids.any_invited`);
  if (f.status === "suspended") where.push(sql`ids.any_suspended`);
  if (f.kind === "staff") where.push(sql`ids.platform_user_id is not null`);
  if (f.kind === "client") where.push(sql`ids.memberships is not null`);
  if (f.tenantId) where.push(sql`exists (select 1 from acct a where a.e = ids.e and a.tenant_id = ${f.tenantId}::uuid${f.role ? sql` and a.role = ${f.role}` : sql``})`);
  else if (f.role) where.push(sql`exists (select 1 from acct a where a.e = ids.e and a.role = ${f.role})`);
  const order = f.sort === "created" ? sql`ids.created_at desc` : f.sort === "lastSignIn" ? sql`ids.last_sign_in_at desc nulls last` : sql`lower(ids.name) asc`;
  const rows = (await db.execute(sql`
    with acct as (${ACCOUNTS}),
    ids as (
      select e,
        (array_agg(name order by created_at desc))[1] as name,
        (array_agg(id order by (kind = 'tenant') desc, created_at))[1]::text as key,
        min(created_at) as created_at,
        max(last_sign_in_at) as last_sign_in_at,
        json_agg(json_build_object('userId', id, 'tenantId', tenant_id, 'tenantName', tenant_name, 'tenantStatus', tenant_status, 'role', role, 'status', status) order by created_at) filter (where kind = 'tenant') as memberships,
        max(case when kind = 'platform' then role end) as platform_role,
        max(case when kind = 'platform' then status end) as platform_status,
        max(case when kind = 'platform' then id::text end) as platform_user_id,
        coalesce(bool_or(status = 'ACTIVE'), false) as any_active,
        coalesce(bool_or(status = 'INVITED'), false) as any_invited,
        coalesce(bool_or(status = 'SUSPENDED'), false) as any_suspended
      from acct group by e
    )
    select ids.*, count(*) over() as total from ids
    ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
    order by ${order}, ids.e
    limit ${f.pageSize} offset ${(f.page - 1) * f.pageSize}`)) as unknown as DirectoryRow[];
  return {
    rows: rows.map((r) => ({
      key: r.key,
      name: r.name,
      email: r.e,
      status: identityStatus(r),
      memberships: r.memberships ?? [],
      platform: r.platform_user_id ? { id: r.platform_user_id, role: r.platform_role!, status: r.platform_status! } : null,
      lastSignInAt: r.last_sign_in_at ? new Date(r.last_sign_in_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total: Number(rows[0]?.total ?? 0),
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** The email behind any account id (tenant account or platform account). */
async function emailOfAccount(db: DbOrTx, accountId: string): Promise<string | null> {
  if (!UUID.test(accountId)) return null;
  const [u] = await db.select({ email: users.email, isSystem: users.isSystem }).from(users).where(eq(users.id, accountId)).limit(1);
  if (u) return u.isSystem ? null : u.email.toLowerCase();
  const [p] = await db.select({ email: platformUsers.email }).from(platformUsers).where(eq(platformUsers.id, accountId)).limit(1);
  return p?.email.toLowerCase() ?? null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** One person: identity, memberships, platform access, open sessions (device metadata), invitations and admin history. */
export async function getUserDetail(db: Db, accountId: string) {
  const email = await emailOfAccount(db, accountId);
  if (!email) return null;
  const memberships = await db
    .select({ u: users, tenantName: tenants.name, tenantStatus: tenants.status, tenantSlug: tenants.loginSlug, primaryAdmin: tenants.primaryAdminUserId })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.isSystem, false)))
    .orderBy(users.createdAt);
  const [platform] = await db.select().from(platformUsers).where(sql`lower(${platformUsers.email}) = ${email}`).limit(1);
  const userIds = memberships.map((m) => m.u.id);
  const now = new Date();
  const tenantSessions = userIds.length
    ? await db.select({ s: sessions, tenantName: tenants.name }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).innerJoin(tenants, eq(tenants.id, users.tenantId)).where(and(inArray(sessions.userId, userIds), gt(sessions.expiresAt, now))).orderBy(desc(sessions.createdAt))
    : [];
  const consoleSessions = platform ? await db.select().from(platformSessions).where(and(eq(platformSessions.platformUserId, platform.id), gt(platformSessions.expiresAt, now))).orderBy(desc(platformSessions.createdAt)) : [];
  const tokenConds = [...(userIds.length ? [inArray(accountTokens.userId, userIds)] : []), ...(platform ? [eq(accountTokens.platformUserId, platform.id)] : [])];
  const tokens = tokenConds.length ? await db.select({ t: accountTokens, tenantName: tenants.name }).from(accountTokens).leftJoin(tenants, eq(tenants.id, accountTokens.tenantId)).where(or(...tokenConds)).orderBy(desc(accountTokens.createdAt)).limit(20) : [];
  const targetIds = [...userIds, ...(platform ? [platform.id] : [])];
  const history = await db.select().from(platformAuditEvents).where(inArray(platformAuditEvents.targetId, targetIds)).orderBy(desc(platformAuditEvents.createdAt)).limit(30);

  const all = [...memberships.map((m) => m.u), ...(platform ? [platform] : [])];
  const status = all.some((a) => a.status === "ACTIVE") ? "ACTIVE" : all.some((a) => a.status === "INVITED") ? "INVITED" : all.some((a) => a.status === "SUSPENDED") ? "SUSPENDED" : "REMOVED";
  const lastSignIn = all.map((a) => a.lastSignInAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    key: accountId,
    email,
    name: [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.name,
    status,
    createdAt: iso(all.map((a) => a.createdAt).sort((a, b) => a.getTime() - b.getTime())[0]),
    lastSignInAt: iso(lastSignIn),
    memberships: memberships.map((m) => ({
      userId: m.u.id,
      tenantId: m.u.tenantId,
      tenantName: m.tenantName,
      tenantStatus: m.tenantStatus,
      tenantSlug: m.tenantSlug,
      role: m.u.role,
      status: m.u.status,
      version: m.u.version,
      primaryAdmin: m.primaryAdmin === m.u.id,
      lastSignInAt: iso(m.u.lastSignInAt),
      createdAt: iso(m.u.createdAt),
    })),
    platform: platform ? { id: platform.id, role: platform.role, status: platform.status, version: platform.version, lastSignInAt: iso(platform.lastSignInAt), createdAt: iso(platform.createdAt) } : null,
    sessions: [
      ...tenantSessions.map(({ s, tenantName }) => ({ id: s.id, kind: "tenant" as const, userId: s.userId, context: tenantName, userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt), expiresAt: iso(s.expiresAt) })),
      ...consoleSessions.map((s) => ({ id: s.id, kind: "platform" as const, userId: s.platformUserId, context: "Platform Console", userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt), expiresAt: iso(s.expiresAt) })),
    ],
    invitations: tokens.map(({ t, tenantName }) => ({ id: t.id, purpose: t.purpose, status: tokenStatus(t), tenantName, role: t.role, deliveryStatus: t.deliveryStatus, sendCount: t.sendCount, createdAt: iso(t.createdAt), expiresAt: iso(t.expiresAt), acceptedAt: iso(t.acceptedAt) })),
    history: history.map((h) => ({ id: h.id, at: iso(h.createdAt), action: h.action, outcome: h.outcome, actor: h.actorLabel, summary: h.summary, reason: h.reason, context: h.context })),
  };
}

export function tokenStatus(t: { status: string; expiresAt: Date }): "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" {
  if (t.status === "PENDING" && t.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  return t.status as "PENDING" | "ACCEPTED" | "REVOKED";
}

/**
 * Would this change leave a live hospital (onboarding or active) with no active administrator? Checked under a lock on the
 * tenant row so two admins acting at once cannot both remove "the other" admin.
 */
async function leavesNoAdmin(tx: DbOrTx, tenantId: string, losingAdminIds: string[]): Promise<boolean> {
  const [t] = await tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).for("update").limit(1);
  if (!t || (t.status !== "ACTIVE" && t.status !== "ONBOARDING")) return false;
  const remaining = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.status, "ACTIVE"), eq(users.isSystem, false), inArray(users.role, ADMIN_ROLES as ("SUPER_ADMIN" | "HOSPITAL_ADMIN")[]), ...(losingAdminIds.length ? [sql`${users.id} not in (${sql.join(losingAdminIds.map((id) => sql`${id}::uuid`), sql`, `)})`] : [])));
  return remaining.length === 0;
}

async function loadMembership(tx: DbOrTx, userId: string) {
  if (!UUID.test(userId)) return null;
  const [row] = await tx.select({ u: users, tenantName: tenants.name }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId)).where(and(eq(users.id, userId), eq(users.isSystem, false))).for("update", { of: users }).limit(1);
  return row ?? null;
}

export const addMemberSchema = z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email().max(254), role: z.enum(TENANT_ROLES) }).strict();

/**
 * Add a person to a hospital: a new INVITED account (or a previously removed one brought back as INVITED) and an
 * invitation link. The person chooses their own password; nobody at Invictus ever sees or sets it.
 */
export async function addMembership(db: Db, tenantId: string, input: z.infer<typeof addMemberSchema>, actor: AuditActor): Promise<Result<{ userId: string; invitation: { id: string; deliveryStatus: string } }>> {
  if (!UUID.test(tenantId)) return { ok: false, reason: "not_found", status: 404 };
  let issued: IssuedToken | null = null;
  let tenantName = "";
  const r = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    if (t.status === "ARCHIVED") return { ok: false as const, reason: "tenant_archived", status: 409 };
    tenantName = t.name;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`membership:${tenantId}:${input.email}`}))`);
    const [existing] = await tx.select().from(users).where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${input.email}`)).limit(1);
    let userId: string;
    if (existing) {
      if (existing.status !== "REMOVED" || existing.isSystem) return { ok: false as const, reason: "already_member", status: 409 };
      await tx.update(users).set({ status: "INVITED", passwordHash: null, role: input.role, name: input.name, updatedAt: new Date(), version: existing.version + 1 }).where(eq(users.id, existing.id));
      userId = existing.id;
    } else {
      const [u] = await tx.insert(users).values({ tenantId, name: input.name, email: input.email, role: input.role, status: "INVITED", passwordHash: null }).returning({ id: users.id });
      userId = u!.id;
    }
    issued = await issueAccountToken(tx, { userId, purpose: "INVITE", tenantId, email: input.email, role: input.role, createdBy: actor.platformUserId });
    await recordPlatformAudit(tx, actor, { action: "membership.added", summary: `Added ${input.email} to ${t.name} as ${input.role}`, targetType: "user", targetId: userId, tenantId, metadata: { role: input.role, rejoined: !!existing } });
    await recordPlatformAudit(tx, actor, { action: "invitation.created", summary: `Invited ${input.email} to ${t.name}`, targetType: "user", targetId: userId, tenantId, metadata: { role: input.role } });
    return { ok: true as const, userId };
  });
  if (!r.ok) return r;
  const sent: IssuedToken = issued!;
  return { ok: true, userId: r.userId, invitation: { id: sent.id, deliveryStatus: await deliverAccountToken(db, sent, { name: input.name, workspace: tenantName }) } };
}

export const changeRoleSchema = z.object({ role: z.enum(TENANT_ROLES), version: z.number().int().positive(), confirmNoAdmin: z.boolean().optional() }).strict();

/** Change a membership's tenant role. Authorization reads the role on every request, so it applies to the next request. */
export async function changeMembershipRole(db: Db, userId: string, input: z.infer<typeof changeRoleSchema>, actor: AuditActor): Promise<Result<object>> {
  return db.transaction(async (tx) => {
    const m = await loadMembership(tx, userId);
    if (!m) return { ok: false as const, reason: "not_found", status: 404 };
    if (m.u.version !== input.version) return { ok: false as const, reason: "stale_version", status: 409 };
    if (m.u.role === input.role) return { ok: true as const };
    const demotesAdmin = ADMIN_ROLES.includes(m.u.role) && !ADMIN_ROLES.includes(input.role) && m.u.status === "ACTIVE";
    if (demotesAdmin && !input.confirmNoAdmin && (await leavesNoAdmin(tx, m.u.tenantId, [m.u.id]))) return { ok: false as const, reason: "last_tenant_admin", status: 409 };
    await tx.update(users).set({ role: input.role, updatedAt: new Date(), version: m.u.version + 1 }).where(eq(users.id, userId));
    await recordPlatformAudit(tx, actor, { action: "membership.role_changed", summary: `${m.u.email} in ${m.tenantName}: ${m.u.role} → ${input.role}`, targetType: "user", targetId: userId, tenantId: m.u.tenantId, metadata: { from: m.u.role, to: input.role, confirmedNoAdmin: !!input.confirmNoAdmin && demotesAdmin } });
    return { ok: true as const };
  });
}

export const reasonSchema = z.object({ reason: z.string().trim().min(5).max(500), confirmNoAdmin: z.boolean().optional() }).strict();

/**
 * Suspend / reactivate / remove one membership. Suspension and removal end that account's sessions and pending links at
 * once; removal keeps the row (history, journeys and audit stay intact) and never touches the person's other memberships.
 */
export async function changeMembershipStatus(db: Db, userId: string, action: "suspend" | "reactivate" | "remove", input: z.infer<typeof reasonSchema>, actor: AuditActor): Promise<Result<object>> {
  return db.transaction(async (tx) => {
    const m = await loadMembership(tx, userId);
    if (!m) return { ok: false as const, reason: "not_found", status: 404 };
    const u = m.u;
    const now = new Date();
    if (action === "reactivate") {
      if (u.status !== "SUSPENDED") return { ok: false as const, reason: "invalid_transition", status: 409 };
      await tx.update(users).set({ status: u.passwordHash ? "ACTIVE" : "INVITED", updatedAt: now, version: u.version + 1 }).where(eq(users.id, userId));
      await recordPlatformAudit(tx, actor, { action: "membership.reactivated", summary: `Reactivated ${u.email} in ${m.tenantName}`, targetType: "user", targetId: userId, tenantId: u.tenantId, reason: input.reason });
      return { ok: true as const };
    }
    if (action === "suspend" && u.status === "SUSPENDED") return { ok: false as const, reason: "invalid_transition", status: 409 };
    if (u.status === "REMOVED") return { ok: false as const, reason: "invalid_transition", status: 409 };
    if (ADMIN_ROLES.includes(u.role) && u.status === "ACTIVE" && !input.confirmNoAdmin && (await leavesNoAdmin(tx, u.tenantId, [u.id]))) return { ok: false as const, reason: "last_tenant_admin", status: 409 };
    await tx.update(users).set({ status: action === "suspend" ? "SUSPENDED" : "REMOVED", updatedAt: now, version: u.version + 1 }).where(eq(users.id, userId));
    const ended = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await tx.update(accountTokens).set({ status: "REVOKED", revokedAt: now }).where(and(eq(accountTokens.userId, userId), eq(accountTokens.status, "PENDING")));
    await tx.update(tenants).set({ primaryAdminUserId: null }).where(and(eq(tenants.id, u.tenantId), eq(tenants.primaryAdminUserId, userId)));
    await recordPlatformAudit(tx, actor, {
      action: action === "suspend" ? "membership.suspended" : "membership.removed",
      summary: `${action === "suspend" ? "Suspended" : "Removed"} ${u.email} in ${m.tenantName}`,
      targetType: "user",
      targetId: userId,
      tenantId: u.tenantId,
      reason: input.reason,
      metadata: { endedSessions: ended.length, confirmedNoAdmin: !!input.confirmNoAdmin },
    });
    return { ok: true as const };
  });
}

/** Suspend or reactivate a person everywhere they are a member (their platform access, if any, is managed separately). */
export async function changeIdentityStatus(db: Db, accountId: string, action: "suspend" | "reactivate", input: z.infer<typeof reasonSchema>, actor: AuditActor): Promise<Result<{ affected: number }>> {
  return db.transaction(async (tx) => {
    const email = await emailOfAccount(tx, accountId);
    if (!email) return { ok: false as const, reason: "not_found", status: 404 };
    const accounts = await tx.select().from(users).where(and(sql`lower(${users.email}) = ${email}`, eq(users.isSystem, false))).for("update");
    const now = new Date();
    if (action === "suspend") {
      const targets = accounts.filter((a) => a.status === "ACTIVE" || a.status === "INVITED");
      if (!input.confirmNoAdmin) {
        const blocked: string[] = [];
        for (const a of targets) if (ADMIN_ROLES.includes(a.role) && a.status === "ACTIVE" && (await leavesNoAdmin(tx, a.tenantId, [a.id]))) blocked.push(a.tenantId);
        if (blocked.length) return { ok: false as const, reason: "last_tenant_admin", status: 409, detail: blocked };
      }
      const ids = targets.map((a) => a.id);
      if (ids.length) {
        await tx.update(users).set({ status: "SUSPENDED", updatedAt: now, version: sql`${users.version} + 1` }).where(inArray(users.id, ids));
        await tx.delete(sessions).where(inArray(sessions.userId, ids));
        await tx.update(accountTokens).set({ status: "REVOKED", revokedAt: now }).where(and(inArray(accountTokens.userId, ids), eq(accountTokens.status, "PENDING")));
      }
      await recordPlatformAudit(tx, actor, { action: "account.suspended", summary: `Suspended ${email} in ${ids.length} hospital(s)`, targetType: "user", targetId: accountId, reason: input.reason, metadata: { memberships: ids } });
      return { ok: true as const, affected: ids.length };
    }
    const targets = accounts.filter((a) => a.status === "SUSPENDED");
    for (const a of targets) await tx.update(users).set({ status: a.passwordHash ? "ACTIVE" : "INVITED", updatedAt: now, version: a.version + 1 }).where(eq(users.id, a.id));
    await recordPlatformAudit(tx, actor, { action: "account.reactivated", summary: `Reactivated ${email} in ${targets.length} hospital(s)`, targetType: "user", targetId: accountId, reason: input.reason, metadata: { memberships: targets.map((a) => a.id) } });
    return { ok: true as const, affected: targets.length };
  });
}

/** Send a password-reset link to an active membership. The link replaces any earlier unused one. */
export async function sendPasswordReset(db: Db, userId: string, actor: AuditActor): Promise<Result<{ deliveryStatus: string }>> {
  let issued: IssuedToken | null = null;
  let ctx = { name: "", workspace: "" };
  const r = await db.transaction(async (tx) => {
    const m = await loadMembership(tx, userId);
    if (!m) return { ok: false as const, reason: "not_found", status: 404 };
    if (m.u.status !== "ACTIVE") return { ok: false as const, reason: m.u.status === "INVITED" ? "use_invitation" : "account_unavailable", status: 409 };
    ctx = { name: m.u.name, workspace: m.tenantName };
    issued = await issueAccountToken(tx, { userId, purpose: "PASSWORD_RESET", tenantId: m.u.tenantId, email: m.u.email, role: m.u.role, createdBy: actor.platformUserId });
    await recordPlatformAudit(tx, actor, { action: "password_reset.sent", summary: `Sent a password reset link to ${m.u.email} (${m.tenantName})`, targetType: "user", targetId: userId, tenantId: m.u.tenantId });
    return { ok: true as const };
  });
  if (!r.ok) return r;
  return { ok: true, deliveryStatus: await deliverAccountToken(db, issued!, ctx) };
}

/** End every open session of one membership. */
export async function revokeMembershipSessions(db: Db, userId: string, actor: AuditActor): Promise<Result<{ revoked: number }>> {
  return db.transaction(async (tx) => {
    const m = await loadMembership(tx, userId);
    if (!m) return { ok: false as const, reason: "not_found", status: 404 };
    const ended = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await recordPlatformAudit(tx, actor, { action: "sessions.revoked_all", summary: `Signed ${m.u.email} out everywhere in ${m.tenantName} (${ended.length} session(s))`, targetType: "user", targetId: userId, tenantId: m.u.tenantId, metadata: { revoked: ended.length } });
    return { ok: true as const, revoked: ended.length };
  });
}

/** End one tenant session. */
export async function revokeTenantSession(db: Db, sessionId: string, actor: AuditActor): Promise<Result<object>> {
  if (!UUID.test(sessionId)) return { ok: false, reason: "not_found", status: 404 };
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ s: sessions, u: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.id, sessionId)).limit(1);
    if (!row) return { ok: false as const, reason: "not_found", status: 404 };
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await recordPlatformAudit(tx, actor, { action: "session.revoked", summary: `Ended one session of ${row.u.email}`, targetType: "user", targetId: row.u.id, tenantId: row.u.tenantId, metadata: { sessionCreatedAt: row.s.createdAt.toISOString() } });
    return { ok: true as const };
  });
}

/** Tenant memberships of one hospital (Users tab of the tenant detail). */
export async function listTenantMembers(db: Db, tenantId: string) {
  if (!UUID.test(tenantId)) return null;
  const [t] = await db.select({ id: tenants.id, primary: tenants.primaryAdminUserId }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) return null;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, version: users.version, lastSignInAt: users.lastSignInAt, createdAt: users.createdAt, sessions: sql<number>`(select count(*) from ${sessions} s where s.user_id = ${users.id} and s.expires_at > now())::int` })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.isSystem, false), ne(users.status, "REMOVED")))
    .orderBy(users.createdAt);
  return { members: rows.map((r) => ({ ...r, primaryAdmin: r.id === t.primary, lastSignInAt: iso(r.lastSignInAt), createdAt: iso(r.createdAt) })) };
}
