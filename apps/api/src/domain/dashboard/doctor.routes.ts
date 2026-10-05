import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isRealDate } from "../../lib/hospital-time.js";
import { requirePermission } from "../auth/permission.middleware.js";
import { getDoctorDashboard } from "./doctor.service.js";

export async function doctorDashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/doctor", { preHandler: requirePermission("VIEW_DOCTOR_COMMAND_CENTRE") }, async (request, reply) => {
    const user = request.sessionUser!;
    const parsed = z.object({ date: z.string().refine(isRealDate, "Use a real date as YYYY-MM-DD").optional() }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    return getDoctorDashboard(app.db, user.tenantId, user.id, new Date(), parsed.data.date);
  });
}
