import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordActivity } from "../activity/activity.service.js";
import { requireCapability, requirePermission } from "../auth/permission.middleware.js";
import { listNotificationsFor, listRules, listTemplates, previewFollowUpMessage, sendFollowUpMessage, updateRule, updateTemplate } from "./notification.service.js";

const REASON_STATUS: Record<string, number> = {
  template_not_found: 404,
  rule_not_found: 404,
  journey_not_found: 404,
  feature_not_available: 403,
  invalid_body: 422,
  unknown_variable: 422,
  invalid_offset: 422,
  invalid_gap: 422,
  confirmation_has_no_offset: 422,
  template_mismatch: 422,
  // Not an error in the request: the message cannot be sent right now, and the reason says why.
  NO_VALID_PHONE: 409,
  PROVIDER_NOT_CONFIGURED: 409,
  TEMPLATE_UNAVAILABLE: 409,
  MISSING_VARIABLES: 409,
};

const templateSchema = z.object({ name: z.string().max(80).optional(), providerTemplateName: z.string().max(120).optional(), language: z.string().max(10).optional(), body: z.string().max(1024).optional(), enabled: z.boolean().optional() });
const ruleSchema = z.object({
  enabled: z.boolean().optional(),
  offsetValue: z.number().int().optional(),
  offsetUnit: z.enum(["minutes", "hours", "days"]).optional(),
  templateId: z.string().uuid().nullable().optional(),
  minGapMinutes: z.number().int().optional(),
});

export async function notificationRoutes(app: FastifyInstance) {
  // Everything here belongs to WhatsApp Notifications; with it off the API refuses, whatever the UI shows.
  app.addHook("preHandler", requireCapability("WHATSAPP_NOTIFICATIONS"));

  app.get("/notifications/templates", { preHandler: requirePermission("VIEW_INTEGRATIONS") }, async (request) => listTemplates(app.db, request.sessionUser!.tenantId));
  app.get("/notifications/rules", { preHandler: requirePermission("VIEW_INTEGRATIONS") }, async (request) => listRules(app.db, request.sessionUser!.tenantId));

  app.patch("/notifications/templates/:id", { preHandler: requirePermission("MANAGE_INTEGRATION_CONFIG") }, async (request, reply) => {
    const parsed = templateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const r = await updateTemplate(app.db, request.sessionUser!.tenantId, (request.params as { id: string }).id, parsed.data);
    if (!r.ok) return reply.status(REASON_STATUS[r.reason] ?? 400).send({ error: r.reason });
    // The template's identity and which fields changed; the message text itself is configuration, not logged.
    await recordActivity(app.db, { tenantId: request.sessionUser!.tenantId, actorId: request.sessionUser!.id, action: "template.updated", entityType: "message_template", entityKey: r.template.purpose, metadata: { changed: Object.keys(parsed.data), enabled: r.template.enabled } });
    return r.template;
  });

  app.patch("/notifications/rules/:id", { preHandler: requirePermission("MANAGE_INTEGRATION_CONFIG") }, async (request, reply) => {
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const r = await updateRule(app.db, request.sessionUser!.tenantId, (request.params as { id: string }).id, parsed.data);
    if (!r.ok) return reply.status(REASON_STATUS[r.reason] ?? 400).send({ error: r.reason });
    await recordActivity(app.db, { tenantId: request.sessionUser!.tenantId, actorId: request.sessionUser!.id, action: "reminder_rule.updated", entityType: "reminder_rule", entityKey: r.rule.id, metadata: { subject: r.rule.subject, kind: r.rule.kind, changed: parsed.data } });
    return r.rule;
  });

  // What the patient will receive, shown to the person before they send it.
  app.get("/journeys/:id/whatsapp/preview", { preHandler: requirePermission("MANAGE_TASKS") }, async (request, reply) => {
    const u = request.sessionUser!;
    const r = await previewFollowUpMessage(app.db, u.tenantId, u.id, (request.params as { id: string }).id);
    if (!r.ok) return reply.status(REASON_STATUS[r.reason] ?? 400).send({ error: r.reason });
    return r.preview;
  });

  // A person chose to send it. Sending never completes the follow-up task: that is a separate, deliberate action.
  app.post("/journeys/:id/whatsapp", { preHandler: requirePermission("MANAGE_TASKS") }, async (request, reply) => {
    const u = request.sessionUser!;
    const parsed = z.object({ idempotencyKey: z.string().min(8).max(80) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const r = await sendFollowUpMessage(app.db, u.tenantId, u.id, (request.params as { id: string }).id, parsed.data.idempotencyKey);
    if (!r.ok) return reply.status(REASON_STATUS[r.reason] ?? 400).send({ error: r.reason });
    return reply.status(r.duplicate ? 200 : 201).send({ notificationId: r.notificationId, status: r.status, duplicate: r.duplicate });
  });

  app.get("/journeys/:id/notifications", { preHandler: requirePermission("VIEW_TASKS") }, async (request) =>
    listNotificationsFor(app.db, request.sessionUser!.tenantId, "FOLLOW_UP", (request.params as { id: string }).id));
}
