import { hospitalIsActive } from "../tenant/hospital-lifecycle.policy.js";
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { PLATFORM_ONBOARDING_GRANTS, type PlatformAccount, type PlatformPermission, type PlatformRole } from "@pulseos/types";
import type { Db, Tx } from "../../db/client.js";
import { platformAccounts as accounts, platformEnrollments as enrollments, platformMfaRecoveries as recoveries, platformSecurityAudit, platformSessions as sessions } from "../../db/platform-schema.js";
import { hashPassword, verifyPassword } from "../auth/auth.service.js";
import { digest, opaqueTokenShape } from "../tenant/hospital-onboarding.service.js";
import { newMfaSecret, verifyMfa } from "./platform-mfa.js";

export const SUPER = "PLATFORM_SUPER_ADMIN";
export const OPS = "PLATFORM_OPERATIONS_ADMIN";
export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 8 * 60 * 60_000;
export const ENROLLMENT_MS = 10 * 60_000;
const SETUP_MS = 24 * 60 * 60_000;
const RECOVERY_MS = 30 * 60_000;

type Account = typeof accounts.$inferSelect;
const token = () => randomBytes(32).toString("base64url");
const readPermissions = ["hospital:read", "dashboard:read", "hospital:lifecycle:read"] as const;
export const operatorPermissions: readonly PlatformPermission[] = ["hospital:read", ...PLATFORM_ONBOARDING_GRANTS];

export function accountView(row: Account): PlatformAccount {
  const permissions: PlatformPermission[] = row.role === SUPER
    ? [...readPermissions, ...PLATFORM_ONBOARDING_GRANTS, "team:manage", "audit:read", "hospital:suspend", "hospital:restore"]
    : [...readPermissions, ...PLATFORM_ONBOARDING_GRANTS.filter((grant) => row.permissions.includes(grant))];
  return { id: row.id, email: row.email, role: row.role, permissions };
}

export async function securityAudit(db: Db | Tx, action: string, actorId?: string, subjectId?: string) {
  await db.insert(platformSecurityAudit).values({ action, actorId, subjectId });
}

async function issueSession(tx: Tx, accountId: string) {
  const value = token();
  await tx.insert(sessions).values({ tokenHash: digest(value), accountId, expiresAt: new Date(Date.now() + ABSOLUTE_MS) });
  await securityAudit(tx, "login_succeeded", accountId);
  return value;
}

export async function browserAccount(db: Db, value: string | undefined) {
  if (!value || !opaqueTokenShape.test(value)) return null;
  return db.transaction(async (tx) => {
    const tokenHash = digest(value);
    const now = new Date();
    const [updated] = await tx.update(sessions).set({ lastSeenAt: now }).where(and(
      eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now),
      gt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS)),
    )).returning({ accountId: sessions.accountId });
    if (!updated) return null;
    const [account] = await tx.select().from(accounts).where(and(
      eq(accounts.id, updated.accountId), isNull(accounts.disabledAt), isNotNull(accounts.mfaSecret),
    ));
    return account ? accountView(account) : null;
  });
}

export async function logoutPlatform(db: Db, value: string, actorId: string) {
  await db.transaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, digest(value)));
    await securityAudit(tx, "logout", actorId);
  });
}

let decoyHash: Promise<string> | undefined;

export async function loginPlatform(db: Db, key: Buffer, email: string, password: string, code: string) {
  const [candidate] = await db.select().from(accounts).where(eq(accounts.email, email));
  const hash = candidate?.passwordHash ?? await (decoyHash ??= hashPassword(token()));
  if (!(await verifyPassword(hash, password)) || !candidate?.mfaSecret || candidate.disabledAt) {
    await securityAudit(db, "login_failed", undefined, candidate?.id);
    return null;
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, candidate.id)).for("update");
    const step = row?.mfaSecret && !row.disabledAt && row.passwordHash === hash
      ? verifyMfa(key, row.mfaSecret, code, row.lastMfaStep) : null;
    if (step === null) {
      await securityAudit(tx, "login_failed", undefined, candidate.id);
      return null;
    }
    await tx.update(accounts).set({ lastMfaStep: step }).where(eq(accounts.id, candidate.id));
    return issueSession(tx, candidate.id);
  });
}

export async function beginEnrollment(db: Db, key: Buffer, invitation: string, password: string) {
  const setupHash = digest(invitation);
  const [candidate] = await db.select({ id: accounts.id, email: accounts.email, passwordHash: accounts.passwordHash }).from(accounts).where(and(
    eq(accounts.setupHash, setupHash), gt(accounts.setupExpiresAt, new Date()), isNull(accounts.disabledAt),
  ));
  if (!candidate || candidate.email === password.toLowerCase()) {
    await securityAudit(db, "enrollment_failed", undefined, candidate?.id);
    return null;
  }
  if (candidate.passwordHash && !(await verifyPassword(candidate.passwordHash, password))) {
    await securityAudit(db, "mfa_recovery_enrollment_denied", undefined, candidate.id);
    return null;
  }
  const passwordHash = candidate.passwordHash ?? await hashPassword(password);
  return db.transaction(async (tx) => {
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, candidate.id)).for("update");
    if (!account || account.disabledAt || account.setupHash !== setupHash ||
      !account.setupExpiresAt || account.setupExpiresAt.getTime() <= Date.now()) return null;
    if (account.passwordHash !== candidate.passwordHash) return null;
    if (account.passwordHash) {
      const [used] = await tx.update(recoveries).set({ consumedAt: new Date() }).where(and(
        eq(recoveries.accountId, account.id), eq(recoveries.status, "approved"),
        gt(recoveries.expiresAt, new Date()), isNull(recoveries.consumedAt),
      )).returning({ id: recoveries.accountId });
      if (!used) {
        await securityAudit(tx, "mfa_recovery_enrollment_denied", undefined, account.id);
        return null;
      }
    }
    const { setupKey, encrypted } = newMfaSecret(key);
    const value = token();
    const data = { tokenHash: digest(value), passwordHash, mfaSecret: encrypted, expiresAt: new Date(Date.now() + ENROLLMENT_MS), attempts: 0 };
    await tx.insert(enrollments).values({ accountId: account.id, ...data })
      .onConflictDoUpdate({ target: enrollments.accountId, set: data });
    await securityAudit(tx, account.passwordHash ? "mfa_recovery_enrollment_started" : "enrollment_started", undefined, account.id);
    return { value, setupKey, email: account.email };
  });
}

export async function completeEnrollment(db: Db, key: Buffer, value: string, code: string) {
  const tokenHash = digest(value);
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ accountId: enrollments.accountId }).from(enrollments).where(eq(enrollments.tokenHash, tokenHash));
    if (!candidate) return null;
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, candidate.accountId)).for("update");
    const [challenge] = await tx.select().from(enrollments).where(eq(enrollments.tokenHash, tokenHash));
    if (!account || !challenge || account.disabledAt || account.mfaSecret || !account.setupHash ||
      !account.setupExpiresAt || account.setupExpiresAt.getTime() <= Date.now() ||
      challenge.attempts >= 5 || challenge.expiresAt.getTime() <= Date.now()) return null;
    const step = verifyMfa(key, challenge.mfaSecret, code, null);
    if (step === null) {
      await tx.update(enrollments).set({ attempts: challenge.attempts + 1 }).where(eq(enrollments.tokenHash, tokenHash));
      await securityAudit(tx, account.passwordHash ? "mfa_recovery_enrollment_denied" : "enrollment_failed", undefined, account.id);
      return null;
    }
    if (account.passwordHash) {
      if (challenge.passwordHash !== account.passwordHash) {
        await securityAudit(tx, "mfa_recovery_enrollment_denied", undefined, account.id);
        return null;
      }
      const [completed] = await tx.update(recoveries).set({ status: "completed" }).where(and(
        eq(recoveries.accountId, account.id), eq(recoveries.status, "approved"), gt(recoveries.expiresAt, new Date()),
        isNotNull(recoveries.consumedAt),
      )).returning({ id: recoveries.accountId });
      if (!completed) {
        await securityAudit(tx, "mfa_recovery_enrollment_denied", undefined, account.id);
        return null;
      }
      await securityAudit(tx, "mfa_recovery_completed", account.id, account.id);
    }
    await tx.update(accounts).set({
      passwordHash: challenge.passwordHash, mfaSecret: challenge.mfaSecret, lastMfaStep: step,
      setupHash: null, setupExpiresAt: null,
    }).where(eq(accounts.id, account.id));
    await tx.delete(enrollments).where(eq(enrollments.tokenHash, tokenHash));
    await securityAudit(tx, "mfa_enrolled", account.id);
    return issueSession(tx, account.id);
  });
}

async function teamLock(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pulseos-platform-team'))`);
}

async function invite(tx: Tx, email: string, role: PlatformRole, permissions: PlatformPermission[], actorId?: string) {
  const value = token();
  const expiresAt = new Date(Date.now() + SETUP_MS);
  const [row] = await tx.insert(accounts).values({ email, role, permissions, setupHash: digest(value), setupExpiresAt: expiresAt })
    .onConflictDoNothing({ target: accounts.email }).returning({ id: accounts.id });
  if (!row) return null;
  await securityAudit(tx, actorId ? "administrator_invited" : "super_admin_bootstrapped", actorId, row.id);
  return { id: row.id, setupToken: value, expiresAt };
}

export async function bootstrapPlatform(db: Db, email: string, renewPending = false) {
  return db.transaction(async (tx) => {
    await teamLock(tx);
    const [same] = await tx.select().from(accounts).where(eq(accounts.email, email)).for("update");
    if (renewPending) {
      if (!same || same.role !== SUPER || same.disabledAt || same.mfaSecret || same.passwordHash) return { state: "refused" } as const;
      const [other] = await tx.select({ id: accounts.id }).from(accounts).where(ne(accounts.id, same.id)).limit(1);
      if (other) return { state: "refused" } as const;
      const setupToken = token();
      const expiresAt = new Date(Date.now() + SETUP_MS);
      await tx.update(accounts).set({ setupHash: digest(setupToken), setupExpiresAt: expiresAt }).where(eq(accounts.id, same.id));
      await tx.delete(enrollments).where(eq(enrollments.accountId, same.id));
      await securityAudit(tx, "bootstrap_setup_reissued", undefined, same.id);
      return { state: "renewed", id: same.id, setupToken, expiresAt } as const;
    }
    if (same?.role === SUPER) return { state: "already_configured" } as const;
    const [existing] = await tx.select({ id: accounts.id }).from(accounts).limit(1);
    if (existing) return { state: "refused" } as const;
    const invitation = (await invite(tx, email, SUPER, []))!;
    return { state: "created", ...invitation } as const;
  });
}

async function activeSuperAdmin(tx: Tx, id: string) {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(and(
    eq(accounts.id, id), eq(accounts.role, SUPER), isNull(accounts.disabledAt), isNotNull(accounts.mfaSecret),
  ));
  return Boolean(row);
}

export async function invitePlatformAccount(db: Db, actorId: string, email: string, role: PlatformRole, permissions: PlatformPermission[]) {
  return db.transaction(async (tx) => {
    await teamLock(tx);
    if (!(await activeSuperAdmin(tx, actorId))) return { error: "forbidden" } as const;
    const invitation = await invite(tx, email, role, permissions, actorId);
    return invitation ?? { error: "email_in_use" } as const;
  });
}

export async function changePlatformAccount(db: Db, actorId: string, id: string, changes: {
  role: PlatformRole; permissions: PlatformPermission[]; disabled: boolean; reissue?: boolean | undefined;
}) {
  return db.transaction(async (tx) => {
    await teamLock(tx);
    if (!(await activeSuperAdmin(tx, actorId))) return { error: "forbidden" } as const;
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update");
    if (!row) return { error: "not_found" } as const;
    if (row.role === SUPER && row.mfaSecret && !row.disabledAt && (changes.role !== SUPER || changes.disabled)) {
      const [other] = await tx.select({ id: accounts.id }).from(accounts).where(and(
        ne(accounts.id, id), eq(accounts.role, SUPER), isNull(accounts.disabledAt), isNotNull(accounts.mfaSecret),
      )).limit(1);
      if (!other) {
        await securityAudit(tx, "last_super_admin_change_denied", actorId, id);
        return { error: "last_super_admin" } as const;
      }
    }
    if (changes.reissue && (row.mfaSecret || row.passwordHash || changes.disabled)) return { error: "setup_unavailable" } as const;
    if (changes.disabled || changes.role !== row.role ||
      [...changes.permissions].sort().join(",") !== [...row.permissions].sort().join(",")) {
      const [invalidated] = await tx.update(recoveries).set({ status: "rejected" }).where(and(
        eq(recoveries.accountId, id), inArray(recoveries.status, ["pending", "approved"]),
      )).returning({ id: recoveries.accountId });
      if (invalidated) {
        await tx.update(accounts).set({ setupHash: null, setupExpiresAt: null }).where(eq(accounts.id, id));
        await tx.delete(enrollments).where(eq(enrollments.accountId, id));
        await securityAudit(tx, "mfa_recovery_invalidated", actorId, id);
      }
    }
    const setupToken = changes.reissue ? token() : null;
    const expiresAt = setupToken ? new Date(Date.now() + SETUP_MS) : null;
    await tx.update(accounts).set({
      role: changes.role,
      permissions: changes.permissions,
      disabledAt: changes.disabled ? row.disabledAt ?? new Date() : null,
      ...(setupToken ? { setupHash: digest(setupToken), setupExpiresAt: expiresAt } : {}),
    }).where(eq(accounts.id, id));
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.accountId, id), isNull(sessions.revokedAt)));
    if (changes.disabled || setupToken) await tx.delete(enrollments).where(eq(enrollments.accountId, id));
    await securityAudit(tx, setupToken ? "administrator_setup_reissued" : "administrator_changed", actorId, id);
    return setupToken ? { updated: true, setupToken, expiresAt } : { updated: true };
  });
}

async function approveRecovery(tx: Tx, id: string, actorId?: string, operatorCase?: string, requestedBy?: string) {
  const recoveryToken = token();
  const expiresAt = new Date(Date.now() + RECOVERY_MS);
  const record = { status: "approved" as const, expiresAt, consumedAt: null,
    operatorCase: operatorCase ?? null, requestedBy: requestedBy ?? null };
  await tx.insert(recoveries).values({ accountId: id, ...record })
    .onConflictDoUpdate({ target: recoveries.accountId, set: record });
  await tx.update(accounts).set({
    mfaSecret: null, lastMfaStep: null, setupHash: digest(recoveryToken), setupExpiresAt: expiresAt,
  }).where(eq(accounts.id, id));
  await tx.delete(enrollments).where(eq(enrollments.accountId, id));
  await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.accountId, id), isNull(sessions.revokedAt)));
  await securityAudit(tx, operatorCase ? "last_admin_mfa_recovery_approved" : "mfa_recovery_approved", actorId, id);
  return { recoveryToken, expiresAt };
}

export async function managePlatformRecovery(db: Db, key: Buffer, actorId: string, id: string,
  action: "request" | "approve" | "reject", code?: string) {
  return db.transaction(async (tx) => {
    await teamLock(tx);
    const [actor] = await tx.select().from(accounts).where(eq(accounts.id, actorId)).for("update");
    const [target] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update");
    if (!target) return { error: "not_found" } as const;
    const deny = async (error: string) => {
      await securityAudit(tx, "mfa_recovery_denied", actorId, id);
      return { error };
    };
    if (!actor?.mfaSecret || actor.disabledAt || actor.role !== SUPER || id === actorId) return deny("forbidden");
    if (target.disabledAt || !target.passwordHash) return deny("recovery_unavailable");
    const [request] = await tx.select().from(recoveries).where(eq(recoveries.accountId, id));
    const open = request && +request.expiresAt > Date.now() && ["pending", "approved"].includes(request.status);
    if (action === "request") {
      if (open) return deny("recovery_in_progress");
      const record = { status: "pending" as const, expiresAt: new Date(Date.now() + RECOVERY_MS),
        consumedAt: null, operatorCase: null, requestedBy: actorId };
      await tx.insert(recoveries).values({ accountId: id, ...record })
        .onConflictDoUpdate({ target: recoveries.accountId, set: record });
      await securityAudit(tx, "mfa_recovery_requested", actorId, id);
      return { updated: true } as const;
    }
    if (!open || request.status !== "pending") return deny("recovery_unavailable");
    if (action === "reject") {
      await tx.update(recoveries).set({ status: "rejected" }).where(eq(recoveries.accountId, id));
      await securityAudit(tx, "mfa_recovery_rejected", actorId, id);
      return { updated: true } as const;
    }
    if (!request.requestedBy) return deny("recovery_unavailable");
    if (request.requestedBy === actorId) return deny("forbidden");
    const step = code && /^\d{6}$/.test(code) ? verifyMfa(key, actor.mfaSecret, code, actor.lastMfaStep) : null;
    if (step === null) return deny("authentication_failed");
    await tx.update(accounts).set({ lastMfaStep: step }).where(eq(accounts.id, actorId));
    return approveRecovery(tx, id, actorId, undefined, request.requestedBy);
  });
}

export async function authorizeLastPlatformAdminRecovery(db: Db, id: string, operatorCase: string) {
  if (!/^INC-[A-Za-z0-9-]{4,48}$/.test(operatorCase)) return null;
  return db.transaction(async (tx) => {
    await teamLock(tx);
    const [target] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update");
    if (!target?.passwordHash || target.disabledAt || target.role !== SUPER) return null;
    const [other] = await tx.select({ id: accounts.id }).from(accounts).where(and(
      ne(accounts.id, id), eq(accounts.role, SUPER), isNull(accounts.disabledAt), isNotNull(accounts.mfaSecret),
    )).limit(1);
    const [prior] = await tx.select().from(recoveries).where(eq(recoveries.accountId, id));
    if (other || (prior?.status === "approved" && +prior.expiresAt > Date.now())) {
      await securityAudit(tx, "last_admin_mfa_recovery_denied", undefined, id);
      return null;
    }
    return approveRecovery(tx, id, undefined, operatorCase);
  });
}
