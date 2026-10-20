import "fastify";
import type { Db } from "../db/client.js";
import type { PlatformSessionUser, SessionUser } from "@pulseos/types";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
  interface FastifyRequest {
    sessionUser: SessionUser | null;
    /** Platform Console staff (separate cookie, separate identity space). Null on every tenant request. */
    platformUser: (PlatformSessionUser & { sessionId: string }) | null;
    /** Set only in Support Mode: the platform staff member behind this tenant request, and their support session. */
    supportContext: import("../domain/platform/support.service.js").SupportContext | null;
  }
}
