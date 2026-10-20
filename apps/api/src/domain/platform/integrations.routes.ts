import type { FastifyInstance } from "fastify";
import { notFound, parse } from "./http.js";
import { requirePlatform } from "./platform-guard.js";
import { getTenantIntegrationDetail, listIntegrationsSchema, listPlatformIntegrations } from "./integrations.service.js";

export async function platformIntegrationRoutes(app: FastifyInstance) {
  const view = { preHandler: requirePlatform("VIEW_PLATFORM") };
  app.get("/platform/integrations", view, async (request, reply) => {
    const q = parse(listIntegrationsSchema, request.query, reply);
    return q ? listPlatformIntegrations(app.db, q) : reply;
  });
  app.get<{ Params: { id: string; key: string } }>("/platform/tenants/:id/integrations/:key", view, async (request, reply) => (await getTenantIntegrationDetail(app.db, request.params.id, request.params.key)) ?? notFound(reply));
}
