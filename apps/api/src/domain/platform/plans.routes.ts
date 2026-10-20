import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFromRequest } from "./audit.service.js";
import { notFound, parse, refuse } from "./http.js";
import { requirePlatform } from "./platform-guard.js";
import { changePlanSchema, changeTenantPlan, listPlans, setTenantCapability, tenantCapabilityMatrix } from "./plans.service.js";

export async function platformPlanRoutes(app: FastifyInstance) {
  const view = { preHandler: requirePlatform("VIEW_PLATFORM") };
  const entitlements = { preHandler: requirePlatform("MANAGE_ENTITLEMENTS") };
  app.get("/platform/plans", view, async () => listPlans(app.db));
  app.get<{ Params: { id: string } }>("/platform/tenants/:id/capabilities", view, async (request, reply) => (await tenantCapabilityMatrix(app.db, request.params.id)) ?? notFound(reply));
  app.put<{ Params: { id: string; key: string } }>("/platform/tenants/:id/capabilities/:key", entitlements, async (request, reply) => {
    const body = parse(z.object({ enabled: z.boolean().nullable() }).strict(), request.body, reply);
    if (!body) return reply;
    const r = await setTenantCapability(app.db, request.params.id, request.params.key, body.enabled, actorFromRequest(request));
    return r.ok ? { effective: r.effective } : refuse(reply, r);
  });
  app.put<{ Params: { id: string } }>("/platform/tenants/:id/plan", entitlements, async (request, reply) => {
    const body = parse(changePlanSchema, request.body, reply);
    if (!body) return reply;
    const r = await changeTenantPlan(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });
}
