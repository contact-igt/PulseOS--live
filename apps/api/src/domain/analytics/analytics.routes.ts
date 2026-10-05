import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AnalyticsQuery } from "@pulseos/types";
import { getAdsAnalytics } from "../ads/ads-analytics.service.js";
import { requireCapability, requirePermission } from "../auth/permission.middleware.js";
import {
  AnalyticsInputError,
  getAnalyticsCampaigns,
  getAnalyticsFilterOptions,
  getAnalyticsFlow,
  getAnalyticsFunnel,
  getAnalyticsRevenue,
  getAnalyticsServices,
  getAnalyticsSummary,
  getAnalyticsTeam,
  getLeadsBySource,
  getSourceConversion,
} from "./analytics.service.js";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

// Unknown keys (e.g. a smuggled tenantId) are stripped — tenant always comes from the session.
const querySchema = z.object({
  range: opt(z.enum(["today", "yesterday", "7d", "9d", "14d", "30d", "90d", "this_month", "prev_month", "last_month", "custom"])),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  branchId: opt(z.string().uuid()),
  service: opt(z.string().min(1).max(120)),
  source: opt(z.enum(["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"])),
  campaignId: opt(z.string().uuid()),
});

function parse(request: FastifyRequest, reply: FastifyReply): AnalyticsQuery | null {
  const result = querySchema.safeParse(request.query);
  if (!result.success) {
    reply.status(400).send({ error: "invalid_query", issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return null;
  }
  return result.data as AnalyticsQuery;
}

type Handler<T> = (query: AnalyticsQuery, tenantId: string) => Promise<T>;

export async function analyticsRoutes(app: FastifyInstance) {
  // Marketing spend / ROAS and revenue are both on this workspace, so a caller
  // needs both permissions (in practice: the admin roles).
  app.addHook("preHandler", requirePermission("VIEW_MARKETING"));
  app.addHook("preHandler", requirePermission("VIEW_REVENUE"));

  // Beta V1 keeps lead-source volume/trend and source conversion (no spend); everything else here is
  // marketing analytics (spend, ROAS, revenue attribution, campaigns) and needs the growth capability.
  const V1_OPEN = new Set(["leads", "source-conversion", "filter-options"]);

  function route<T>(path: string, handler: Handler<T>) {
    const gate = V1_OPEN.has(path) ? [requireCapability("ANALYTICS_CORE")] : [requireCapability("MARKETING_ANALYTICS")];
    app.get(`/analytics/${path}`, { preHandler: gate }, async (request, reply) => {
      const query = parse(request, reply);
      if (!query) return reply;
      try {
        return await handler(query, request.sessionUser!.tenantId);
      } catch (err) {
        if (err instanceof AnalyticsInputError) return reply.status(400).send({ error: "invalid_query", message: err.message });
        throw err;
      }
    });
  }

  route("summary", (q, t) => getAnalyticsSummary(app.db, t, q));
  route("leads", (q, t) => getLeadsBySource(app.db, t, q));
  route("funnel", (q, t) => getAnalyticsFunnel(app.db, t, q));
  route("source-conversion", (q, t) => getSourceConversion(app.db, t, q));
  route("revenue", (q, t) => getAnalyticsRevenue(app.db, t, q));
  route("campaigns", (q, t) => getAnalyticsCampaigns(app.db, t, q));
  route("services", (q, t) => getAnalyticsServices(app.db, t, q));
  route("flow", (q, t) => getAnalyticsFlow(app.db, t, q));
  route("team", (q, t) => getAnalyticsTeam(app.db, t, q));
  route("ads", (q, t) => getAdsAnalytics(app.db, t, q));
  route("filter-options", (_q, t) => getAnalyticsFilterOptions(app.db, t));
}
