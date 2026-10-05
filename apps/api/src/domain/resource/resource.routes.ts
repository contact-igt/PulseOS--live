import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasPermission } from "@pulseos/types";
import { requirePermission } from "../auth/permission.middleware.js";
import { createResource, listResources, updateResource } from "./resource.service.js";

const STATUS: Record<string, number> = { resource_not_found: 404, department_invalid: 422, invalid_request: 400 };

const createBody = z.object({ name: z.string().max(200), departmentId: z.string().uuid().nullable().optional() });
const updateBody = z.object({ name: z.string().max(200).optional(), departmentId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() });

/** Doctors/resources appointments and surgeries are scheduled with. Anyone who sees appointments may list them; Admins manage them. */
export async function resourceRoutes(app: FastifyInstance) {
  app.get("/resources", { preHandler: requirePermission("VIEW_APPOINTMENTS") }, async (request) => {
    const q = request.query as { includeInactive?: string };
    // Only a manager sees archived profiles.
    const canManage = hasPermission(request.sessionUser!.role, "MANAGE_SPECIALTIES");
    return listResources(app.db, request.sessionUser!.tenantId, { includeInactive: canManage && q.includeInactive === "true" });
  });

  app.post("/resources", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const r = await createResource(app.db, request.sessionUser!.tenantId, parsed.data);
    if (!r.ok) return reply.status(STATUS[r.reason] ?? 400).send({ error: r.reason });
    return reply.status(201).send(r.resource);
  });

  app.patch("/resources/:id", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const r = await updateResource(app.db, request.sessionUser!.tenantId, (request.params as { id: string }).id, parsed.data);
    if (!r.ok) return reply.status(STATUS[r.reason] ?? 400).send({ error: r.reason });
    return r.resource;
  });
}
