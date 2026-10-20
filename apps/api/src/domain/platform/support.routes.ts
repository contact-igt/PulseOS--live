import type { FastifyInstance, FastifyRequest } from "fastify";
import { sessionCookieBase } from "../auth/cookies.js";
import { actorFromRequest } from "./audit.service.js";
import { parse, refuse } from "./http.js";
import { requirePlatform } from "./platform-guard.js";
import { platformRateLimit } from "./rate-limit.js";
import { enableEditsSchema, enableSupportEdits, endSupportSession, listSupportSchema, listSupportSessions, startSupportSchema, startSupportSession, SUPPORT_COOKIE } from "./support.service.js";

const supportActor = (request: FastifyRequest) => ({ ...actorFromRequest(request), platformUserId: request.platformUser!.id, context: "SUPPORT_MODE" as const });

export async function platformSupportRoutes(app: FastifyInstance) {
  app.get("/platform/support-sessions", { preHandler: requirePlatform("VIEW_PLATFORM") }, async (request, reply) => {
    const q = parse(listSupportSchema, request.query, reply);
    return q ? listSupportSessions(app.db, q, request.platformUser!.id) : reply;
  });

  app.post<{ Params: { id: string } }>("/platform/tenants/:id/support-sessions", { preHandler: [requirePlatform("START_SUPPORT_SESSION"), platformRateLimit("support")] }, async (request, reply) => {
    const body = parse(startSupportSchema, request.body, reply);
    if (!body) return reply;
    const r = await startSupportSession(app.db, request.params.id, body, supportActor(request));
    if (!r.ok) return refuse(reply, r);
    // httpOnly, and only ever honoured together with this same staff member's live platform session.
    reply.setCookie(SUPPORT_COOKIE, r.session.id, { ...sessionCookieBase(), expires: new Date(r.session.expiresAt) });
    return reply.status(201).send({ session: r.session });
  });

  app.post<{ Params: { id: string } }>("/platform/support-sessions/:id/enable-edits", { preHandler: [requirePlatform("ENABLE_SUPPORT_EDITS"), platformRateLimit("support")] }, async (request, reply) => {
    const body = parse(enableEditsSchema, request.body, reply);
    if (!body) return reply;
    const r = await enableSupportEdits(app.db, request.params.id, body, supportActor(request));
    return r.ok ? { session: r.session } : refuse(reply, r);
  });

  for (const mode of ["end", "disable-edits"] as const) {
    app.post<{ Params: { id: string } }>(`/platform/support-sessions/:id/${mode}`, { preHandler: requirePlatform("START_SUPPORT_SESSION") }, async (request, reply) => {
      const r = await endSupportSession(app.db, request.params.id, mode, supportActor(request));
      if (!r.ok) return refuse(reply, r);
      if (mode === "end") {
        const { path, sameSite, secure } = sessionCookieBase();
        reply.clearCookie(SUPPORT_COOKIE, { path, sameSite, secure });
      }
      return { ok: true };
    });
  }
}
