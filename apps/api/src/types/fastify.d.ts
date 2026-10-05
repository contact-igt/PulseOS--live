import "fastify";
import type { Db } from "../db/client.js";
import type { SessionUser } from "@pulseos/types";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
  interface FastifyRequest {
    sessionUser: SessionUser | null;
  }
}
