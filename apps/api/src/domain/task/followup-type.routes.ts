import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasPermission } from "@pulseos/types";
import { auditSettingsChanges } from "../activity/activity.service.js";
import { requirePermission } from "../auth/permission.middleware.js";
import { createFollowUpType, listFollowUpTypes, reorderFollowUpTypes, updateFollowUpType } from "./followup-type.service.js";
import { journeys } from "../../db/schema.js";
import { and, eq } from "drizzle-orm";

const uuid = z.string().uuid();
const TASK_TYPES = ["CALLBACK", "FOLLOW_UP", "APPOINTMENT_CONFIRMATION", "POST_CARE"] as const;
const createBody = z
  .object({
    label: z.string().min(1).max(60),
    canonicalTaskType: z.enum(TASK_TYPES).optional(),
    defaultPriority: z.enum(["normal", "high"]).optional(),
    defaultOwner: z.enum(["JOURNEY_OWNER", "ACTOR", "UNASSIGNED"]).optional(),
    requiresNote: z.boolean().optional(),
    departmentId: uuid.nullable().optional(),
  })
  .strict();
const updateBody = createBody.partial().extend({ isActive: z.boolean().optional() }).strict();
const reorderBody = z.object({ orderedIds: z.array(uuid).min(1).max(100) });
const REASON_STATUS: Record<string, number> = { type_not_found: 404, department_not_found: 404, type_exists: 409, last_active_type: 409, invalid_request: 400 };

export async function followUpTypeRoutes(app: FastifyInstance) {
  app.addHook("onResponse", auditSettingsChanges(app, "followup_type", "/followup-types"));
  // Anyone who works tasks reads the types they may choose from (a journey sees the all-department types plus its
  // own department's). Archived ones are only for whoever configures them.
  app.get("/followup-types", { preHandler: requirePermission("VIEW_TASKS") }, async (request, reply) => {
    const { includeInactive, journeyId } = request.query as { includeInactive?: string; journeyId?: string };
    const user = request.sessionUser!;
    const canManage = hasPermission(user.role, "MANAGE_SPECIALTIES");
    let forDepartmentId: string | null | undefined;
    if (journeyId !== undefined) {
      const id = uuid.safeParse(journeyId);
      if (!id.success) return reply.status(404).send({ error: "journey_not_found" });
      const [j] = await app.db.select({ departmentId: journeys.departmentId }).from(journeys).where(and(eq(journeys.tenantId, user.tenantId), eq(journeys.id, id.data))).limit(1);
      if (!j) return reply.status(404).send({ error: "journey_not_found" });
      forDepartmentId = j.departmentId;
    }
    return listFollowUpTypes(app.db, user.tenantId, { includeInactive: canManage && includeInactive === "true", forDepartmentId });
  });

  app.post("/followup-types", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await createFollowUpType(app.db, request.sessionUser!.tenantId, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(201).send(result.type);
  });

  app.patch("/followup-types/:id", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "type_not_found" });
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await updateFollowUpType(app.db, request.sessionUser!.tenantId, id.data, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result.type;
  });

  app.post("/followup-types/reorder", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = reorderBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await reorderFollowUpTypes(app.db, request.sessionUser!.tenantId, parsed.data.orderedIds);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });
}
