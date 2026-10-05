import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { activityLog, users } from "../../db/schema.js";
import { inLocalRange, isRealDate, tenantTimezone } from "../../lib/hospital-time.js";
import { redactLogText } from "../security/redact.js";

/** Keys whose VALUES are never kept, whatever they hold. */
const SECRET_KEY = /secret|token|password|passwd|credential|authorization|api[_-]?key|private|signing/i;

/** Safe metadata only: scalars and short lists of scalars, secret-named keys dropped, text redacted and truncated. */
export function scrubMetadata(input: unknown, depth = 0): unknown {
  if (input === null || typeof input === "boolean" || typeof input === "number") return input;
  if (typeof input === "string") return redactLogText(input.slice(0, 200)) ?? "";
  if (Array.isArray(input)) return depth > 2 ? [] : input.slice(0, 20).map((v) => scrubMetadata(v, depth + 1));
  if (typeof input === "object" && depth <= 2) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) {
        out[k] = "[not recorded]";
        continue;
      }
      out[k] = scrubMetadata(v, depth + 1);
    }
    return out;
  }
  return null;
}

export interface ActivityInput {
  tenantId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityKey?: string | null;
  metadata?: Record<string, unknown>;
}

/** Record that a setting changed. Call inside the same transaction as the change when there is one. */
export async function recordActivity(db: Db, a: ActivityInput): Promise<void> {
  await db.insert(activityLog).values({ tenantId: a.tenantId, actorId: a.actorId, action: a.action, entityType: a.entityType, entityKey: a.entityKey ?? null, metadata: scrubMetadata(a.metadata ?? {}) as Record<string, unknown> });
}

export interface ActivityRow {
  id: string;
  at: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityKey: string | null;
  metadata: Record<string, unknown>;
}

export async function listActivity(db: Db, tenantId: string, f: { action?: string; entityType?: string; from?: string; to?: string; limit?: number }): Promise<ActivityRow[]> {
  const tz = await tenantTimezone(db, tenantId);
  const conds = [eq(activityLog.tenantId, tenantId)];
  if (f.action) conds.push(eq(activityLog.action, f.action));
  if (f.entityType) conds.push(eq(activityLog.entityType, f.entityType));
  if (f.from && f.to && isRealDate(f.from) && isRealDate(f.to)) conds.push(inLocalRange(activityLog.createdAt, tz, f.from, f.to));
  const rows = await db
    .select({ a: activityLog, actor: users.name })
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .where(and(...conds))
    .orderBy(desc(activityLog.createdAt))
    .limit(Math.min(f.limit ?? 100, 200));
  return rows.map(({ a, actor }) => ({ id: a.id, at: a.createdAt.toISOString(), actorName: actor ?? null, action: a.action, entityType: a.entityType, entityKey: a.entityKey, metadata: (a.metadata as Record<string, unknown>) ?? {} }));
}


import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * onResponse hook for a settings plugin: every SUCCESSFUL change (POST/PATCH/PUT/DELETE under `pathPrefix`) is recorded as
 * who + which setting + which field NAMES changed. Request values are never copied, so nothing sensitive can end up here.
 */
export function auditSettingsChanges(app: { db: Db }, entityType: string, pathPrefix: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.method === "GET" || reply.statusCode >= 300 || !request.sessionUser || !request.url.startsWith(pathPrefix)) return;
    const params = request.params as { id?: string } | undefined;
    const path = request.url.split("?")[0]!.slice(pathPrefix.length).replace(/^\//, "");
    const verb = path === "reorder" ? "reordered" : request.method === "POST" ? "created" : request.method === "DELETE" ? "deleted" : (request.body as { archived?: boolean } | null)?.archived === true ? "archived" : "updated";
    const body = (request.body ?? {}) as Record<string, unknown>;
    await recordActivity(app.db, {
      tenantId: request.sessionUser.tenantId,
      actorId: request.sessionUser.id,
      action: `${entityType}.${verb}`,
      entityType,
      entityKey: params?.id ?? null,
      metadata: { changedFields: Object.keys(body).slice(0, 20) },
    });
  };
}
