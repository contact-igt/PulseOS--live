import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listCapabilityStates, setCapability } from "./capability.service.js";

const REASON_STATUS: Record<string, number> = { unknown_capability: 404, forbidden: 403, requires: 409, required_by: 409, locked: 409, tenant_not_found: 404 };

export async function capabilityRoutes(app: FastifyInstance) {
  // Every signed-in person may read what their hospital can do (the UI needs it); `editable` says who may change what.
  app.get("/capabilities", async (request) => {
    const u = request.sessionUser!;
    return { edition: u.edition, capabilities: await listCapabilityStates(app.db, u.tenantId, u.edition, u.role) };
  });

  app.put("/capabilities/:key", async (request, reply) => {
    const u = request.sessionUser!;
    const parsed = z.object({ enabled: z.boolean().nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await setCapability(app.db, u.tenantId, { id: u.id, role: u.role }, (request.params as { key: string }).key, parsed.data.enabled);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason, capabilities: result.capabilities });
    request.log.info({ capability: { key: (request.params as { key: string }).key, enabled: parsed.data.enabled, userId: u.id, tenantId: u.tenantId } }, "capability changed");
    return { ok: true, capabilities: result.capabilities };
  });
}
