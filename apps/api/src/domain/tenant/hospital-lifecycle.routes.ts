import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePlatform } from "../platform/platform-access.js";
import { redactLogText } from "../security/redact.js";
import { changeLifecycle, readLifecycle, targetTenant } from "./hospital-lifecycle.service.js";
import { replayHeldMetaLeads } from "../acquisition/suspended-meta-leads.service.js";
import { readLifecycleOperations } from "./hospital-lifecycle-operations.service.js";
import { requestMessagingAction } from "./hospital-messaging.service.js";
import { readHospitalArchivalAssessment } from "./hospital-archival-assessment.service.js";

const id = z.object({ id: z.string().uuid() });
const errorStatus: Record<string, number> = { forbidden: 403, invalid_request: 400, not_found: 404 };
const query = z.object({ legacy: z.literal("1").optional(), page: z.coerce.number().int().min(1).max(100).default(1) }).strict();
const change = z.object({
  version: z.number().int().min(0).max(2147483646),
  reason: z.enum(["SECURITY", "OPERATIONS", "COMPLIANCE", "SERVICE_RESTORED", "OTHER"]),
  explanation: z.string().trim().min(1).max(240).optional(),
}).strict().refine((value) => value.reason !== "OTHER" || Boolean(value.explanation));

export async function hospitalLifecycleRoutes(app: FastifyInstance) {
  app.get("/hospitals/:id/archival-assessment", { onRequest: requirePlatform("hospital:lifecycle:read") }, async (request, reply) => {
    if (request.platformAccount?.role !== "PLATFORM_SUPER_ADMIN") return reply.status(403).send({ error: "forbidden" });
    const params = id.safeParse(request.params);
    const q = z.object({ legacy: z.literal("1").optional() }).strict().safeParse(request.query);
    if (!params.success || !q.success) return reply.status(400).send({ error: "invalid_request" });
    reply.header("Cache-Control", "no-store");
    const result = await readHospitalArchivalAssessment(app.db, { id: params.data.id, legacy: q.data.legacy === "1" });
    return result ?? reply.status(404).send({ error: "not_found" });
  });
  for (const action of ["retry", "resume"] as const) {
    app.post("/hospitals/:id/whatsnexus-" + action, {
      onRequest: requirePlatform("hospital:read"), bodyLimit: 1024,
    }, async (request, reply) => {
      const params = id.safeParse(request.params);
      const q = query.safeParse(request.query);
      const body = z.object({ version: z.number().int().nonnegative(), approved: z.literal(true) }).strict().safeParse(request.body);
      if (!params.success || !q.success || !body.success) return reply.status(400).send({ error: "invalid_request" });
      const tenantId = await targetTenant(app.db, { id: params.data.id, legacy: q.data.legacy === "1" });
      if (!tenantId) return reply.status(404).send({ error: "not_found" });
      const error = await requestMessagingAction(app.db, tenantId, params.data.id, body.data.version,
        request.platformActor!, action, request.platformAccount?.permissions ?? []);
      return error ? reply.status(error === "forbidden" ? 403 : 409).send({ error }) : reply.status(202).send({ queued: true });
    });
  }
  app.get("/hospitals/:id/lifecycle-operations", { onRequest: requirePlatform("hospital:lifecycle:read") }, async (request, reply) => {
    const params = id.safeParse(request.params);
    const q = query.safeParse(request.query);
    if (!params.success || !q.success) return reply.status(400).send({ error: "invalid_request" });
    const tenantId = await targetTenant(app.db, { id: params.data.id, legacy: q.data.legacy === "1" });
    return tenantId ? readLifecycleOperations(app.db, tenantId, request.platformAccount?.permissions.includes("audit:read"))
      : reply.status(404).send({ error: "not_found" });
  });

  app.post("/hospitals/:id/replay-held-meta-leads", { onRequest: requirePlatform("hospital:restore"), bodyLimit: 1024 }, async (request, reply) => {
    const params = id.safeParse(request.params);
    const q = query.safeParse(request.query);
    const body = z.object({ version: z.number().int().nonnegative(), approved: z.literal(true) }).strict().safeParse(request.body);
    if (!params.success || !q.success || !body.success) return reply.status(400).send({ error: "invalid_request" });
    const tenantId = await targetTenant(app.db, { id: params.data.id, legacy: q.data.legacy === "1" });
    if (!tenantId) return reply.status(404).send({ error: "not_found" });
    return await replayHeldMetaLeads(app.db, tenantId, request.platformActor!.id, body.data.version)
      ?? reply.status(409).send({ error: "lifecycle_version_conflict" });
  });
  for (const [path, history] of [["lifecycle", false], ["lifecycle-history", true]] as const) {
    app.get("/hospitals/:id/" + path, { onRequest: requirePlatform("hospital:lifecycle:read") }, async (request, reply) => {
      const params = id.safeParse(request.params);
      const q = query.safeParse(request.query);
      if (!params.success || !q.success) return reply.status(400).send({ error: "invalid_request" });
      const value = await readLifecycle(app.db, { id: params.data.id, legacy: q.data.legacy === "1" }, history, q.data.page);
      return value ?? reply.status(404).send({ error: "not_found" });
    });
  }
  for (const [action, state, permission] of [
    ["suspend", "SUSPENDED", "hospital:suspend"], ["restore", "ACTIVE", "hospital:restore"],
  ] as const) {
    app.post("/hospitals/:id/" + action, { onRequest: requirePlatform("hospital:read"), bodyLimit: 2048 }, async (request, reply) => {
      const params = id.safeParse(request.params);
      const q = query.safeParse(request.query);
      if (!params.success) return reply.status(400).send({ error: "invalid_request" });
      const parsed = change.safeParse(request.body);
      const input = parsed.success && q.success ? {
        ...parsed.data, explanation: redactLogText(parsed.data.explanation) ?? undefined,
      } : null;
      const value = await changeLifecycle(app.db, { id: params.data.id, legacy: q.success && q.data.legacy === "1" },
        request.platformActor!, state, input,
        request.platformAccount?.permissions.includes(permission) === true);
      if ("error" in value) {
        return reply.status(errorStatus[value.error] ?? 409).send(value);
      }
      return value;
    });
  }
}
