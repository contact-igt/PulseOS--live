import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCapability, requirePermission } from "../../auth/permission.middleware.js";
import { getConversationSettings, listConversationSummaries, listPatientSummaries, refreshConversationSummary, updateConversationSettings } from "./conversation-session.service.js";
import { getSummarizer } from "./index.js";

const uuid = z.string().uuid();
const settingsBody = z.object({ idleMinutes: z.number() }).strict();

export async function conversationSummaryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireCapability("CONVERSATION_INTELLIGENCE"));

  // Hospital-wide: how long a conversation must be idle before it is summarized (5-10 minutes, default 7).
  app.get("/settings/conversation", async (request) => getConversationSettings(app.db, request.sessionUser!.tenantId));

  app.patch("/settings/conversation", { preHandler: requirePermission("MANAGE_SPECIALTIES") }, async (request, reply) => {
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await updateConversationSettings(app.db, request.sessionUser!.tenantId, parsed.data.idleMinutes);
    if (!result.ok) return reply.status(400).send({ error: result.reason });
    return result.settings;
  });

  app.get("/conversations/:id/summaries", { preHandler: requirePermission("VIEW_INBOX") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "conversation_not_found" });
    const rows = await listConversationSummaries(app.db, request.sessionUser!.tenantId, id.data);
    if (!rows) return reply.status(404).send({ error: "conversation_not_found" });
    return rows;
  });

  // "Refresh summary": summarize the new messages now.
  app.post("/conversations/:id/summary/refresh", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "conversation_not_found" });
    const result = await refreshConversationSummary(app.db, request.sessionUser!.tenantId, id.data, new Date(), getSummarizer());
    if (result.ok) return reply.status(201).send(result.summary);
    const status = { conversation_not_found: 404, nothing_new: 409, busy: 409, summarizer_failed: 502 }[result.reason];
    return reply.status(status).send({ error: result.reason });
  });

  // Patient-scoped: only that patient's summaries, only if the patient belongs to the caller's hospital.
  app.get("/patients/:id/conversation-summaries", { preHandler: requirePermission("VIEW_PATIENTS") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "patient_not_found" });
    const q = z.object({ journeyId: uuid.optional() }).safeParse(request.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_request" });
    const rows = await listPatientSummaries(app.db, request.sessionUser!.tenantId, id.data, q.data.journeyId);
    if (!rows) return reply.status(404).send({ error: "patient_not_found" });
    return rows;
  });
}
