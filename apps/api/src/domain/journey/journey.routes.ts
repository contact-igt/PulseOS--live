import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { capabilityEnabled, type SpendAtRiskCategoryKey } from "@pulseos/types";
import { requirePermission } from "../auth/permission.middleware.js";
import { assignJourneyOwner, getJourneyDetail, getJourneysSummary, listJourneys, parseOwnerFilter } from "./journey.service.js";

const idParam = z.string().uuid();
const assignOwnerBody = z.object({ ownerUserId: z.string().uuid().nullable() });
const bulkAssignOwnerBody = z.object({ journeyIds: z.array(z.string().uuid()).min(1).max(100), ownerUserId: z.string().uuid().nullable() });

const ASSIGN_FAILURE_STATUS = { journey_not_found: 404, assignee_not_found: 422 } as const;

export async function journeyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("VIEW_JOURNEYS"));

  app.get("/journeys", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = request.query as Record<string, string | undefined>;
    const owner = parseOwnerFilter(query.owner, request.sessionUser!.id);
    if (owner === "invalid") return reply.status(400).send({ error: "invalid_owner_filter" });
    return listJourneys(app.db, tenantId, {
      source: query.source,
      campaignId: query.campaignId,
      branchId: query.branchId,
      stage: query.stage,
      ownerId: query.ownerId,
      owner,
      doctorId: query.doctorId,
      atRisk: query.atRisk as SpendAtRiskCategoryKey | undefined,
    });
  });

  app.get("/journeys/summary", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return getJourneysSummary(app.db, tenantId);
  });

  app.get("/journeys/:id", async (request, reply) => {
    const { tenantId, id: userId, role } = request.sessionUser!;
    const id = idParam.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "journey_not_found" });
    const detail = await getJourneyDetail(app.db, tenantId, id.data, { id: userId, role, timezone: request.sessionUser!.timezone, revenueTracking: capabilityEnabled(request.sessionUser!.capabilities, "REVENUE_TRACKING") });
    if (!detail) return reply.status(404).send({ error: "journey_not_found" });
    return detail;
  });

  // Owner allocation is a stronger capability than viewing a journey: Front
  // Desk and Doctor can open a journey but not reassign it (MANAGE_JOURNEYS).
  app.patch("/journeys/:id/owner", { preHandler: requirePermission("MANAGE_JOURNEYS") }, async (request, reply) => {
    const { tenantId, id: actorId, role } = request.sessionUser!;
    const id = idParam.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "journey_not_found" });
    const body = assignOwnerBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_request", details: body.error.flatten() });

    const result = await assignJourneyOwner(app.db, tenantId, actorId, [id.data], body.data.ownerUserId);
    if (!result.ok) return reply.status(ASSIGN_FAILURE_STATUS[result.reason]).send({ error: result.reason });
    return getJourneyDetail(app.db, tenantId, id.data, { id: actorId, role, timezone: request.sessionUser!.timezone });
  });

  // All-or-nothing: one transaction; any id outside the caller's tenant (404)
  // or an invalid assignee (422) rejects the whole request with no writes.
  app.post("/journeys/owner", { preHandler: requirePermission("MANAGE_JOURNEYS") }, async (request, reply) => {
    const { tenantId, id: actorId } = request.sessionUser!;
    const body = bulkAssignOwnerBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_request", details: body.error.flatten() });

    const result = await assignJourneyOwner(app.db, tenantId, actorId, body.data.journeyIds, body.data.ownerUserId);
    if (!result.ok) return reply.status(ASSIGN_FAILURE_STATUS[result.reason]).send({ error: result.reason });
    return { updatedCount: result.updatedCount, journeyIds: result.journeyIds, owner: result.owner };
  });
}
