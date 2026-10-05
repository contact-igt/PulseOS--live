import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import {
  createCustomField,
  createSpecialty,
  getSpecialtyDetail,
  listSpecialties,
  updateCustomField,
  updateSpecialty,
} from "./specialty.service.js";
import { listActiveTreatmentDefinitions } from "./treatment-catalog.service.js";
import { listFieldsForEntry } from "../crm/crm-field.service.js";

const REASON_STATUS: Record<string, number> = {
  specialty_not_found: 404,
  field_not_found: 404,
  key_exists: 409,
  system_field_locked: 403,
};

const updateSpecialtyBody = z.object({
  displayName: z.string().min(1).optional(),
  defaultJourneyType: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const createFieldBody = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  fieldType: z.enum(["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTI_SELECT", "PHONE"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

const updateFieldBody = z.object({
  label: z.string().min(1).optional(),
  required: z.boolean().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  options: z.array(z.string()).optional(),
});

const createSpecialtyBody = z.object({ displayName: z.string().min(1).max(60), defaultJourneyType: z.string().min(1).max(80).optional() }).strict();

export async function specialtyRoutes(app: FastifyInstance) {
  // Every authenticated role may READ specialties/fields (needed to render Add Lead).
  app.get("/specialties", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = request.query as { includeDisabled?: string };
    return listSpecialties(app.db, tenantId, query.includeDisabled === "true");
  });

  app.get("/specialties/:key/fields", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const { key } = request.params as { key: string };
    // The Add Lead form: fields placed on Add Lead for this service (plus all-services fields), visible to this role.
    return listFieldsForEntry(app.db, tenantId, request.sessionUser!.role, { placement: "add_lead", specialtyKey: key });
  });

  // The tenant's active treatment catalog — read by every role (a doctor picks from it when recording an
  // outcome). ?specialtyKey= limits it to one service line. Always scoped to the session's tenant.
  app.get("/treatment-catalog", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const { specialtyKey } = request.query as { specialtyKey?: string };
    return listActiveTreatmentDefinitions(app.db, tenantId, specialtyKey || undefined);
  });

  // Add a service the hospital offers. Configuration: HOSPITAL_ADMIN/SUPER_ADMIN only; the tenant is the session's.
  app.post("/specialties", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = createSpecialtyBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await createSpecialty(app.db, request.sessionUser!.tenantId, parsed.data);
    if (!result.ok) return reply.status(result.reason === "service_exists" ? 409 : 400).send({ error: result.reason });
    return reply.status(201).send(result.service);
  });

  // Configuration changes are HOSPITAL_ADMIN/SUPER_ADMIN only.
  app.get("/specialties/:key", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { key } = request.params as { key: string };
    const result = await getSpecialtyDetail(app.db, tenantId, key);
    if (!result) return reply.status(404).send({ error: "specialty_not_found" });
    return result;
  });

  app.patch("/specialties/:key", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { key } = request.params as { key: string };
    const parsed = updateSpecialtyBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const result = await updateSpecialty(app.db, tenantId, key, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return getSpecialtyDetail(app.db, tenantId, key);
  });

  app.post("/specialties/:key/fields", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { key } = request.params as { key: string };
    const parsed = createFieldBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const result = await createCustomField(app.db, tenantId, key, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(201).send(result.field);
  });

  app.patch("/specialties/fields/:fieldId", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { fieldId } = request.params as { fieldId: string };
    const parsed = updateFieldBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const result = await updateCustomField(app.db, tenantId, fieldId, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.send({ ok: true });
  });
}
