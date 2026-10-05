import type { FastifyInstance } from "fastify";
import { requireCapability, requirePermission } from "../auth/permission.middleware.js";
import { hasPermission } from "@pulseos/types";
import { getConnectorDetail, listConnectors, upsertConnectorConfig } from "./connector.service.js";
import { syncConnectorCampaigns } from "../acquisition/campaign-sync.service.js";
import { syncConnectorPerformance } from "../acquisition/gbp-performance.service.js";
import {
  createCommunicationEndpoint,
  listCommunicationEndpoints,
  resolveEndpointByProviderRef,
  updateCommunicationEndpoint,
} from "./communication-endpoint.service.js";
import type { CreateCommunicationEndpointInput, UpdateCommunicationEndpointInput } from "@pulseos/types";

const REASON_STATUS: Record<string, number> = {
  connector_not_found: 404,
  unsupported_capability: 422,
  sync_failed: 502,
  provider_ref_already_exists: 409,
  endpoint_not_found: 404,
  branch_not_found: 404,
};

export async function connectorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("VIEW_INTEGRATIONS"));

  app.get("/connectors", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return listConnectors(app.db, tenantId);
  });

  app.get("/connectors/:id", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const detail = await getConnectorDetail(app.db, tenantId, id);
    if (!detail) return reply.status(404).send({ error: "connector_not_found" });
    return detail;
  });

  app.patch("/connectors/:id", { preHandler: requirePermission("MANAGE_INTEGRATION_CONFIG") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { displayName?: string; configuration?: Record<string, unknown>; secrets?: Record<string, unknown> };
    // Raw provider credentials are Super Admin only: an Admin may change operational configuration but is
    // refused outright (not silently stripped) if the request carries secrets.
    if (body?.secrets !== undefined && !hasPermission(request.sessionUser!.role, "MANAGE_INTEGRATION_SECRETS")) {
      return reply.status(403).send({ error: "forbidden", requiredPermission: "MANAGE_INTEGRATION_SECRETS" });
    }
    const result = await upsertConnectorConfig(app.db, tenantId, id, body);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  app.post("/connectors/:id/sync-campaigns", { preHandler: [requireCapability("CAMPAIGNS"), requirePermission("MANAGE_INTEGRATION_CONFIG")] }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const result = await syncConnectorCampaigns(app.db, tenantId, id);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason, message: result.message });
    return result;
  });

  app.post("/connectors/:id/sync-performance", { preHandler: [requireCapability("CAMPAIGNS"), requirePermission("MANAGE_INTEGRATION_CONFIG")] }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const result = await syncConnectorPerformance(app.db, tenantId, id);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason, message: result.message });
    return result;
  });

  app.get("/connectors/:id/endpoints/resolve", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const { providerRef } = request.query as { providerRef?: string };
    if (!providerRef) return reply.status(400).send({ error: "provider_ref_required" });
    const endpoint = await resolveEndpointByProviderRef(app.db, tenantId, id, providerRef);
    if (!endpoint) return reply.status(404).send({ error: "endpoint_not_found" });
    return endpoint;
  });

  app.post("/connectors/:id/endpoints", { preHandler: requirePermission("MANAGE_INTEGRATION_CONFIG") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as CreateCommunicationEndpointInput;
    const result = await createCommunicationEndpoint(app.db, tenantId, id, body);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(201).send(result.endpoint);
  });

  app.patch("/connectors/:id/endpoints/:endpointId", { preHandler: requirePermission("MANAGE_INTEGRATION_CONFIG") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id, endpointId } = request.params as { id: string; endpointId: string };
    const body = request.body as UpdateCommunicationEndpointInput;
    const result = await updateCommunicationEndpoint(app.db, tenantId, id, endpointId, body);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result.endpoint;
  });
}

// A separate plugin (own encapsulation scope, own permission hook) rather
// than routes inside connectorRoutes: reading which hospital lines exist is
// a narrower capability than the rest of Integrations (connector secrets
// status, sync controls, raw provider config), which front desk/coordinator
// genuinely should not see. They DO need to know "which line is this
// conversation on" for the Inbox filter — VIEW_COMMUNICATION_ENDPOINTS lets
// them read the endpoint list without granting VIEW_INTEGRATIONS.
export async function communicationEndpointReadRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("VIEW_COMMUNICATION_ENDPOINTS"));

  app.get("/communication-endpoints", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return listCommunicationEndpoints(app.db, tenantId);
  });

  app.get("/connectors/:id/endpoints", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    return listCommunicationEndpoints(app.db, tenantId, id);
  });
}
