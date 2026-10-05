import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import { installDepartmentTemplate, listDepartmentTemplates, listDepartments, updateDepartment } from "./department.service.js";

const installBody = z.object({ templateKey: z.string().min(1) }).strict();
const updateBody = z.object({ displayName: z.string().min(1).max(80).optional(), archived: z.boolean().optional() }).strict();
const REASON_STATUS: Record<string, number> = { template_not_found: 404, department_not_found: 404, invalid_request: 400 };

export async function departmentRoutes(app: FastifyInstance) {
  // Every role may read which departments the hospital has (the Add Lead service picker groups by it).
  app.get("/departments", async (request) => listDepartments(app.db, request.sessionUser!.tenantId));

  // Configuration — Admin / Super Admin only.
  app.get("/department-templates", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request) => listDepartmentTemplates(app.db, request.sessionUser!.tenantId));

  app.post("/departments/install", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = installBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await installDepartmentTemplate(app.db, request.sessionUser!.tenantId, parsed.data.templateKey);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    // 201 the first time, 200 when everything was already there.
    return reply.status(result.created ? 201 : 200).send({ departmentId: result.departmentId, created: result.created });
  });

  app.patch("/departments/:id", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "department_not_found" });
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await updateDepartment(app.db, request.sessionUser!.tenantId, id.data, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });
}
