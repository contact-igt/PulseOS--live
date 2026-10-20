import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionCookieBase } from "../auth/cookies.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { recordPlatformAudit, userAgentOf } from "./audit.service.js";
import { loginPlatform, PLATFORM_SESSION_COOKIE, revokePlatformSession } from "./platform-auth.service.js";

const loginBody = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) }).strict();

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

export async function platformAuthRoutes(app: FastifyInstance) {
  // Stricter than the hospital sign-in: fewer attempts per account and per address before a wait.
  const throttle = new LoginThrottle({ maxPerAccount: num(process.env.PLATFORM_LOGIN_MAX_FAILURES) ?? 5, maxPerAddress: num(process.env.PLATFORM_LOGIN_MAX_FAILURES_PER_ADDRESS) ?? 10, windowMs: num(process.env.LOGIN_LOCK_WINDOW_MS) });

  app.post("/platform/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const { email, password } = parsed.data;
    const meta = { ip: request.ip, userAgent: userAgentOf(request) };

    const gate = throttle.begin(request.ip, `platform:${email.toLowerCase()}`);
    if (!gate.allowed) {
      await recordPlatformAudit(app.db, { platformUserId: null, label: email.toLowerCase(), ...meta }, { action: "platform.login", outcome: "DENIED", summary: "Platform sign-in refused: too many attempts" });
      return reply.header("Retry-After", String(gate.retryAfterSeconds)).status(429).send({ error: "too_many_attempts", message: "Too many sign-in attempts. Please wait a few minutes and try again." });
    }

    const result = await loginPlatform(app.db, email, password, meta);
    if (!result.ok) {
      await recordPlatformAudit(app.db, { platformUserId: result.platformUserId, label: email.toLowerCase(), ...meta }, { action: "platform.login", outcome: "FAILURE", summary: "Platform sign-in failed" });
      return reply.status(401).send({ error: "invalid_credentials" });
    }
    throttle.succeed(request.ip, `platform:${email.toLowerCase()}`);
    await recordPlatformAudit(app.db, { platformUserId: result.user.id, label: result.user.email, ...meta }, { action: "platform.login", summary: `${result.user.name} signed in to the Platform Console`, targetType: "platform_user", targetId: result.user.id });
    reply.setCookie(PLATFORM_SESSION_COOKIE, result.sessionId, { ...sessionCookieBase(), expires: result.expiresAt });
    return reply.send({ user: result.user });
  });

  app.post("/platform/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[PLATFORM_SESSION_COOKIE];
    if (sessionId) await revokePlatformSession(app.db, sessionId);
    const { path, sameSite, secure } = sessionCookieBase();
    reply.clearCookie(PLATFORM_SESSION_COOKIE, { path, sameSite, secure });
    return reply.send({ ok: true });
  });

  app.get("/platform/auth/session", async (request, reply) => {
    if (!request.platformUser) return reply.status(401).send({ error: "unauthenticated" });
    const { sessionId: _sessionId, ...user } = request.platformUser;
    void _sessionId;
    return reply.send({ user });
  });
}
