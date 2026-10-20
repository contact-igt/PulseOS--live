import { and, eq, sql } from "drizzle-orm";
import { PLATFORM_ROLE_PERMISSIONS, type PlatformSessionUser } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { platformSessions, platformUsers } from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/auth.service.js";

export const PLATFORM_SESSION_COOKIE = "pulseos_platform_session";
/** A console session lasts at most 12 hours, and ends after 2 idle hours. */
export const PLATFORM_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const PLATFORM_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** last_seen_at is refreshed at most this often, so a busy console is not one write per request. */
const SEEN_GRANULARITY_MS = 60 * 1000;

let decoyHash: Promise<string> | null = null;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type PlatformLoginResult =
  | { ok: true; sessionId: string; expiresAt: Date; user: PlatformSessionUser }
  | { ok: false; reason: "invalid_credentials"; platformUserId: string | null };

function toSessionUser(u: typeof platformUsers.$inferSelect): PlatformSessionUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role, permissions: PLATFORM_ROLE_PERMISSIONS[u.role] };
}

/**
 * Platform sign-in. Only an ACTIVE platform account with a password can sign in; an unknown email, a suspended or invited
 * account and a wrong password all cost one password check and answer identically, so nobody can probe who is staff.
 */
export async function loginPlatform(db: Db, email: string, password: string, meta: RequestMeta): Promise<PlatformLoginResult> {
  const [user] = await db.select().from(platformUsers).where(sql`lower(${platformUsers.email}) = lower(${email})`).limit(1);
  if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
    decoyHash ??= hashPassword("decoy-password-never-matches");
    await verifyPassword(user?.passwordHash ?? (await decoyHash), password);
    return { ok: false, reason: "invalid_credentials", platformUserId: user?.id ?? null };
  }
  if (!(await verifyPassword(user.passwordHash, password))) return { ok: false, reason: "invalid_credentials", platformUserId: user.id };

  const now = new Date();
  const [session] = await db
    .insert(platformSessions)
    .values({ platformUserId: user.id, expiresAt: new Date(now.getTime() + PLATFORM_SESSION_TTL_MS), lastSeenAt: now, ipAddress: meta.ip, userAgent: meta.userAgent })
    .returning();
  await db.update(platformUsers).set({ lastSignInAt: now }).where(eq(platformUsers.id, user.id));
  return { ok: true, sessionId: session!.id, expiresAt: session!.expiresAt, user: toSessionUser(user) };
}

/** The signed-in platform staff member, or null. Suspension, expiry and idle time are checked on every request. */
export async function resolvePlatformSession(db: Db, sessionId: string): Promise<(PlatformSessionUser & { sessionId: string }) | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const [row] = await db
    .select({ session: platformSessions, user: platformUsers })
    .from(platformSessions)
    .innerJoin(platformUsers, eq(platformUsers.id, platformSessions.platformUserId))
    .where(and(eq(platformSessions.id, sessionId), eq(platformUsers.status, "ACTIVE")))
    .limit(1);
  if (!row) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() < now) return null;
  const seen = (row.session.lastSeenAt ?? row.session.createdAt).getTime();
  if (now - seen > PLATFORM_IDLE_TIMEOUT_MS) return null;
  if (now - seen > SEEN_GRANULARITY_MS) await db.update(platformSessions).set({ lastSeenAt: new Date(now) }).where(eq(platformSessions.id, sessionId));
  return { ...toSessionUser(row.user), sessionId };
}

export async function revokePlatformSession(db: Db, sessionId: string): Promise<void> {
  if (!SESSION_ID.test(sessionId)) return;
  await db.delete(platformSessions).where(eq(platformSessions.id, sessionId));
}
