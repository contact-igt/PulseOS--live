import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import { accountTokens, platformSessions, platformUsers, sessions, tenants, users } from "../../db/schema.js";
import { hashPassword } from "../auth/auth.service.js";
import { emailProvider, webBaseUrl } from "./email.js";
import { getPlatformSettings } from "./platform-settings.service.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";

// Invitations and password resets. The token is 32 random bytes shown exactly once - inside the link sent to the person -
// and only its SHA-256 is stored, so neither the database nor any log can reproduce it. Tokens are single use, expire, and
// can be revoked; a new one for the same account and purpose replaces the old one.

export type TokenPurpose = "INVITE" | "PASSWORD_RESET";
type Account = { userId: string; platformUserId?: never } | { platformUserId: string; userId?: never };

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export interface IssuedToken {
  id: string;
  token: string;
  email: string;
  purpose: TokenPurpose;
  expiresAt: Date;
}

/** Create a fresh token for an account (replacing any pending one of the same purpose). Call inside the change's transaction. */
export async function issueAccountToken(tx: DbOrTx, input: Account & { purpose: TokenPurpose; tenantId: string | null; email: string; role: string; createdBy: string | null }): Promise<IssuedToken> {
  const settings = await getPlatformSettings(tx);
  const accountCond = input.userId ? eq(accountTokens.userId, input.userId) : eq(accountTokens.platformUserId, input.platformUserId!);
  await tx
    .update(accountTokens)
    .set({ status: "REVOKED", revokedAt: new Date() })
    .where(and(accountCond, eq(accountTokens.purpose, input.purpose), eq(accountTokens.status, "PENDING")));
  const { token, tokenHash } = newToken();
  const expiresAt = new Date(Date.now() + settings.invitationExpiryHours * 3600 * 1000);
  const [row] = await tx
    .insert(accountTokens)
    .values({ purpose: input.purpose, tokenHash, userId: input.userId ?? null, platformUserId: input.platformUserId ?? null, tenantId: input.tenantId, email: input.email, role: input.role, expiresAt, createdByPlatformUserId: input.createdBy })
    .returning({ id: accountTokens.id });
  return { id: row!.id, token, email: input.email, purpose: input.purpose, expiresAt };
}

/**
 * Send the link (after the transaction has committed) and record whether it went. The link carries the token in the URL
 * fragment, which browsers never send to any server, so it cannot land in a server or proxy log.
 */
export async function deliverAccountToken(db: Db, issued: IssuedToken, context: { name: string; workspace: string | null }): Promise<"SENT" | "NOT_DELIVERED"> {
  const settings = await getPlatformSettings(db);
  const link = `${webBaseUrl()}/account/set-password#token=${issued.token}`;
  const where = context.workspace ? ` for ${context.workspace}` : " for the PulseOS Platform Console";
  const subject = issued.purpose === "INVITE" ? `You're invited to PulseOS${where}` : `Reset your PulseOS password${where}`;
  const lines = [
    `Hello ${context.name},`,
    "",
    issued.purpose === "INVITE" ? `You have been invited to PulseOS${where}. Choose your password to get started:` : `A password reset was requested for your PulseOS account${where}. Choose a new password:`,
    link,
    "",
    `This link works once and expires ${issued.expiresAt.toUTCString()}.`,
    settings.supportContact ? `Questions? ${settings.supportContact}` : "",
  ];
  let delivered = false;
  try {
    delivered = (await emailProvider().send({ to: issued.email, subject, text: lines.join("\n"), kind: issued.purpose })).delivered;
  } catch {
    delivered = false;
  }
  const status = delivered ? "SENT" : "NOT_DELIVERED";
  await db.update(accountTokens).set({ deliveryStatus: status }).where(eq(accountTokens.id, issued.id));
  return status;
}

type LiveToken = typeof accountTokens.$inferSelect;

async function findLiveToken(db: DbOrTx, token: string): Promise<LiveToken | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .select()
    .from(accountTokens)
    .where(and(eq(accountTokens.tokenHash, hashToken(token)), eq(accountTokens.status, "PENDING"), gt(accountTokens.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export interface TokenInspection {
  purpose: TokenPurpose;
  email: string;
  name: string;
  workspace: string | null;
  /** Where to sign in once the password is set. */
  signInPath: string;
}

/** What the set-password page may show for a valid token. Invalid, used, revoked and expired all answer null alike. */
export async function inspectAccountToken(db: Db, token: string): Promise<TokenInspection | null> {
  const row = await findLiveToken(db, token);
  if (!row) return null;
  if (row.platformUserId) {
    const [p] = await db.select({ name: platformUsers.name }).from(platformUsers).where(eq(platformUsers.id, row.platformUserId)).limit(1);
    return { purpose: row.purpose, email: row.email, name: p?.name ?? "", workspace: null, signInPath: "/platform/login" };
  }
  const [u] = await db.select({ name: users.name, tenantName: tenants.name, slug: tenants.loginSlug }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId)).where(eq(users.id, row.userId!)).limit(1);
  return { purpose: row.purpose, email: row.email, name: u?.name ?? "", workspace: u?.tenantName ?? null, signInPath: u?.slug ? `/login/${u.slug}` : "/login" };
}

export type AcceptResult = { ok: true; signInPath: string } | { ok: false; reason: "invalid_token" | "workspace_unavailable" | "account_unavailable" };

/**
 * Use a token: set the account's password and activate it (invitation) or replace it (reset). Single use under a row lock,
 * so two tabs cannot both use one link. A reset also ends every open session of that account.
 */
export async function acceptAccountToken(db: Db, token: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<AcceptResult> {
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    if (!TOKEN_SHAPE.test(token)) return { ok: false as const, reason: "invalid_token" as const };
    const [row] = await tx
      .select()
      .from(accountTokens)
      .where(and(eq(accountTokens.tokenHash, hashToken(token)), eq(accountTokens.status, "PENDING"), gt(accountTokens.expiresAt, new Date())))
      .for("update")
      .limit(1);
    if (!row) return { ok: false as const, reason: "invalid_token" as const };
    const actor: AuditActor = { platformUserId: null, label: row.email, ip: meta.ip, userAgent: meta.userAgent };
    const now = new Date();
    let signInPath = "/login";

    if (row.platformUserId) {
      const [p] = await tx.select().from(platformUsers).where(eq(platformUsers.id, row.platformUserId)).for("update").limit(1);
      if (!p || p.status === "SUSPENDED") return { ok: false as const, reason: "account_unavailable" as const };
      await tx.update(platformUsers).set({ passwordHash, status: "ACTIVE", updatedAt: now, version: sql`${platformUsers.version} + 1` }).where(eq(platformUsers.id, p.id));
      signInPath = "/platform/login";
    } else {
      const [u] = await tx.select({ user: users, tenantStatus: tenants.status, slug: tenants.loginSlug }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId)).where(eq(users.id, row.userId!)).for("update").limit(1);
      if (!u || u.user.isSystem || u.user.status === "SUSPENDED" || u.user.status === "REMOVED") return { ok: false as const, reason: "account_unavailable" as const };
      // A suspended or archived hospital cannot be joined; a draft one can (the person signs in once it opens).
      if (u.tenantStatus === "SUSPENDED" || u.tenantStatus === "ARCHIVED") return { ok: false as const, reason: "workspace_unavailable" as const };
      await tx.update(users).set({ passwordHash, status: "ACTIVE", updatedAt: now, version: sql`${users.version} + 1` }).where(eq(users.id, u.user.id));
      if (row.purpose === "PASSWORD_RESET") await tx.delete(sessions).where(eq(sessions.userId, u.user.id));
      signInPath = u.slug ? `/login/${u.slug}` : "/login";
    }
    if (row.platformUserId && row.purpose === "PASSWORD_RESET") await tx.delete(platformSessions).where(eq(platformSessions.platformUserId, row.platformUserId));
    await tx.update(accountTokens).set({ status: "ACCEPTED", acceptedAt: now }).where(eq(accountTokens.id, row.id));
    await recordPlatformAudit(tx, actor, {
      action: row.purpose === "INVITE" ? "invitation.accepted" : "password_reset.completed",
      summary: row.purpose === "INVITE" ? `${row.email} accepted their invitation` : `${row.email} set a new password`,
      targetType: row.platformUserId ? "platform_user" : "user",
      targetId: row.platformUserId ?? row.userId,
      tenantId: row.tenantId,
      context: "SYSTEM",
    });
    return { ok: true as const, signInPath };
  });
}

/** Pending, unexpired invitations of a tenant account or platform account (for "Resend" and status). */
export async function pendingTokenFor(db: DbOrTx, account: Account, purpose: TokenPurpose) {
  const cond = account.userId ? eq(accountTokens.userId, account.userId) : eq(accountTokens.platformUserId, account.platformUserId!);
  const [row] = await db.select().from(accountTokens).where(and(cond, eq(accountTokens.purpose, purpose), eq(accountTokens.status, "PENDING"))).limit(1);
  return row ?? null;
}
