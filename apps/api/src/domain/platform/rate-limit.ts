import type { FastifyReply, FastifyRequest } from "fastify";
import { SlidingWindowLimiter } from "../../lib/rate-limiter.js";

const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);

// Sensitive console actions are limited per staff member (and per address), on top of their permission checks.
const limiters = {
  // invitation resend, password reset links
  links: new SlidingWindowLimiter(num(process.env.PLATFORM_LINK_ACTIONS_PER_MINUTE, 20)),
  // session revocation, suspensions
  access: new SlidingWindowLimiter(num(process.env.PLATFORM_ACCESS_ACTIONS_PER_MINUTE, 30)),
  // starting support sessions, enabling support edits
  support: new SlidingWindowLimiter(num(process.env.PLATFORM_SUPPORT_ACTIONS_PER_MINUTE, 10)),
};

export function platformRateLimit(kind: keyof typeof limiters) {
  return async function rateLimitPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const who = request.platformUser?.id ?? request.ip;
    const d = limiters[kind].hit(`${kind}:${who}`);
    if (!d.allowed) return reply.header("Retry-After", String(d.retryAfterSeconds)).status(429).send({ error: "too_many_requests" });
  };
}
