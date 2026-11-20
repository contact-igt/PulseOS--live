import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePlatform } from "../platform/platform-access.js";
import { setSessionCookie } from "../auth/auth.routes.js";
import { hospitalCreationSchema, ONBOARDING_EDITION } from "./hospital-onboarding.schema.js";
import {
  activateHospital, createHospital, issueHospitalInvitation, onboardingStatus,
  opaqueTokenShape, redeemHospitalInvitation, resendHospitalInvitation, retryHospitalTemplate,
} from "./hospital-onboarding.service.js";

const idSchema = z.string().uuid().transform((id) => id.toLowerCase());
const paramsSchema = z.object({ id: idSchema });
const invitationSchema = z.object({
  token: z.string().regex(opaqueTokenShape),
  password: z.string().min(12).max(128),
}).strict();
const errorStatus: Record<string, number> = {
  not_found: 404,
  invalid_phone: 400,
  provisioning_failed: 503,
  invitation_cooldown: 429,
  mail_not_configured: 503,
};

export async function hospitalOnboardingRoutes(app: FastifyInstance) {
  app.post("/auth/hospital-invitations/redeem", { bodyLimit: 4096 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = invitationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const accepted = await redeemHospitalInvitation(app.db, parsed.data.token, parsed.data.password);
    if (!accepted) return reply.status(400).send({ error: "invitation_unavailable" });
    if (accepted.session) setSessionCookie(reply, accepted.session.id, accepted.session.expiresAt, false);
    return { accepted: true, signedIn: Boolean(accepted.session) };
  });

  await app.register(async (platform) => {
    platform.post("/hospitals", { bodyLimit: 8192, onRequest: requirePlatform("hospital:create") }, async (request, reply) => {
      const id = idSchema.safeParse(request.headers["idempotency-key"]);
      const parsed = hospitalCreationSchema.safeParse(request.body);
      if (!id.success) return reply.status(400).send({ error: "invalid_request" });
      if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.map((issue) => ({ path: String(issue.path[0] ?? ""), message: issue.message })) });
      const { edition, ...details } = parsed.data;
      const result = await createHospital(app.db, id.data, request.platformActor!, {
        ...details, edition: ONBOARDING_EDITION[edition],
      });
      if ("error" in result) return reply.status(errorStatus[result.error] ?? 409).send(result);
      return reply.status(result.created ? 201 : 200).send(result.hospital);
    });

    platform.get("/hospitals/:id", { onRequest: requirePlatform("hospital:read") }, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "invalid_request" });
      const result = await onboardingStatus(app.db, params.data.id);
      return result ?? reply.status(404).send({ error: "not_found" });
    });

    platform.post("/hospitals/:id/invitation-resend", { bodyLimit: 1024, onRequest: requirePlatform("hospital:read") }, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const key = idSchema.safeParse(request.headers["idempotency-key"]);
      if (!params.success || !key.success) return reply.status(400).send({ error: "invalid_request" });
      const permitted = request.platformAccount?.role === "PLATFORM_SUPER_ADMIN" &&
        request.platformAccount.permissions.includes("hospital:invite");
      const result = await resendHospitalInvitation(app.db, params.data.id, request.platformActor!, key.data, Boolean(permitted));
      if ("error" in result && result.error) {
        if (result.error === "invitation_cooldown") reply.header("Retry-After", "60");
        return reply.status(result.error === "forbidden" ? 403 : errorStatus[result.error] ?? 409).send(result);
      }
      return reply.status(202).send(result);
    });

    for (const [action, permission, run] of [
      ["retry-template", "hospital:retry", retryHospitalTemplate],
      ["invitation", "hospital:invite", issueHospitalInvitation],
      ["activate", "hospital:activate", activateHospital],
    ] as const) {
      platform.post(`/hospitals/:id/${action}`, { bodyLimit: 4096, onRequest: requirePlatform(permission) }, async (request, reply) => {
        const params = paramsSchema.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid_request" });
        const result = await run(app.db, params.data.id, request.platformActor!);
        if (action === "invitation") reply.header("Cache-Control", "no-store");
        if ("error" in result && result.error) {
          if (result.error === "invitation_cooldown") reply.header("Retry-After", "60");
          return reply.status(errorStatus[result.error] ?? 409).send(result);
        }
        return result;
      });
    }
  }, { prefix: "/platform" });
}
