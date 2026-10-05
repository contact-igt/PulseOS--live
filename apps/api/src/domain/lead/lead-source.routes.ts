import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasPermission } from "@pulseos/types";
import { auditSettingsChanges } from "../activity/activity.service.js";
import { requirePermission } from "../auth/permission.middleware.js";
import { createLeadSource, listLeadSources, reorderLeadSources, updateLeadSource } from "./lead-source.service.js";

const BUCKETS = ["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"] as const;
const createBody = z.object({ label: z.string().min(1).max(60), bucket: z.enum(BUCKETS).optional() }).strict();
const updateBody = z.object({ label: z.string().min(1).max(60).optional(), bucket: z.enum(BUCKETS).optional(), archived: z.boolean().optional(), sortOrder: z.number().int().optional() }).strict();
const reorderBody = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(100) });
const REASON_STATUS: Record<string, number> = { source_exists: 409, source_not_found: 404, invalid_request: 400 };

export async function leadSourceRoutes(app: FastifyInstance) {
  app.addHook("onResponse", auditSettingsChanges(app, "lead_source", "/lead-sources"));
  // Every role reads the sources it may pick for a new lead; archived ones are only shown to whoever configures them.
  app.get("/lead-sources", async (request) => {
    const { includeArchived } = request.query as { includeArchived?: string };
    const canManage = hasPermission(request.sessionUser!.role, "MANAGE_SPECIALTIES");
    return listLeadSources(app.db, request.sessionUser!.tenantId, canManage && includeArchived === "true");
  });

  app.post("/lead-sources", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await createLeadSource(app.db, request.sessionUser!.tenantId, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(201).send(result.source);
  });

  app.post("/lead-sources/reorder", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = reorderBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await reorderLeadSources(app.db, request.sessionUser!.tenantId, parsed.data.orderedIds);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });

  app.patch("/lead-sources/:id", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    const parsed = updateBody.safeParse(request.body);
    if (!id.success) return reply.status(404).send({ error: "source_not_found" });
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await updateLeadSource(app.db, request.sessionUser!.tenantId, id.data, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result.source;
  });
}
