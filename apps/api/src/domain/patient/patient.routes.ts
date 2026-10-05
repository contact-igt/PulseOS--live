import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import { createPatient, getPatient360, listPatients, searchPatients } from "./patient.service.js";
import { branchBelongsToTenant } from "./identity.service.js";
import { getPatientTimeline } from "../timeline/timeline.service.js";
import { capabilityEnabled, hasPermission } from "@pulseos/types";
import { getPatientUpcoming } from "./upcoming.service.js";

const createPatientBody = z.object({
  name: z.string().min(1),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  preferredLanguage: z.string().optional(),
  branchId: z.string().uuid(),
});

export async function patientRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("VIEW_PATIENTS"));

  app.get("/patients", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = request.query as Record<string, string | undefined>;
    return listPatients(app.db, tenantId, {
      search: query.search,
      branchId: query.branchId,
      source: query.source,
      stage: query.stage,
      ownerId: query.ownerId,
    });
  });

  // The global-search typeahead's own lightweight endpoint — see
  // patient.service.ts's searchPatients for why this isn't listPatients.
  app.get("/patients/search", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const { q } = request.query as { q?: string };
    return searchPatients(app.db, tenantId, q ?? "");
  });

  app.get("/patients/:id/360", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const result = await getPatient360(app.db, tenantId, id, request.sessionUser!.role, request.sessionUser!.timezone, capabilityEnabled(request.sessionUser!.capabilities, "REVENUE_TRACKING"));
    if (!result) return reply.status(404).send({ error: "patient_not_found" });
    return result;
  });

  app.get("/patients/:id/timeline", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const { journeyId } = request.query as { journeyId?: string };
    return getPatientTimeline(app.db, tenantId, id, request.sessionUser!.role, journeyId);
  });

  // Patient 360 "Upcoming" (read-only). Each item kind is trimmed by the SAME
  // permission that guards its own list endpoint, so this never widens access:
  // appointments need VIEW_APPOINTMENTS, treatments VIEW_TREATMENT, tasks
  // VIEW_TASKS - and a caller without MANAGE_TASKS sees only tasks assigned to
  // them, exactly as GET /tasks forces. Tenant comes from the session only.
  app.get("/patients/:id/upcoming", async (request, reply) => {
    const user = request.sessionUser!;
    const { id } = request.params as { id: string };
    const result = await getPatientUpcoming(app.db, user.tenantId, id, {
      appointments: hasPermission(user.role, "VIEW_APPOINTMENTS"),
      treatments: hasPermission(user.role, "VIEW_TREATMENT"),
      tasks: hasPermission(user.role, "VIEW_TASKS"),
      onlyAssignedTo: hasPermission(user.role, "MANAGE_TASKS") ? undefined : user.id,
    });
    if (!result) return reply.status(404).send({ error: "patient_not_found" });
    return result;
  });

  await app.register(async (manageApp) => {
    manageApp.addHook("preHandler", requirePermission("EDIT_PATIENTS"));

    manageApp.post("/patients", async (request, reply) => {
      const tenantId = request.sessionUser!.tenantId;
      const actorId = request.sessionUser!.id;
      const parsed = createPatientBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

      if (!(await branchBelongsToTenant(app.db, tenantId, parsed.data.branchId))) return reply.status(400).send({ error: "invalid_request", field: "branchId" });

      const result = await createPatient(app.db, tenantId, actorId, parsed.data);
      return reply.status(201).send(result);
    });
  });
}
