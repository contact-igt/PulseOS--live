import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import { listActivity } from "./activity.service.js";
import { dayRangeShape, refineDayRange } from "../../lib/day-range.js";

const query = z
  .object({ action: z.string().max(60).optional(), entityType: z.string().max(40).optional(), ...dayRangeShape, limit: z.coerce.number().int().min(1).max(200).optional() })
  .superRefine(refineDayRange);

export async function activityRoutes(app: FastifyInstance) {
  // Hospital Admin and Super Admin only; the tenant is always the session's.
  app.get("/activity-log", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    return listActivity(app.db, request.sessionUser!.tenantId, parsed.data);
  });
}
