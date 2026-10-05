import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { SURFACE_STYLES } from "@pulseos/types";
import { tenants } from "../../db/schema.js";
import { requirePermission } from "../auth/permission.middleware.js";

// Settings > Appearance: how solid the interface surfaces are. ONE bounded preference per hospital (three named styles, never a
// raw opacity or CSS value). Everyone reads it through the session payload; only an administrator saves it, and the tenant
// always comes from the session.
const body = z.object({ surfaceStyle: z.enum(SURFACE_STYLES) }).strict();

export async function appearanceRoutes(app: FastifyInstance) {
  app.put("/appearance", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    await app.db.update(tenants).set({ surfaceStyle: parsed.data.surfaceStyle }).where(eq(tenants.id, request.sessionUser!.tenantId));
    return { surfaceStyle: parsed.data.surfaceStyle };
  });
}
