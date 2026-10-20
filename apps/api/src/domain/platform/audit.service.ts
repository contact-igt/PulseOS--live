import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { DbOrTx } from "../../db/client.js";
import { platformAuditEvents } from "../../db/schema.js";
import { scrubMetadata } from "../activity/activity.service.js";

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILURE";
export type AuditContextKind = "PLATFORM" | "SUPPORT_MODE" | "SYSTEM";

/** Who did it and from where. Built from the request, never from anything the request body claims. */
export interface AuditActor {
  platformUserId: string | null;
  /** A snapshot of the actor's email (or the attempted email for a failed sign-in): the trail outlives the account. */
  label: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEvent {
  action: string;
  summary: string;
  outcome?: AuditOutcome;
  targetType?: string | null;
  targetId?: string | null;
  tenantId?: string | null;
  context?: AuditContextKind;
  supportSessionId?: string | null;
  reason?: string | null;
  /** Identifiers and flags only; secret-shaped keys are dropped and text is redacted before it is stored. */
  metadata?: Record<string, unknown>;
}

export function actorFromRequest(request: FastifyRequest): AuditActor {
  const u = request.platformUser;
  return { platformUserId: u?.id ?? null, label: u?.email ?? "anonymous", ip: request.ip, userAgent: userAgentOf(request) };
}

export function userAgentOf(request: FastifyRequest): string | null {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 200) : null;
}

/** Append one event to the platform audit trail. Call inside the same transaction as the change it describes. */
export async function recordPlatformAudit(db: DbOrTx, actor: AuditActor, e: AuditEvent): Promise<void> {
  await db.insert(platformAuditEvents).values({
    actorPlatformUserId: actor.platformUserId,
    actorLabel: actor.label.slice(0, 254),
    action: e.action,
    outcome: e.outcome ?? "SUCCESS",
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    tenantId: e.tenantId ?? null,
    context: e.context ?? "PLATFORM",
    supportSessionId: e.supportSessionId ?? null,
    summary: e.summary.slice(0, 300),
    reason: e.reason ? e.reason.slice(0, 500) : null,
    metadata: scrubMetadata(e.metadata ?? {}) as Record<string, unknown>,
    ipAddress: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

export interface AuditFilters {
  q?: string;
  action?: string;
  outcome?: AuditOutcome;
  tenantId?: string;
  actorId?: string;
  context?: AuditContextKind;
  /** Security view: denials, failures and the security-relevant actions. */
  security?: boolean;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/** Actions that matter to the security view even when they succeeded. */
export const SECURITY_ACTIONS = [
  "platform.login",
  "platform.permission_denied",
  "account.suspended",
  "account.reactivated",
  "membership.suspended",
  "session.revoked",
  "sessions.revoked_all",
  "platform_session.revoked",
  "support.started",
  "support.edits_enabled",
  "staff.role_changed",
  "staff.suspended",
  "tenant.suspended",
  "password_reset.sent",
];

export async function listPlatformAudit(db: DbOrTx, f: AuditFilters) {
  const conds: SQL[] = [];
  if (f.action) conds.push(eq(platformAuditEvents.action, f.action));
  if (f.outcome) conds.push(eq(platformAuditEvents.outcome, f.outcome));
  if (f.tenantId) conds.push(eq(platformAuditEvents.tenantId, f.tenantId));
  if (f.actorId) conds.push(eq(platformAuditEvents.actorPlatformUserId, f.actorId));
  if (f.context) conds.push(eq(platformAuditEvents.context, f.context));
  if (f.from) conds.push(gte(platformAuditEvents.createdAt, f.from));
  if (f.to) conds.push(lt(platformAuditEvents.createdAt, f.to));
  if (f.security) {
    const list = sql.join(SECURITY_ACTIONS.map((a) => sql`${a}`), sql`, `);
    conds.push(or(sql`${platformAuditEvents.outcome} <> 'SUCCESS'`, sql`${platformAuditEvents.action} in (${list})`)!);
  }
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(platformAuditEvents.summary, like), ilike(platformAuditEvents.actorLabel, like), ilike(platformAuditEvents.action, like))!);
  }
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(platformAuditEvents)
      .where(where)
      .orderBy(desc(platformAuditEvents.createdAt), desc(platformAuditEvents.id))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(platformAuditEvents).where(where),
  ]);
  return { rows, total: count?.n ?? 0 };
}
