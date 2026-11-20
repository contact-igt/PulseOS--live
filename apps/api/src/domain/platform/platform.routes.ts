import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { PLATFORM_ONBOARDING_GRANTS, PLATFORM_ROLES } from "@pulseos/types";
import { platformAccounts, platformMfaRecoveries, platformSecurityAudit } from "../../db/platform-schema.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { opaqueTokenShape } from "../tenant/hospital-onboarding.service.js";
import { ABSOLUTE_MS, accountView, beginEnrollment, changePlatformAccount, completeEnrollment, ENROLLMENT_MS,
  invitePlatformAccount, loginPlatform, logoutPlatform, managePlatformRecovery } from "./platform-auth.service.js";
import { browserWrite, ENROLLMENT_COOKIE, PLATFORM_COOKIE, platformCookieOptions, requirePlatform } from "./platform-access.js";
import { auditPage, hospitalDirectory, messagingExceptions, platformDashboard } from "./platform-directory.service.js";
import { platformMfaKey } from "./platform-mfa.js";

export const platformEmail = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(128);
const code = z.string().regex(/^\d{6}$/);
const token = z.string().regex(opaqueTokenShape);
const role = z.enum(PLATFORM_ROLES);
const grants = z.array(z.enum(PLATFORM_ONBOARDING_GRANTS)).max(4).transform((values) => [...new Set(values)]);
const inviteSchema = z.object({ email: platformEmail, role, permissions: grants }).strict();
const changeSchema = z.object({ role, permissions: grants, disabled: z.boolean(), reissue: z.boolean().optional() }).strict();
const pagination = z.object({ page: z.coerce.number().int().min(1).max(100).default(1), limit: z.coerce.number().int().min(1).max(50).default(25) });
const bodyLimit = 4096;

function invalid(reply: FastifyReply) {
  return reply.status(400).send({ error: "invalid_request" });
}

function authenticationFailed(reply: FastifyReply) {
  return reply.status(401).send({ error: "authentication_failed" });
}

async function browserGuard(request: FastifyRequest, reply: FastifyReply) {
  if (!browserWrite(request) || request.headers.authorization) return reply.status(403).send({ error: "cross_origin_request_blocked" });
}

function setSession(reply: FastifyReply, value: string) {
  reply.setCookie(PLATFORM_COOKIE, value, { ...platformCookieOptions(), maxAge: ABSOLUTE_MS / 1000 });
  reply.clearCookie(ENROLLMENT_COOKIE, platformCookieOptions());
  return { authenticated: true };
}

export async function platformRoutes(app: FastifyInstance) {
  const throttle = new LoginThrottle();
  const authOptions = { bodyLimit, onRequest: browserGuard };
  app.post("/login", authOptions, async (request, reply) => {
    const parsed = z.object({ email: platformEmail, password, code: code.optional() }).strict().safeParse(request.body);
    if (!parsed.success) return authenticationFailed(reply);
    const key = platformMfaKey();
    if (!key) return reply.status(503).send({ error: "platform_auth_unavailable" });
    const input = parsed.data;
    const gate = throttle.begin(request.ip, input.email);
    if (!gate.allowed) return reply.header("Retry-After", gate.retryAfterSeconds).status(429).send({ error: "authentication_failed" });
    const session = await loginPlatform(app.db, key, input.email, input.password, input.code);
    if (!session) return authenticationFailed(reply);
    throttle.succeed(request.ip, input.email);
    return setSession(reply, session);
  });

  app.post("/enroll", authOptions, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z.object({ invitation: token, password: password.min(15) }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const key = platformMfaKey();
    if (!key) return reply.status(503).send({ error: "platform_auth_unavailable" });
    const gate = throttle.begin(request.ip, "enroll");
    if (!gate.allowed) return reply.header("Retry-After", gate.retryAfterSeconds).status(429).send({ error: "authentication_failed" });
    const enrollment = await beginEnrollment(app.db, key, parsed.data.invitation, parsed.data.password);
    if (!enrollment) return authenticationFailed(reply);
    reply.setCookie(ENROLLMENT_COOKIE, enrollment.value, { ...platformCookieOptions(), maxAge: ENROLLMENT_MS / 1000 });
    return { setupKey: enrollment.setupKey, email: enrollment.email };
  });

  app.post("/enroll/verify", authOptions, async (request, reply) => {
    const parsed = z.object({ code }).strict().safeParse(request.body);
    const challenge = token.safeParse(request.cookies[ENROLLMENT_COOKIE]);
    if (!parsed.success || !challenge.success) return authenticationFailed(reply);
    const key = platformMfaKey();
    if (!key) return reply.status(503).send({ error: "platform_auth_unavailable" });
    const session = await completeEnrollment(app.db, key, challenge.data, parsed.data.code);
    return session ? setSession(reply, session) : authenticationFailed(reply);
  });

  app.get("/me", { onRequest: requirePlatform("dashboard:read") }, async (request) => request.platformAccount);
  app.post("/logout", { onRequest: requirePlatform("dashboard:read"), bodyLimit }, async (request, reply) => {
    await logoutPlatform(app.db, request.cookies[PLATFORM_COOKIE]!, request.platformAccount!.id);
    reply.clearCookie(PLATFORM_COOKIE, platformCookieOptions());
    return { authenticated: false };
  });

  app.get("/dashboard", { onRequest: requirePlatform("dashboard:read") }, async (request) =>
    platformDashboard(app.db, request.platformAccount!.permissions.includes("audit:read")));

  app.get("/operations/messaging", { onRequest: requirePlatform("hospital:lifecycle:read") }, async (request, reply) => {
    const parsed = pagination.extend({ status: z.enum(["pending", "failed"]).optional(), tenantId: z.string().uuid().optional() })
      .strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { page, limit, status, tenantId } = parsed.data;
    return messagingExceptions(app.db, limit, (page - 1) * limit, status, tenantId);
  });

  app.get("/hospitals", { onRequest: requirePlatform("dashboard:read") }, async (request, reply) => {
    const parsed = pagination.extend({ search: z.string().trim().max(120).default("") }).strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { page, limit, search } = parsed.data;
    return hospitalDirectory(app.db, limit, (page - 1) * limit, search);
  });

  app.get("/hospitals/legacy/:id", { onRequest: requirePlatform("dashboard:read") }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return invalid(reply);
    const [row] = (await hospitalDirectory(app.db, 1, 0, "", parsed.data.id)).items;
    return row && !row.onboardingId ? row : reply.status(404).send({ error: "not_found" });
  });

  app.get("/administrators", { onRequest: requirePlatform("team:manage") }, async (request, reply) => {
    const parsed = pagination.strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { page, limit } = parsed.data;
    const rows = await app.db.select({ account: platformAccounts, status: platformMfaRecoveries.status,
      expiresAt: platformMfaRecoveries.expiresAt, requestedBy: platformMfaRecoveries.requestedBy })
      .from(platformAccounts).leftJoin(platformMfaRecoveries, eq(platformMfaRecoveries.accountId, platformAccounts.id))
      .orderBy(asc(platformAccounts.email)).limit(limit + 1).offset((page - 1) * limit);
    const viewerId = request.platformAccount?.id;
    return { hasMore: rows.length > limit, items: rows.slice(0, limit).map(({ account, status, expiresAt, requestedBy }) => ({
      ...accountView(account), enrolled: Boolean(account.mfaSecret), disabled: Boolean(account.disabledAt), canRecover: Boolean(account.passwordHash),
      recovery: status && expiresAt ? {
        status: (status === "pending" || status === "approved") && +expiresAt <= Date.now() ? "expired" : status,
        expiresAt,
        canApprove: Boolean(status === "pending" && +expiresAt > Date.now() && !account.disabledAt && account.passwordHash &&
          viewerId && requestedBy && requestedBy !== viewerId && account.id !== viewerId),
      } : null,
    })) };
  });

  app.get("/administrators/:id/recovery", { onRequest: requirePlatform("audit:read") }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const rows = await app.db.select({ id: platformSecurityAudit.id, action: platformSecurityAudit.action,
      actorId: platformSecurityAudit.actorId, createdAt: platformSecurityAudit.createdAt }).from(platformSecurityAudit)
      .where(and(eq(platformSecurityAudit.subjectId, params.data.id),
        like(platformSecurityAudit.action, "%mfa_recovery%")))
      .orderBy(desc(platformSecurityAudit.createdAt), desc(platformSecurityAudit.id)).limit(10);
    return { items: rows };
  });

  app.post("/administrators/:id/recovery", { onRequest: requirePlatform("team:manage"), bodyLimit }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = z.discriminatedUnion("action", [
      z.object({ action: z.literal("request") }).strict(),
      z.object({ action: z.literal("approve"), code }).strict(),
      z.object({ action: z.literal("reject") }).strict(),
    ]).safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const actor = request.platformAccount!.id;
    const key = platformMfaKey();
    if (!key) return reply.status(503).send({ error: "platform_auth_unavailable" });
    if (parsed.data.action === "approve") {
      const gate = throttle.begin(request.ip, "recovery:" + actor);
      if (!gate.allowed) return reply.header("Retry-After", gate.retryAfterSeconds).status(429).send({ error: "authentication_failed" });
    }
    const result = await managePlatformRecovery(app.db, key, actor, params.data.id, parsed.data.action,
      parsed.data.action === "approve" ? parsed.data.code : undefined);
    if ("error" in result) return reply.status(result.error === "not_found" ? 404 : result.error === "forbidden" ? 403
      : result.error === "authentication_failed" ? 401 : 409).send(result);
    if (parsed.data.action === "approve") throttle.succeed(request.ip, "recovery:" + actor);
    return result;
  });

  app.post("/administrators", { onRequest: requirePlatform("team:manage"), bodyLimit }, async (request, reply) => {
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { email, role: targetRole, permissions } = parsed.data;
    const result = await invitePlatformAccount(app.db, request.platformAccount!.id, email, targetRole, permissions);
    if ("error" in result) return reply.status(result.error === "forbidden" ? 403 : 409).send(result);
    return reply.status(201).send(result);
  });

  app.patch("/administrators/:id", { onRequest: requirePlatform("team:manage"), bodyLimit }, async (request, reply) => {
    const parsed = changeSchema.safeParse(request.body);
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success || !params.success) return invalid(reply);
    const result = await changePlatformAccount(app.db, request.platformAccount!.id, params.data.id, parsed.data);
    if ("error" in result) return reply.status(result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409).send(result);
    return result;
  });

  app.get("/audit", { onRequest: requirePlatform("audit:read") }, async (request, reply) => {
    const parsed = pagination.strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { page, limit } = parsed.data;
    return auditPage(app.db, limit, (page - 1) * limit);
  });
}
