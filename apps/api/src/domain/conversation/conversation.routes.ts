import type { FastifyInstance } from "fastify";
import { MESSAGE_ATTACHMENT_KINDS, type ConversationChannel, type MessageAttachmentKind, type OwnershipState } from "@pulseos/types";
import { Readable } from "node:stream";
import { requireCapability, requirePermission } from "../auth/permission.middleware.js";
import {
  assignConversation,
  claimConversation,
  retryConversationMessage,
  closeConversation,
  getConversationAutomation,
  getConversationDetail,
  fetchConversationAttachment,
  listConversations,
  returnConversationToAi,
  sendMessage,
  sendMediaMessage,
  setConversationAutomation,
} from "./conversation.service.js";
import type { SetConversationAutomationInput } from "./conversation.service.js";

const REASON_STATUS: Record<string, number> = {
  conversation_not_found: 404,
  assignee_not_found: 404,
  conversation_closed: 409,
  schedule_required: 400,
  message_not_found: 404,
  // Not a fault in the request: a free-form text cannot go out after the 24-hour window, or a delivered message cannot be re-sent.
  template_required: 409,
  media_not_supported: 409,
  file_too_large: 413,
  unsupported_type: 400,
  empty_file: 400,
  invalid_media: 400,
  // The provider could not take the file: the reason is in `message`.
  send_failed: 502,
  not_retryable: 409,
  invalid_request: 400,
};

export async function conversationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireCapability("WHATSAPP_INBOX"));
  app.addHook("preHandler", requirePermission("VIEW_INBOX"));

  app.get("/conversations", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = request.query as { channel?: ConversationChannel; ownershipState?: OwnershipState; search?: string; communicationEndpointId?: string };
    return listConversations(app.db, tenantId, query);
  });

  app.get("/conversations/:id", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const detail = await getConversationDetail(app.db, tenantId, id);
    if (!detail) return reply.status(404).send({ error: "conversation_not_found" });
    return detail;
  });

  app.get("/conversations/:id/messages/:messageId/attachments/:attachmentId", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id, messageId, attachmentId } = request.params as { id: string; messageId: string; attachmentId: string };
    // Relayed through PulseOS (not a redirect to the provider): see fetchConversationAttachment.
    const file = await fetchConversationAttachment(app.db, tenantId, id, messageId, attachmentId, { range: request.headers.range });
    if (!file) return reply.status(404).send({ error: "attachment_not_found" });
    reply.status(file.status);
    for (const [name, value] of Object.entries(file.headers)) reply.header(name, value);
    return reply.send(file.body ? Readable.fromWeb(file.body as never) : null);
  });

  app.post("/conversations/:id/messages", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const { id } = request.params as { id: string };
    const { body } = (request.body ?? {}) as { body?: unknown };
    if (typeof body !== "string" || !body.trim() || body.length > 4096) return reply.status(400).send({ error: "invalid_request" });
    const result = await sendMessage(app.db, tenantId, id, actorId, body.trim());
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  // Send a failed message again, as the same message.
  app.post("/conversations/:id/messages/:messageId/retry", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    const result = await retryConversationMessage(app.db, request.sessionUser!.tenantId, id, messageId, request.sessionUser!.id);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  app.post("/conversations/:id/media", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = (request.body ?? {}) as { kind?: string; fileName?: string; mimeType?: string; base64?: string; caption?: string };
    if (!(MESSAGE_ATTACHMENT_KINDS as readonly string[]).includes(input.kind ?? "") || typeof input.fileName !== "string" || typeof input.mimeType !== "string" || typeof input.base64 !== "string" || input.base64.length > 34 * 1024 * 1024 || typeof input.caption !== "string") return reply.status(400).send({ error: "invalid_media" });
    const result = await sendMediaMessage(app.db, request.sessionUser!.tenantId, id, request.sessionUser!.id, { kind: input.kind as MessageAttachmentKind, fileName: input.fileName.slice(0, 255), mimeType: input.mimeType.slice(0, 127), base64: input.base64, caption: input.caption.slice(0, 4096) });
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason, ...(result.detail ? { message: result.detail } : {}) });
    return result;
  });

  app.patch("/conversations/:id/claim", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const { id } = request.params as { id: string };
    const result = await claimConversation(app.db, tenantId, id, actorId);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  app.patch("/conversations/:id/assign", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const { id } = request.params as { id: string };
    const { assignedTo } = request.body as { assignedTo: string };
    const result = await assignConversation(app.db, tenantId, id, actorId, assignedTo);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  app.patch("/conversations/:id/return-to-ai", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const { id } = request.params as { id: string };
    const result = await returnConversationToAi(app.db, tenantId, id, actorId);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  app.patch("/conversations/:id/close", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const { id } = request.params as { id: string };
    const result = await closeConversation(app.db, tenantId, id, actorId);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  // Configuration/scheduling state only — see conversation.service.ts's
  // setConversationAutomation for why this never implies a live agent runtime.
  app.get("/conversations/:id/automation", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { id } = request.params as { id: string };
    const preference = await getConversationAutomation(app.db, tenantId, id);
    if (!preference) return reply.status(404).send({ error: "conversation_not_found" });
    return preference;
  });

  app.patch("/conversations/:id/automation", { preHandler: requirePermission("MANAGE_INBOX") }, async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const { id } = request.params as { id: string };
    const input = request.body as SetConversationAutomationInput;
    const result = await setConversationAutomation(app.db, tenantId, id, actorId, input);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result.preference;
  });
}
