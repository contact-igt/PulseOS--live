import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.js";
import {
  branches, hospitalInvitationDeliveries as deliveries, hospitalOnboardings as onboardings, platformAuditLog, platformIdentities,
  tenantLoginConfigs, tenantProfiles, tenants, users,
} from "../../db/schema.js";
import { hashPassword } from "../auth/auth.service.js";
import { installDepartmentTemplate } from "../specialty/department.service.js";
import { hospitalTemplateKey, provisionHospital, type HospitalProvisioningInput } from "./hospital-provisioning.service.js";
import type { PlatformActor } from "../platform/platform-access.js";
import { encryptSecret } from "../security/encryption.js";
import { invitationCooldownMs, invitationEmailEnabled } from "./hospital-invitation-delivery.service.js";

type Onboarding = typeof onboardings.$inferSelect;
const INVITATION_TTL = 24 * 60 * 60 * 1000;
export const HOSPITAL_ONBOARDING_ROLE = "HOSPITAL_ONBOARDING_ADMIN";
export const opaqueTokenShape = /^[A-Za-z0-9_-]{43}$/;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function authorizeHospitalOperator(db: Db, header: string | undefined) {
  const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) return null;
  const [actor] = await db.select({ id: platformIdentities.id }).from(platformIdentities).where(and(
    eq(platformIdentities.credentialHash, digest(token)),
    eq(platformIdentities.role, HOSPITAL_ONBOARDING_ROLE),
    isNull(platformIdentities.revokedAt),
    gt(platformIdentities.expiresAt, new Date()),
  ));
  return actor ?? null;
}

async function audit(tx: Tx, onboardingId: string, actor: PlatformActor | null, action: string, reason?: string) {
  await tx.insert(platformAuditLog).values({
    onboardingId,
    actorId: actor?.kind === "operator" ? actor.id : null,
    browserActorId: actor?.kind === "browser" ? actor.id : null,
    action, reason: reason ?? null,
  });
}

async function locked(tx: Tx, id: string) {
  const [row] = await tx.select().from(onboardings).where(eq(onboardings.id, id)).for("update");
  return row;
}

async function update(tx: Tx, id: string, changes: Partial<Onboarding>) {
  const [row] = await tx.update(onboardings).set(changes).where(eq(onboardings.id, id)).returning();
  return row!;
}

async function status(db: Db | Tx, row: Onboarding) {
  const [delivery] = await db.select({
    status: deliveries.status, attempts: deliveries.attempts, lastAttemptAt: deliveries.lastAttemptAt, failure: deliveries.failure,
  }).from(deliveries).where(eq(deliveries.onboardingId, row.id));
  const [tenant] = row.tenantId && row.adminId ? await db.select({
    loginSlug: tenants.loginSlug,
    name: tenants.name,
    edition: tenants.edition,
    createdAt: tenants.createdAt,
    active: tenants.loginEnabled,
    lifecycleStatus: tenants.lifecycleStatus,
    branchId: branches.id,
    profileId: tenantProfiles.tenantId,
    brandingId: tenantLoginConfigs.tenantId,
  }).from(tenants)
    .leftJoin(users, and(eq(users.id, row.adminId), eq(users.tenantId, tenants.id), eq(users.role, "SUPER_ADMIN")))
    .leftJoin(branches, and(eq(branches.id, users.branchId), eq(branches.tenantId, tenants.id)))
    .leftJoin(tenantProfiles, eq(tenantProfiles.tenantId, tenants.id))
    .leftJoin(tenantLoginConfigs, eq(tenantLoginConfigs.tenantId, tenants.id))
    .where(eq(tenants.id, row.tenantId)) : [];
  const invitation = row.invitationRedeemedAt ? "accepted" : !row.invitationExpiresAt ? "not_issued"
    : row.invitationExpiresAt.getTime() > Date.now() ? "pending" : "expired";
  const readinessFailures = [
    ...(!tenant?.loginSlug ? ["login_slug_required"] : []),
    ...(!tenant?.branchId ? ["administrator_branch_required"] : []),
    ...(!tenant?.profileId ? ["profile_required"] : []),
    ...(!tenant?.brandingId ? ["branding_required"] : []),
    ...(!row.invitationRedeemedAt ? ["invitation_acceptance_required"] : []),
    ...(row.templateStatus !== "none" && row.templateStatus !== "installed" ? ["template_installation_required"] : []),
  ];
  return {
    id: row.id,
    onboardingId: row.id,
    tenantId: row.tenantId,
    name: tenant?.name ?? null,
    slug: tenant?.loginSlug ?? null,
    edition: tenant?.edition ?? null,
    createdAt: tenant?.createdAt ?? null,
    loginPath: tenant?.loginSlug ? `/login/${tenant.loginSlug}` : null,
    provisioning: row.tenantId ? "created" : "failed",
    provisioningError: row.provisioningError,
    template: row.templateStatus,
    invitation,
    invitationDelivery: { enabled: invitationEmailEnabled(), expiresAt: row.invitationExpiresAt, ...delivery,
      status: delivery?.status ?? "not_queued" },
    ready: readinessFailures.length === 0,
    readinessFailures,
    active: tenant?.active ?? false,
    lifecycleStatus: tenant?.lifecycleStatus ?? "PROVISIONING",
  };
}

export async function onboardingStatus(db: Db, id: string) {
  return db.transaction(async (tx) => {
    const row = await locked(tx, id);
    return row ? status(tx, row) : null;
  });
}

async function installTemplate(tx: Tx, row: Onboarding, actor: PlatformActor) {
  if (!row.tenantId || !row.templateKey || row.templateStatus === "installed") return row;
  const { tenantId, templateKey } = row;
  let failure: string | null = null;
  try {
    // Roll back all catalog writes on failure while preserving the hospital and failure audit.
    await tx.transaction(async (savepoint) => {
      const result = await installDepartmentTemplate(savepoint, tenantId, templateKey);
      if (!result.ok) throw new Error("template_install_failed");
    });
  } catch {
    failure = "template_install_failed";
  }
  await audit(tx, row.id, actor, failure ? "template_failed" : "template_installed", failure ?? undefined);
  return update(tx, row.id, { templateStatus: failure ? "failed" : "installed" });
}

export async function createHospital(db: Db, id: string, actor: PlatformActor, input: HospitalProvisioningInput) {
  const requestHash = digest(JSON.stringify(input));
  const creation = await db.transaction(async (tx) => {
    await tx.insert(onboardings).values({ id, requestHash }).onConflictDoNothing();
    let row = (await locked(tx, id))!;
    if (row.requestHash !== requestHash) return { error: "idempotency_conflict" } as const;
    if (row.tenantId) return { created: false } as const;

    const result = await provisionHospital(tx, input).catch(() => ({ ok: false, reason: "provisioning_failed" } as const));
    if (!result.ok) {
      await audit(tx, id, actor, "provisioning_failed", result.reason);
      row = await update(tx, id, { provisioningError: result.reason });
      return { error: result.reason, hospital: await status(tx, row) } as const;
    }

    const templateKey = hospitalTemplateKey(input);
    const provisioned = await update(tx, id, {
      tenantId: result.tenantId,
      adminId: result.userId,
      provisioningError: null,
      templateKey,
      templateStatus: templateKey ? "pending" : "none",
    });
    await audit(tx, id, actor, "hospital_created");
    if (invitationEmailEnabled()) {
      const owner = await invitationOwner(tx, provisioned);
      if (owner && process.env.CONNECTOR_ENCRYPTION_KEY) await mintInvitation(tx, provisioned, actor, owner.email, true);
    }
    return { created: true } as const;
  });
  if (creation.error) return creation;

  // The hospital and its idempotency record are durable before template work.
  // A repeat create resumes a pending install after interruption. Failed installs require an explicit retry.
  return db.transaction(async (tx) => {
    const row = (await locked(tx, id))!;
    const completed = row.templateStatus === "pending" ? await installTemplate(tx, row, actor) : row;
    return { hospital: await status(tx, completed), created: creation.created } as const;
  });
}

export async function retryHospitalTemplate(db: Db, id: string, actor: PlatformActor) {
  return db.transaction(async (tx) => {
    const row = await locked(tx, id);
    if (!row) return { error: "not_found" } as const;
    if (!row.tenantId) return { error: "provisioning_incomplete" } as const;
    return { hospital: await status(tx, await installTemplate(tx, row, actor)) };
  });
}

async function invitationOwner(tx: Tx, row: Onboarding) {
  if (!row.tenantId || !row.adminId || row.invitationRedeemedAt) return null;
  const [owner] = await tx.select({ email: users.email, active: tenants.loginEnabled })
    .from(users).innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.id, row.adminId), eq(users.tenantId, row.tenantId), eq(users.role, "SUPER_ADMIN"),
      eq(tenants.lifecycleStatus, "PROVISIONING"))).for("share");
  return owner && !owner.active ? owner : null;
}

async function mintInvitation(tx: Tx, row: Onboarding, actor: PlatformActor, recipient: string, queue: boolean) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL);
  await update(tx, row.id, { invitationHash: digest(token), invitationExpiresAt: expiresAt });
  await audit(tx, row.id, actor, row.invitationHash ? "invitation_reissued" : "invitation_issued");
  if (queue) {
    const fields = { messageId: randomUUID(), encryptedToken: encryptSecret({ token, recipient }), status: "pending" as const,
      attempts: 0, lastAttemptAt: null, nextAttemptAt: new Date(), failure: null };
    await tx.insert(deliveries).values({ onboardingId: row.id, ...fields })
      .onConflictDoUpdate({ target: deliveries.onboardingId, set: fields });
  } else {
    await tx.update(deliveries).set({ encryptedToken: null, status: "superseded" }).where(eq(deliveries.onboardingId, row.id));
  }
  return { invitationPath: `/hospital-invitation#${token}`, expiresAt, recipient };
}

function inviteCoolingDown(row: Onboarding) {
  return row.invitationExpiresAt && +row.invitationExpiresAt - INVITATION_TTL + invitationCooldownMs > Date.now();
}

export async function issueHospitalInvitation(db: Db, id: string, actor: PlatformActor) {
  return db.transaction(async (tx) => {
    const row = await locked(tx, id);
    if (!row) return { error: "not_found" } as const;
    const owner = await invitationOwner(tx, row);
    if (!owner) return { error: "invitation_unavailable" } as const;
    if (inviteCoolingDown(row)) {
      await audit(tx, id, actor, "invitation_issue_denied", "invitation_cooldown");
      return { error: "invitation_cooldown" } as const;
    }
    return mintInvitation(tx, row, actor, owner.email, false);
  });
}

export async function resendHospitalInvitation(db: Db, id: string, actor: PlatformActor, requestId: string, permitted: boolean) {
  return db.transaction(async (tx) => {
    const row = await locked(tx, id);
    if (!row) return { error: "not_found" } as const;
    const reject = async (error: string) => {
      await audit(tx, id, actor, "invitation_resend_denied", error);
      return { error };
    };
    if (!permitted) return reject("forbidden");
    const [prior] = await tx.select({ id: platformAuditLog.id }).from(platformAuditLog).where(and(
      eq(platformAuditLog.onboardingId, id), eq(platformAuditLog.action, "invitation_resend_queued"), eq(platformAuditLog.reason, requestId),
    )).limit(1);
    if (prior) {
      await audit(tx, id, actor, "invitation_resend_replayed", requestId);
      return { queued: true } as const;
    }
    if (!invitationEmailEnabled() || !process.env.CONNECTOR_ENCRYPTION_KEY) return reject("mail_not_configured");
    const owner = await invitationOwner(tx, row);
    if (!owner) return reject("invitation_unavailable");
    if (inviteCoolingDown(row)) return reject("invitation_cooldown");
    await mintInvitation(tx, row, actor, owner.email, true);
    await audit(tx, id, actor, "invitation_resend_queued", requestId);
    return { queued: true } as const;
  });
}

export async function redeemHospitalInvitation(db: Db, token: string, password: string) {
  const invitationHash = digest(token);
  // Lock and recheck at redemption. Reissue, concurrent acceptance, and activation serialize on this row.
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(onboardings).where(eq(onboardings.invitationHash, invitationHash)).for("update");
    if (!row?.tenantId || !row.adminId || row.invitationRedeemedAt || !row.invitationExpiresAt) return false;
    const reject = async (reason: string) => {
      await audit(tx, row.id, null, "invitation_redemption_failed", reason);
      return false;
    };
    if (row.invitationExpiresAt.getTime() <= Date.now()) return false;
    const [owner] = await tx.select({ email: users.email }).from(users)
      .where(and(eq(users.id, row.adminId), eq(users.tenantId, row.tenantId), eq(users.role, "SUPER_ADMIN")))
      .for("update");
    if (!owner) return reject("owner_unavailable");
    if (password.toLowerCase() === owner.email.toLowerCase()) return false;
    const passwordHash = await hashPassword(password);
    if (row.invitationExpiresAt.getTime() <= Date.now()) return reject("invitation_expired");
    await tx.update(users).set({ passwordHash }).where(and(eq(users.id, row.adminId), eq(users.tenantId, row.tenantId)));
    await update(tx, row.id, { invitationHash: null, invitationRedeemedAt: new Date() });
    await tx.update(deliveries).set({ encryptedToken: null, status: "superseded" }).where(and(
      eq(deliveries.onboardingId, row.id), eq(deliveries.status, "pending"),
    ));
    await audit(tx, row.id, null, "invitation_redeemed");
    return true;
  });
}

export async function activateHospital(db: Db, id: string, actor: PlatformActor) {
  return db.transaction(async (tx) => {
    const row = await locked(tx, id);
    if (!row) return { error: "not_found" } as const;
    const current = await status(tx, row);
    if (current.active) return { hospital: current };
    if (current.lifecycleStatus !== "PROVISIONING") {
      await audit(tx, id, actor, "activation_failed", "invalid_lifecycle_transition");
      return { error: "invalid_lifecycle_transition", hospital: current } as const;
    }
    if (!current.ready) {
      await audit(tx, id, actor, "activation_failed", "hospital_not_ready");
      return { error: "hospital_not_ready", hospital: current } as const;
    }
    const [activated] = await tx.update(tenants).set({
      loginEnabled: true, lifecycleStatus: "ACTIVE", lifecycleVersion: sql`${tenants.lifecycleVersion} + 1`, lifecycleChangedAt: new Date(),
    }).where(and(eq(tenants.id, row.tenantId!), eq(tenants.lifecycleStatus, "PROVISIONING"))).returning();
    if (!activated) return { error: "invalid_lifecycle_transition", hospital: current } as const;
    await audit(tx, id, actor, "hospital_activated");
    return { hospital: { ...current, active: true } };
  });
}
