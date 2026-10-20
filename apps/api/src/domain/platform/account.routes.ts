import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SlidingWindowLimiter } from "../../lib/rate-limiter.js";
import { userAgentOf } from "./audit.service.js";
import { acceptAccountToken, inspectAccountToken } from "./account-tokens.service.js";
import { localOutbox } from "./email.js";

const tokenBody = z.object({ token: z.string().min(1).max(200) }).strict();
const acceptBody = z.object({ token: z.string().min(1).max(200), password: z.string().min(10, "At least 10 characters").max(128) }).strict();

function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_LOGIN === "true";
}
const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

/**
 * Public account links: an invitation or a password reset. The token travels in the request BODY (the web page reads it
 * from the URL fragment, which browsers never send to a server), so it is never in a URL the API or a proxy logs.
 * Invalid, used, revoked and expired tokens all answer the same way.
 */
export async function accountRoutes(app: FastifyInstance) {
  const limiter = new SlidingWindowLimiter(Number(process.env.ACCOUNT_TOKEN_MAX_PER_MINUTE) || 20);
  const limited = (ip: string) => !limiter.hit(`account-token:${ip}`).allowed;

  app.post("/auth/account-token/inspect", async (request, reply) => {
    if (limited(request.ip)) return reply.status(429).send({ error: "too_many_requests" });
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return reply.status(404).send({ error: "invalid_token" });
    const info = await inspectAccountToken(app.db, parsed.data.token);
    return info ? info : reply.status(404).send({ error: "invalid_token" });
  });

  app.post("/auth/account-token/accept", async (request, reply) => {
    if (limited(request.ip)) return reply.status(429).send({ error: "too_many_requests" });
    const parsed = acceptBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const info = await inspectAccountToken(app.db, parsed.data.token);
    if (info && parsed.data.password.toLowerCase() === info.email.toLowerCase()) return reply.status(400).send({ error: "invalid_request", issues: [{ path: "password", message: "The password must not be your email" }] });
    const r = await acceptAccountToken(app.db, parsed.data.token, parsed.data.password, { ip: request.ip, userAgent: userAgentOf(request) });
    if (!r.ok) return reply.status(r.reason === "invalid_token" ? 400 : 409).send({ error: r.reason });
    return { ok: true, signInPath: r.signInPath };
  });

  // Development only, this machine only: what the local outbox "sent" (there is no email provider yet).
  if (devLoginEnabled()) {
    app.get("/dev/outbox", async (request, reply) => {
      if (!isLoopback(request.ip)) return reply.status(403).send({ error: "dev_only" });
      return { messages: localOutbox()?.messages ?? [] };
    });
  }
}
