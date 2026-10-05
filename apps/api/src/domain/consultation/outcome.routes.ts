import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import { recordConsultationOutcome } from "./outcome.service.js";

const outcomeBody = z.object({
  outcome: z.enum(["CONSULTED", "TREATMENT_ADVISED", "NO_TREATMENT_REQUIRED", "DECISION_PENDING", "FOLLOW_UP_REQUIRED", "REFERRED", "OTHER", "TREATMENT_DECLINED"]),
  notes: z.string().max(1000).optional(),
  treatmentLabel: z.string().optional(),
  treatmentDefinitionId: z.string().uuid().optional(),
  estimatedValue: z.number().int().nonnegative().optional(),
});

export async function outcomeRoutes(app: FastifyInstance) {
  app.post("/appointments/:id/outcome", { preHandler: requirePermission("RECORD_CONSULTATION_OUTCOME") }, async (request, reply) => {
    const user = request.sessionUser!;

    const parsed = outcomeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request" });
    }

    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "appointment_not_found" });
    const result = await recordConsultationOutcome(app.db, {
      tenantId: user.tenantId,
      appointmentId: id,
      doctorUserId: user.id,
      actorRole: user.role,
      ...parsed.data,
    });

    if (!result.ok) {
      const status = result.reason === "appointment_not_found" ? 404 : result.reason === "forbidden" ? 403 : result.reason === "invalid_treatment_definition" ? 422 : 409;
      return reply.status(status).send({ error: result.reason });
    }

    return reply.send(result);
  });
}
