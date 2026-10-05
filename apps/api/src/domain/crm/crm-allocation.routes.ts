import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import { createAllocationRule, deleteAllocationRule, listAllocationRules, reorderAllocationRules, updateAllocationRule } from "./crm-allocation.service.js";

const source = z.enum(["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"]);
const condition = z.string().max(80).nullable().optional();
const createBody = z.object({
  name: z.string().min(1).max(80),
  source: source.nullable().optional(),
  specialtyKey: condition,
  journeyType: condition,
  branchId: z.string().uuid().nullable().optional(),
  userIds: z.array(z.string().uuid()).max(25),
  enabled: z.boolean().optional(),
});
const updateBody = createBody.partial().strict();
const reorderBody = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(100) });

const STATUS: Record<string, number> = { rule_not_found: 404 };

export async function crmAllocationRoutes(app: FastifyInstance) {
  const admin = { preHandler: requirePermission("MANAGE_SPECIALTIES") };

  app.get("/crm/allocation-rules", admin, async (request) => listAllocationRules(app.db, request.sessionUser!.tenantId));

  app.post("/crm/allocation-rules", admin, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await createAllocationRule(app.db, request.sessionUser!.tenantId, parsed.data);
    if (!result.ok) return reply.status(STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(201).send(result.rule);
  });

  app.patch("/crm/allocation-rules/:id", admin, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "rule_not_found" });
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await updateAllocationRule(app.db, request.sessionUser!.tenantId, id.data, parsed.data);
    if (!result.ok) return reply.status(STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result.rule;
  });

  app.delete("/crm/allocation-rules/:id", admin, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "rule_not_found" });
    const result = await deleteAllocationRule(app.db, request.sessionUser!.tenantId, id.data);
    if (!result.ok) return reply.status(STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });

  app.post("/crm/allocation-rules/reorder", admin, async (request, reply) => {
    const parsed = reorderBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await reorderAllocationRules(app.db, request.sessionUser!.tenantId, parsed.data.orderedIds);
    if (!result.ok) return reply.status(STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });
}
