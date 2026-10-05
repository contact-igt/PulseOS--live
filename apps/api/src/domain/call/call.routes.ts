import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasPermission } from "@pulseos/types";
import { requirePermission } from "../auth/permission.middleware.js";
import { addCallFeedback, getCallRecordingRef, logManualCall } from "./call.service.js";
import { getCallTranscript, retryCallIntelligence } from "./call-intelligence.service.js";
import { streamRecording } from "./recording.js";

const uuid = z.string().uuid();
const callback = z.object({ dueAt: z.string().min(1), note: z.string().max(500).optional(), assignedTo: uuid.optional() }).strict();
const appointment = z.object({ scheduledAt: z.string().min(1).max(40), confirmed: z.boolean().optional(), doctorId: uuid.optional(), branchId: uuid.optional(), reason: z.string().max(500).optional() }).strict();
const logBody = z
  .object({
    direction: z.enum(["inbound", "outbound"]),
    connected: z.boolean(),
    occurredAt: z.string().optional(),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    staffFeedback: z.string().max(2000).optional(),
    outcomeKey: z.string().min(1).max(60).optional(),
    callback: callback.optional(),
    appointment: appointment.optional(),
    idempotencyKey: z.string().min(8).max(80).optional(),
  })
  .strict();
const feedbackBody = z.object({ staffFeedback: z.string().max(2000).optional(), outcomeKey: z.string().min(1).max(60).optional(), callback: callback.optional() }).strict();
const downloadQuery = z.object({ download: z.enum(["1", "true"]).optional() });

const REASON_STATUS: Record<string, number> = {
  journey_not_found: 404,
  call_not_found: 404,
  call_not_linked: 409,
  callback_exists: 409,
  outcome_not_found: 400,
  follow_up_required: 422,
  callback_in_past: 422,
  occurred_in_future: 422,
  invalid_request: 400,
  // Booking from a call: the same refusals as booking directly.
  appointment_time_in_past: 422,
  outside_clinic_hours: 422,
  resource_unavailable: 409,
  doctor_not_found: 404,
  branch_not_found: 404,
  doctor_required: 422,
  branch_required: 422,
};

export async function callRoutes(app: FastifyInstance) {
  // Staff log a call from a Journey. Admin and Staff may; the Doctor role may not.
  app.post("/journeys/:id/calls", { preHandler: requirePermission("LOG_CALL") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "journey_not_found" });
    const parsed = logBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const user = request.sessionUser!;
    // Booking a visit is its own permission: a call alone never lets a role book.
    if (parsed.data.appointment && !hasPermission(user.role, "MANAGE_APPOINTMENTS")) return reply.status(403).send({ error: "forbidden" });
    const result = await logManualCall(app.db, user.tenantId, { id: user.id, name: user.name, role: user.role }, id.data, parsed.data, new Date(), user.timezone);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return reply.status(result.duplicate ? 200 : 201).send({ callId: result.callId, callbackTaskId: result.callbackTaskId, appointmentId: result.appointmentId ?? null, appointmentStatus: result.appointmentStatus ?? null, duplicate: result.duplicate });
  });

  // Staff feedback / outcome / callback on a call that already exists (an IVR call, or editing one's own note).
  app.post("/calls/:id/feedback", { preHandler: requirePermission("LOG_CALL") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "call_not_found" });
    const parsed = feedbackBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const user = request.sessionUser!;
    const result = await addCallFeedback(app.db, user.tenantId, { id: user.id, name: user.name, role: user.role }, id.data, parsed.data, new Date(), user.timezone);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return { ok: true, callbackTaskId: result.callbackTaskId };
  });

  // Recording playback / download. The provider URL is never returned: PulseOS authorizes, then streams.
  app.get("/calls/:id/recording", { preHandler: requirePermission("VIEW_CALL_RECORDING") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    const query = downloadQuery.safeParse(request.query);
    if (!id.success || !query.success) return reply.status(404).send({ error: "recording_not_found" });
    const download = query.data.download !== undefined;
    // Downloading is a stricter capability than listening.
    if (download && !hasPermission(request.sessionUser!.role, "DOWNLOAD_CALL_RECORDING")) {
      return reply.status(403).send({ error: "forbidden", requiredPermission: "DOWNLOAD_CALL_RECORDING" });
    }
    const ref = await getCallRecordingRef(app.db, request.sessionUser!.tenantId, id.data);
    if (!ref) return reply.status(404).send({ error: "recording_not_found" });
    return streamRecording(request, reply, ref, { download, filename: `call-${id.data.slice(0, 8)}` });
  });

  app.get("/calls/:id/transcript", { preHandler: requirePermission("VIEW_CALL_TRANSCRIPT") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "call_not_found" });
    const transcript = await getCallTranscript(app.db, request.sessionUser!.tenantId, id.data);
    if (!transcript) return reply.status(404).send({ error: "call_not_found" });
    reply.header("cache-control", "private, no-store");
    return transcript;
  });

  // Put a failed transcript / summary back in the queue (Admin level: whoever may read transcripts).
  app.post("/calls/:id/intelligence/retry", { preHandler: requirePermission("VIEW_CALL_TRANSCRIPT") }, async (request, reply) => {
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.status(404).send({ error: "call_not_found" });
    const result = await retryCallIntelligence(app.db, request.sessionUser!.tenantId, id.data);
    if (result === "not_found") return reply.status(404).send({ error: "call_not_found" });
    return reply.status(result === "queued" ? 202 : 409).send({ queued: result === "queued" });
  });
}
