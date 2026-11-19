import { and, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectors, hospitalLifecycleAudit, hospitalMessagingCommands as commands, hospitalOnboardings as onboarding, platformAuditLog, platformSecurityAudit, tenants } from "../../db/schema.js";
import { HOSPITAL_MESSAGING_ALERT_AGE_MS } from "../tenant/hospital-messaging.service.js";

const directoryProjection = {
  tenantId: tenants.id,
  onboardingId: onboarding.id,
  name: tenants.name,
  slug: tenants.loginSlug,
  edition: tenants.edition,
  createdAt: tenants.createdAt,
  active: tenants.loginEnabled,
  lifecycleStatus: tenants.lifecycleStatus,
  template: onboarding.templateStatus,
  redeemedAt: onboarding.invitationRedeemedAt,
  expiresAt: onboarding.invitationExpiresAt,
};

export async function hospitalDirectory(db: Db, limit: number, offset: number, search = "", tenantId?: string) {
  const term = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  const rows = await db.select(directoryProjection).from(tenants)
    .leftJoin(onboarding, eq(onboarding.tenantId, tenants.id))
    .where(and(
      search ? or(ilike(tenants.name, term), ilike(tenants.loginSlug, term)) : undefined,
      tenantId ? eq(tenants.id, tenantId) : undefined,
    )).orderBy(desc(tenants.createdAt), desc(tenants.id)).limit(limit + 1).offset(offset);
  const now = Date.now();
  return {
    hasMore: rows.length > limit,
    items: rows.slice(0, limit).map(({ expiresAt, redeemedAt, ...row }) => ({
      ...row,
      id: row.onboardingId ?? row.tenantId,
      loginPath: row.slug ? "/login/" + row.slug : null,
      provisioning: "created" as const,
      template: row.template ?? "none",
      invitation: !row.onboardingId ? "not_applicable" : redeemedAt ? "accepted" : !expiresAt ? "not_issued"
        : expiresAt.getTime() > now ? "pending" : "expired",
    })),
  };
}

export async function auditPage(db: Db, limit: number, offset: number, tenantId?: string) {
  const readLimit = limit + offset + 1;
  const [operations, security, lifecycle] = await Promise.all([
    db.select({
      id: platformAuditLog.id, actorId: platformAuditLog.actorId, browserActorId: platformAuditLog.browserActorId,
      action: platformAuditLog.action, reason: platformAuditLog.reason, subjectId: platformAuditLog.onboardingId, createdAt: platformAuditLog.createdAt,
    }).from(platformAuditLog).where(tenantId ? sql`exists (select 1 from ${onboarding} where ${onboarding.id} = ${platformAuditLog.onboardingId} and ${onboarding.tenantId} = ${tenantId})` : undefined)
      .orderBy(desc(platformAuditLog.createdAt), desc(platformAuditLog.id)).limit(readLimit),
    tenantId ? Promise.resolve([]) : db.select({
      id: platformSecurityAudit.id, actorId: platformSecurityAudit.actorId, action: platformSecurityAudit.action,
      subjectId: platformSecurityAudit.subjectId, createdAt: platformSecurityAudit.createdAt,
    }).from(platformSecurityAudit).orderBy(desc(platformSecurityAudit.createdAt), desc(platformSecurityAudit.id)).limit(readLimit),
    db.select({
      id: hospitalLifecycleAudit.id, actorId: sql<string | null>`coalesce(${hospitalLifecycleAudit.actorId}, ${hospitalLifecycleAudit.operatorId})`,
      action: hospitalLifecycleAudit.action, reason: hospitalLifecycleAudit.outcome, subjectId: hospitalLifecycleAudit.tenantId, createdAt: hospitalLifecycleAudit.createdAt,
    }).from(hospitalLifecycleAudit).where(tenantId ? eq(hospitalLifecycleAudit.tenantId, tenantId) : undefined)
      .orderBy(desc(hospitalLifecycleAudit.createdAt), desc(hospitalLifecycleAudit.id)).limit(readLimit),
  ]);
  const rows = [
    ...operations.map(({ browserActorId, ...row }) => ({ ...row, actorId: browserActorId ?? row.actorId, category: "onboarding" })),
    ...security.map((row) => ({ ...row, reason: null, category: "security" })),
    ...lifecycle.map((row) => ({ ...row, category: "lifecycle" })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return { items: rows.slice(offset, offset + limit), hasMore: rows.length > offset + limit };
}

export async function platformDashboard(db: Db, includeSecurity: boolean) {
  const cutoff = new Date(Date.now() - HOSPITAL_MESSAGING_ALERT_AGE_MS);
  const [[hospitals], [onboardings], recent, audit, [coordination], [integration]] = await Promise.all([
    db.select({ total: count(), active: count(sql`case when ${tenants.lifecycleStatus} = 'ACTIVE' then 1 end`), loginDisabled: count(sql`case when not ${tenants.loginEnabled} then 1 end`), suspended: count(sql`case when ${tenants.lifecycleStatus} = 'SUSPENDED' then 1 end`),
      provisioning: count(sql`case when ${tenants.lifecycleStatus} = 'PROVISIONING' then 1 end`) }).from(tenants),
    db.select({
      pending: count(sql`case when ${onboarding.tenantId} is null or ${tenants.lifecycleStatus} = 'PROVISIONING' then 1 end`),
      templateFailures: count(sql`case when ${onboarding.templateStatus} = 'failed' then 1 end`),
      failedOnboarding: count(sql`case when ${onboarding.provisioningError} is not null or ${onboarding.templateStatus} = 'failed' then 1 end`),
      pendingInvitations: count(sql`case when ${and(
        isNotNull(onboarding.tenantId), isNull(onboarding.invitationRedeemedAt), gt(onboarding.invitationExpiresAt, new Date()),
      )} then 1 end`),
    }).from(onboarding).leftJoin(tenants, eq(tenants.id, onboarding.tenantId)),
    hospitalDirectory(db, 5, 0),
    includeSecurity ? auditPage(db, 5, 0) : Promise.resolve(null),
    db.select({
      pendingCommands: count(sql`case when ${commands.status} = 'pending' then 1 end`),
      failedCommands: count(sql`case when ${commands.status} = 'failed' then 1 end`),
      agedCommands: count(sql`case when ${and(eq(commands.status, "pending"), lte(commands.createdAt, cutoff))} then 1 end`),
    }).from(commands),
    db.select({ integrationProblems: sql<number>`count(distinct ${connectors.tenantId})`.mapWith(Number) }).from(connectors)
      .where(and(eq(connectors.mode, "LIVE"), inArray(connectors.status, ["DEGRADED", "ERROR"]))),
  ]);
  return {
    total: hospitals!.total, active: hospitals!.active, loginDisabled: hospitals!.loginDisabled, suspended: hospitals!.suspended,
    provisioning: hospitals!.provisioning, ...onboardings!, ...coordination!, ...integration!,
    recentHospitals: recent.items, recentAudit: audit?.items ?? [],
  };
}

export async function messagingExceptions(db: Db, limit: number, offset: number, status?: "failed" | "pending", tenantId?: string) {
  const rows = await db.select({
    id: commands.id, tenantId: commands.tenantId, hospitalName: tenants.name, onboardingId: onboarding.id,
    action: commands.action, status: commands.status, classification: commands.error,
    createdAt: commands.createdAt, verifiedAt: commands.verifiedAt, attempts: commands.attempts,
  }).from(commands).innerJoin(tenants, eq(tenants.id, commands.tenantId))
    .leftJoin(onboarding, eq(onboarding.tenantId, tenants.id))
    .where(and(status ? eq(commands.status, status) : inArray(commands.status, ["pending", "failed"]),
      tenantId ? eq(commands.tenantId, tenantId) : undefined))
    .orderBy(desc(commands.createdAt), desc(commands.id)).limit(limit + 1).offset(offset);
  const now = Date.now();
  return { hasMore: rows.length > limit, items: rows.slice(0, limit).map((row) => ({
    ...row, pendingMinutes: row.status === "pending" ? Math.max(0, Math.floor((now - +row.createdAt) / 60_000)) : null,
  })) };
}
