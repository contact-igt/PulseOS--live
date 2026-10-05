import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasPermission } from "@pulseos/types";
import { auditSettingsChanges } from "../activity/activity.service.js";
import { requirePermission } from "../auth/permission.middleware.js";
import { createOutcome, listOutcomes, logInteraction, reorderOutcomes, updateOutcome } from "./crm-outcome.service.js";

const stage = z.enum(["contacted", "lost"]);
const taskType = z.enum(["CALLBACK", "FOLLOW_UP", "APPOINTMENT_CONFIRMATION", "NO_SHOW_RECOVERY", "TREATMENT_DECISION", "POST_CARE", "RECALL", "OTHER"]);

const createBody = z.object({
  key: z.string(),
  label: z.string().min(1).max(80),
  stage,
  requiresFollowUp: z.boolean().optional(),
  allowsAppointment: z.boolean().optional(),
  asksReason: z.boolean().optional(),
  followUpType: taskType.optional(),
});
// Strict: the key can never change once created.
const updateBody = z
  .object({
    label: z.string().min(1).max(80).optional(),
    stage: stage.optional(),
    requiresFollowUp: z.boolean().optional(),
    allowsAppointment: z.boolean().optional(),
    asksReason: z.boolean().optional(),
    followUpType: taskType.optional(),
    archived: z.boolean().optional(),
  })
  .strict();
const reorderBody = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(100) });
const interactionAppointment = z.object({ scheduledAt: z.string().min(1).max(40), confirmed: z.boolean().optional(), doctorId: z.string().uuid().optional(), branchId: z.string().uuid().optional(), reason: z.string().max(500).optional() }).strict();
const interactionBody = z.object({
  appointment: interactionAppointment.optional(),
  outcomeKey: z.string().min(1).max(60),
  note: z.string().max(2000).optional(),
  reason: z.string().max(500).optional(),
  followUpAt: z.string().optional(),
  taskId: z.string().uuid().optional(),
  fieldValues: z.record(z.string(), z.unknown()).optional(),
  channel: z.enum(["MANUAL_CALL", "WHATSAPP", "INSTAGRAM_DM", "FACEBOOK_DM", "WALK_IN"]).optional(),
});

const REASON_STATUS: Record<string, number> = {
  outcome_not_found: 404,
  key_exists: 409,
  outcome_in_use: 409,
  journey_not_found: 404,
  task_not_found: 404,
  task_closed: 409,
  missing_required_fields: 422,
  invalid_field_values: 422,
  field_read_only: 422,
  // Booking from the same save: the same refusals as booking directly.
  appointment_time_in_past: 422,
  outside_clinic_hours: 422,
  resource_unavailable: 409,
  doctor_not_found: 404,
  branch_not_found: 404,
  doctor_required: 422,
  branch_required: 422,
  outcome_disallows_appointment: 422,
  follow_up_and_appointment: 400,
};

export async function crmOutcomeRoutes(app: FastifyInstance) {
  app.addHook("onResponse", auditSettingsChanges(app, "workflow_outcome", "/crm/outcomes"));
  // The picker for "Log outcome": anyone who manages tasks (front desk, coordinator, admin). Doctors do not.
  app.get("/crm/outcomes", { preHandler: requirePermission("MANAGE_TASKS") }, async (request, reply) => {
    const q = z.object({ includeArchived: z.enum(["true", "false"]).optional() }).safeParse(request.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_request" });
    const user = request.sessionUser!;
    // Archived outcomes are an admin concern; everyone else only ever sees active ones.
    const includeArchived = q.data.includeArchived === "true" && user.role !== "FRONT_DESK" && user.role !== "PATIENT_COORDINATOR";
    return listOutcomes(app.db, user.tenantId, { includeArchived });
  });

  app.post("/crm/outcomes", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await createOutcome(app.db, request.sessionUser!.tenantId, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(201).send(result.outcome);
  });

  app.patch("/crm/outcomes/:id", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "outcome_not_found" });
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await updateOutcome(app.db, request.sessionUser!.tenantId, id.data, parsed.data);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result.outcome;
  });

  app.post("/crm/outcomes/reorder", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = reorderBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await reorderOutcomes(app.db, request.sessionUser!.tenantId, parsed.data.orderedIds);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true };
  });

  // Log what happened on a call / follow-up. Closes the task it came from, creates the next one if the
  // outcome needs it, moves the Journey forward only, and writes one Timeline event.
  app.post("/journeys/:id/interactions", { preHandler: requirePermission("MANAGE_TASKS") }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "journey_not_found" });
    const parsed = interactionBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const user = request.sessionUser!;
    // Booking a visit is its own permission: logging an outcome alone never lets a role book.
    if (parsed.data.appointment && !hasPermission(user.role, "MANAGE_APPOINTMENTS")) return reply.status(403).send({ error: "forbidden" });
    const result = await logInteraction(app.db, user.tenantId, { id: user.id, role: user.role }, id.data, parsed.data, new Date(), user.timezone);
    if (!result.ok) {
      // An unknown / archived outcome is a bad request body (400); 404 is reserved for the Journey or Task in the path / body that does not exist.
      const status = result.reason === "outcome_not_found" ? 400 : (REASON_STATUS[result.reason] ?? 400);
      return reply.status(status).send({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) });
    }
    return reply.status(201).send(result.result);
  });
}
