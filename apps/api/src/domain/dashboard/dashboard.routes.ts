import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { capabilityEnabled, type DashboardPeriod } from "@pulseos/types";
import { requireCapability, requirePermission } from "../auth/permission.middleware.js";
import {
  getAttentionQueue,
  getBranchDoctorPerformance,
  getConversionFunnel,
  getExecutiveStrip,
  getJourneyHealth,
  getMarketingSources,
  getPatientFlow,
  getServiceMix,
  getSetupStatus,
  getSourcePerformance,
  getSpendAtRisk,
  getSpendAtRiskByReason,
  getTeamWorkload,
  getTodayStrip,
  listBranches,
  listJourneyTypes,
  type DashboardFilters,
} from "./dashboard.service.js";
import { AnalyticsInputError, resolvePeriod } from "../analytics/period.js";
import { getPerformanceDashboard } from "./performance.service.js";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

// Unknown keys (e.g. a smuggled tenantId) are stripped — tenant always comes from the session.
// `range`/`from`/`to` are the shared Analytics presets, resolved in the hospital's timezone. No range = all time.
const querySchema = z.object({
  range: opt(z.enum(["today", "yesterday", "7d", "9d", "14d", "30d", "90d", "this_month", "prev_month", "last_month", "custom"])),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  branchId: opt(z.string().uuid()),
  journeyType: opt(z.string().min(1).max(120)),
});

/** Validated branch/service filters plus the resolved period; a malformed query is answered here with 400. */
async function dashboardFilters(request: FastifyRequest, reply: FastifyReply): Promise<DashboardFilters | null> {
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) {
    reply.status(400).send({ error: "invalid_query", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return null;
  }
  const { range, from, to, branchId, journeyType } = parsed.data;
  const filters: DashboardFilters = {};
  if (branchId) filters.branchId = branchId;
  if (journeyType) filters.journeyType = journeyType;
  if (range) {
    try {
      const p = await resolvePeriod(request.server.db, request.sessionUser!.tenantId, { range, from, to });
      const period: DashboardPeriod = { preset: p.preset, from: p.from, to: p.to, days: p.days, timezone: p.timezone, today: p.today };
      filters.period = period;
    } catch (err) {
      if (err instanceof AnalyticsInputError) {
        reply.status(400).send({ error: "invalid_query", message: err.message });
        return null;
      }
      throw err;
    }
  } else if (from || to) {
    reply.status(400).send({ error: "invalid_query", message: "from/to need a range of 'custom'" });
    return null;
  }
  return filters;
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("VIEW_ADMIN_COMMAND_CENTRE"));

  app.get("/branches", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return listBranches(app.db, tenantId);
  });

  app.get("/journey-types", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return listJourneyTypes(app.db, tenantId);
  });

  app.get("/dashboard/setup-status", async (request) => getSetupStatus(app.db, request.sessionUser!.tenantId));

  app.get("/dashboard/today", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getTodayStrip(app.db, tenantId, filters, request.sessionUser!.timezone, capabilityEnabled(request.sessionUser!.capabilities, "REVENUE_TRACKING"));
  });

  // The owner's Performance view: funnel, rule-based findings, source / service / team breakdowns. No revenue, so every hospital has it.
  app.get("/dashboard/performance", async (request, reply) => {
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getPerformanceDashboard(app.db, request.sessionUser!.tenantId, filters);
  });

  app.get("/dashboard/executive", { preHandler: requireCapability("SPEND_ATTRIBUTION") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getExecutiveStrip(app.db, tenantId, filters);
  });

  app.get("/dashboard/conversion", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    const stages = await getConversionFunnel(app.db, tenantId, filters);
    // Cost per outcome is derived from marketing spend, which a Beta V1 tenant does not see.
    return capabilityEnabled(request.sessionUser!.capabilities, "SPEND_ATTRIBUTION") ? stages : stages.map((s) => ({ ...s, costPerOutcome: null }));
  });

  app.get("/dashboard/journey-health", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getJourneyHealth(app.db, tenantId, filters);
  });

  app.get("/dashboard/patient-flow", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getPatientFlow(app.db, tenantId, filters, request.sessionUser!.timezone);
  });

  app.get("/dashboard/attention", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getAttentionQueue(app.db, tenantId, filters);
  });

  app.get("/dashboard/spend-at-risk", { preHandler: requireCapability("SPEND_ATTRIBUTION") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getSpendAtRisk(app.db, tenantId, filters);
  });

  app.get("/dashboard/spend-at-risk-by-reason", { preHandler: requireCapability("SPEND_ATTRIBUTION") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getSpendAtRiskByReason(app.db, tenantId, filters);
  });

  app.get("/dashboard/source-performance", { preHandler: requireCapability("SPEND_ATTRIBUTION") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getSourcePerformance(app.db, tenantId, filters);
  });

  app.get("/dashboard/marketing", { preHandler: requireCapability("SPEND_ATTRIBUTION") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getMarketingSources(app.db, tenantId, filters);
  });

  app.get("/dashboard/team", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getTeamWorkload(app.db, tenantId, filters);
  });

  app.get("/dashboard/branch-doctor", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getBranchDoctorPerformance(app.db, tenantId, filters);
  });

  app.get("/dashboard/service-mix", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const filters = await dashboardFilters(request, reply);
    if (!filters) return reply;
    return getServiceMix(app.db, tenantId, filters, capabilityEnabled(request.sessionUser!.capabilities, "REVENUE_TRACKING"));
  });
}
