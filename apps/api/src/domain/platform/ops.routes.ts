import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listActivity } from "../activity/activity.service.js";
import { actorFromRequest, listPlatformAudit, recordPlatformAudit } from "./audit.service.js";
import { getPlatformHealth } from "./health.service.js";
import { notFound, parse } from "./http.js";
import { requirePlatform } from "./platform-guard.js";
import { getPlatformSettings, PLATFORM_SETTING_DEFAULTS, platformSettingsSchema, savePlatformSettings } from "./platform-settings.service.js";
import { emailProvider } from "./email.js";
import { loadTenant, UUID } from "./tenants.service.js";

const auditQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    action: z.string().trim().max(80).optional(),
    outcome: z.enum(["SUCCESS", "DENIED", "FAILURE"]).optional(),
    tenantId: z.string().regex(UUID).optional(),
    actorId: z.string().regex(UUID).optional(),
    context: z.enum(["PLATFORM", "SUPPORT_MODE", "SYSTEM"]).optional(),
    security: z.enum(["true", "false", "1", "0"]).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const istDay = (d: string) => new Date(`${d}T00:00:00+05:30`);

export async function platformOpsRoutes(app: FastifyInstance) {
  // Audit & security ---------------------------------------------------------------------------------------------------
  app.get("/platform/audit", { preHandler: requirePlatform("VIEW_AUDIT") }, async (request, reply) => {
    const q = parse(auditQuery, request.query, reply);
    if (!q) return reply;
    const r = await listPlatformAudit(app.db, {
      ...q,
      security: q.security === "true" || q.security === "1",
      from: q.from ? istDay(q.from) : undefined,
      to: q.to ? new Date(istDay(q.to).getTime() + 86_400_000) : undefined,
    });
    return {
      rows: r.rows.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), actor: e.actorLabel, actorId: e.actorPlatformUserId, action: e.action, outcome: e.outcome, targetType: e.targetType, targetId: e.targetId, tenantId: e.tenantId, context: e.context, supportSessionId: e.supportSessionId, summary: e.summary, reason: e.reason, metadata: e.metadata, ipAddress: e.ipAddress, userAgent: e.userAgent })),
      total: r.total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get<{ Params: { id: string } }>("/platform/tenants/:id/audit", { preHandler: requirePlatform("VIEW_AUDIT") }, async (request, reply) => {
    const t = await loadTenant(app.db, request.params.id);
    if (!t) return notFound(reply);
    const [platform, tenantActivity] = await Promise.all([listPlatformAudit(app.db, { tenantId: t.id, page: 1, pageSize: 50 }), listActivity(app.db, t.id, { limit: 50 })]);
    return {
      platform: platform.rows.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), actor: e.actorLabel, action: e.action, outcome: e.outcome, context: e.context, summary: e.summary, reason: e.reason })),
      tenantActivity: tenantActivity.map((a) => ({ id: a.id, at: a.at, actor: a.actorName ?? (a.metadata.by ? String(a.metadata.by) : "PulseOS"), action: a.action, entityType: a.entityType, entityKey: a.entityKey })),
    };
  });

  // Health ----------------------------------------------------------------------------------------------------------------
  app.get("/platform/health", { preHandler: requirePlatform("VIEW_PLATFORM") }, async () => getPlatformHealth(app.db));

  // Settings --------------------------------------------------------------------------------------------------------------
  app.get("/platform/settings", { preHandler: requirePlatform("VIEW_PLATFORM") }, async () => ({ settings: await getPlatformSettings(app.db), defaults: PLATFORM_SETTING_DEFAULTS, emailProvider: emailProvider().name }));
  app.put("/platform/settings", { preHandler: requirePlatform("MANAGE_PLATFORM_SETTINGS") }, async (request, reply) => {
    const body = parse(platformSettingsSchema, request.body, reply);
    if (!body) return reply;
    const changed = await app.db.transaction(async (tx) => {
      const before = await getPlatformSettings(tx);
      const keys = await savePlatformSettings(tx, body, request.platformUser!.id);
      if (keys.length) await recordPlatformAudit(tx, actorFromRequest(request), { action: "platform_settings.updated", summary: `Changed platform settings: ${keys.join(", ")}`, targetType: "platform_settings", metadata: { changes: Object.fromEntries(keys.map((k) => [k, { from: before[k as keyof typeof before], to: body[k as keyof typeof body] }])) } });
      return keys;
    });
    return { settings: await getPlatformSettings(app.db), changed };
  });
}
