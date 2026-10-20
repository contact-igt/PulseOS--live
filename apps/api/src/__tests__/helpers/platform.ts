import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PlatformRole } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { platformUsers } from "../../db/schema.js";
import { hashPassword } from "../../domain/auth/auth.service.js";

export const PLATFORM_COOKIE = "pulseos_platform_session";

export interface TestPlatformUser {
  id: string;
  email: string;
  role: PlatformRole;
  cookie: string;
}

/** A throwaway ACTIVE platform staff member, signed in. Unique email per call so tests never collide. */
export async function createPlatformUser(db: Db, app: FastifyInstance, role: PlatformRole, password: string, opts: { status?: "ACTIVE" | "SUSPENDED" | "INVITED"; signIn?: boolean } = {}): Promise<TestPlatformUser> {
  const tag = randomUUID().slice(0, 8);
  const email = `${role.toLowerCase().replace(/_/g, "-")}.${tag}@platform-test.local`;
  const [u] = await db
    .insert(platformUsers)
    .values({ name: `${role} ${tag}`, email, role, status: "ACTIVE", passwordHash: await hashPassword(password) })
    .returning({ id: platformUsers.id });
  let cookie = "";
  if (opts.signIn !== false) {
    const res = await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email, password } });
    if (res.statusCode !== 200) throw new Error(`platform login failed for ${role}: ${res.statusCode} ${res.body}`);
    cookie = res.cookies.find((c) => c.name === PLATFORM_COOKIE)!.value;
  }
  if (opts.status && opts.status !== "ACTIVE") {
    const { eq } = await import("drizzle-orm");
    await db.update(platformUsers).set({ status: opts.status }).where(eq(platformUsers.id, u!.id));
  }
  return { id: u!.id, email, role, cookie };
}

export const asPlatform = (cookie: string) => ({ [PLATFORM_COOKIE]: cookie });
