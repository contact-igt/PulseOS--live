import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tenants } from "../../db/schema.js";
import { requirePermission } from "../auth/permission.middleware.js";

// Weekly clinic hours: "HH:MM" open (inclusive) to close (exclusive) in the hospital's timezone, or null for a closed day.
// Read through GET /lookups (everyone signed in needs it for the appointment picker); only an administrator changes it, and
// the tenant always comes from the session. Appointment booking enforces it server-side.
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.tuple([time, time]).refine(([o, c]) => o < c, "close must be after open").nullable();
const week = z.object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }).strict();

export async function clinicHoursRoutes(app: FastifyInstance) {
  app.put("/clinic-hours", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = z.object({ clinicHours: week.nullable() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    await app.db.update(tenants).set({ clinicHours: parsed.data.clinicHours }).where(eq(tenants.id, request.sessionUser!.tenantId));
    return { clinicHours: parsed.data.clinicHours };
  });
}
