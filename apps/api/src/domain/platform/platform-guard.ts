import type { FastifyReply, FastifyRequest } from "fastify";
import { hasPlatformPermission, type PlatformPermission } from "@pulseos/types";
import { actorFromRequest, recordPlatformAudit } from "./audit.service.js";

/**
 * Every platform route names the permission it needs. No platform session: 401. A session without the permission: 403,
 * and the refusal is written to the platform audit trail (a security event), never silently dropped.
 */
export function requirePlatform(permission: PlatformPermission) {
  return async function platformPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const user = request.platformUser;
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    if (!hasPlatformPermission(user.role, permission)) {
      await recordPlatformAudit(request.server.db, actorFromRequest(request), {
        action: "platform.permission_denied",
        outcome: "DENIED",
        summary: `${user.role} was refused ${request.method} ${request.routeOptions.url ?? "route"} (needs ${permission})`,
        metadata: { method: request.method, route: request.routeOptions.url ?? null, permission },
      });
      return reply.status(403).send({ error: "forbidden", requiredPermission: permission });
    }
  };
}

/** Public platform paths (everything else under /platform needs a platform session, even a path that does not exist). */
export const PUBLIC_PLATFORM_PATHS = new Set(["/platform/auth/login", "/platform/auth/logout"]);
