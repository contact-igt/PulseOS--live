import type { FastifyReply, FastifyRequest } from "fastify";
import { capabilityEnabled, hasPermission, type Capability, type Permission } from "@pulseos/types";

export function requirePermission(permission: Permission) {
  return function permissionPreHandler(request: FastifyRequest, reply: FastifyReply, done: () => void) {
    const user = request.sessionUser;
    if (!user) {
      reply.status(401).send({ error: "unauthenticated" });
      return;
    }
    if (!hasPermission(user.role, permission)) {
      reply.status(403).send({ error: "forbidden", requiredPermission: permission });
      return;
    }
    done();
  };
}

/**
 * Capability gate. A tenant without a capability (its edition default plus the tenant's own switches) has no access to it
 * even by calling the API directly — hiding navigation is only a courtesy. 403 `feature_not_available` is distinct from a role-permission 403.
 */
export function requireCapability(capability: Capability) {
  return function capabilityPreHandler(request: FastifyRequest, reply: FastifyReply, done: () => void) {
    const user = request.sessionUser;
    if (!user) {
      reply.status(401).send({ error: "unauthenticated" });
      return;
    }
    if (!capabilityEnabled(user.capabilities, capability)) {
      reply.status(403).send({ error: "feature_not_available", capability, edition: user.edition });
      return;
    }
    done();
  };
}
