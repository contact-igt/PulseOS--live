import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import { branches, hospitalLifecycleAudit as audit, hospitalOnboardings, notifications, sessions, tenantLoginConfigs, tenantProfiles, tenants, users } from "../../db/schema.js";
import type { PlatformActor } from "../platform/platform-access.js";
import { enqueueMessagingPause } from "./hospital-messaging.service.js";

type State = typeof tenants.$inferSelect.lifecycleStatus;
type Target = { id: string; legacy: boolean };
export type LifecycleChange = { version: number; reason: string; explanation?: string | undefined };

export async function targetTenant(db: DbOrTx, target: Target) {
  if (target.legacy) {
    const [row] = await db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, target.id),
      sql`not exists (select 1 from ${hospitalOnboardings} where ${hospitalOnboardings.tenantId} = ${tenants.id})`));
    return row?.id;
  }
  const [row] = await db.select({ id: hospitalOnboardings.tenantId }).from(hospitalOnboardings).where(eq(hospitalOnboardings.id, target.id));
  return row?.id ?? undefined;
}

const historyFields = {
  id: audit.id, actorId: audit.actorId, action: audit.action, previousState: audit.previousState,
  requestedState: audit.requestedState, outcome: audit.outcome, reason: audit.reason,
  explanation: audit.explanation, createdAt: audit.createdAt,
};

async function lifecycleView(db: DbOrTx, hospital: typeof tenants.$inferSelect) {
  const [event] = await db.select({ reason: audit.reason, explanation: audit.explanation }).from(audit)
    .where(and(eq(audit.tenantId, hospital.id), eq(audit.action, "suspend"), eq(audit.requestedState, "SUSPENDED"), eq(audit.outcome, "applied")))
    .orderBy(desc(audit.createdAt), desc(audit.id)).limit(1);
  return { status: hospital.lifecycleStatus, version: hospital.lifecycleVersion, loginEnabled: hospital.loginEnabled,
    changedAt: hospital.lifecycleChangedAt, suspension: hospital.lifecycleStatus === "SUSPENDED" ? event ?? null : null };
}

export async function readLifecycle(db: Db, target: Target, history: boolean, page: number) {
  const id = await targetTenant(db, target);
  if (!id) return null;
  if (history) {
    const rows = await db.select(historyFields).from(audit).where(eq(audit.tenantId, id))
      .orderBy(desc(audit.createdAt), desc(audit.id)).limit(26).offset((page - 1) * 25);
    return { items: rows.slice(0, 25), hasMore: rows.length > 25 };
  }
  const [row] = await db.select().from(tenants).where(eq(tenants.id, id));
  return row ? lifecycleView(db, row) : null;
}

async function restorationReady(db: DbOrTx, tenant: typeof tenants.$inferSelect) {
  const [onboarding] = await db.select().from(hospitalOnboardings).where(eq(hospitalOnboardings.tenantId, tenant.id));
  const [admin] = await db.select({ id: users.id }).from(users)
    .innerJoin(branches, and(eq(branches.id, users.branchId), eq(branches.tenantId, tenant.id)))
    .where(and(eq(users.tenantId, tenant.id), eq(users.role, "SUPER_ADMIN"), onboarding?.adminId ? eq(users.id, onboarding.adminId) : undefined)).limit(1);
  if (!admin) return false;
  if (!onboarding) return true;
  const [profile] = await db.select({ id: tenantProfiles.tenantId }).from(tenantProfiles).where(eq(tenantProfiles.tenantId, tenant.id));
  const [branding] = await db.select({ id: tenantLoginConfigs.tenantId }).from(tenantLoginConfigs).where(eq(tenantLoginConfigs.tenantId, tenant.id));
  return Boolean(tenant.loginSlug && profile && branding && onboarding.invitationRedeemedAt &&
    ["none", "installed"].includes(onboarding.templateStatus));
}

export async function changeLifecycle(db: Db, target: Target, actor: PlatformActor, requested: State,
  change: LifecycleChange | null, permitted: boolean) {
  return db.transaction(async (tx) => {
    const id = await targetTenant(tx, target);
    const [row] = id ? await tx.select().from(tenants).where(eq(tenants.id, id)).for("update") : [];
    const record = (outcome: string) => tx.insert(audit).values({
      tenantId: row?.id, targetId: target.id, actorId: actor.kind === "browser" ? actor.id : null,
      operatorId: actor.kind === "operator" ? actor.id : null,
      action: requested === "SUSPENDED" ? "suspend" : "restore",
      previousState: row?.lifecycleStatus, requestedState: requested, outcome,
      reason: change?.reason, explanation: change?.explanation, requestVersion: change?.version,
    });
    const reject = async (error: string) => {
      await record(error);
      return { error };
    };
    if (!permitted) return reject("forbidden");
    if (!change) return reject("invalid_request");
    if (!row) return reject("not_found");

    if (row.lifecycleStatus === requested && row.lifecycleVersion === change.version + 1) {
      const [prior] = await tx.select({ id: audit.id, explanation: audit.explanation }).from(audit).where(and(
        eq(audit.tenantId, row.id), eq(audit.outcome, "applied"), eq(audit.requestVersion, change.version),
        eq(audit.requestedState, requested), eq(audit.reason, change.reason),
      )).limit(1);
      if (prior && prior.explanation === (change.explanation ?? null)) {
        await record("replayed");
        return { lifecycle: await lifecycleView(tx, row) };
      }
    }
    if (row.lifecycleVersion !== change.version) return reject("lifecycle_version_conflict");
    if (row.lifecycleStatus !== (requested === "SUSPENDED" ? "ACTIVE" : "SUSPENDED")) return reject("invalid_lifecycle_transition");
    if (requested === "ACTIVE" && !(await restorationReady(tx, row))) return reject("restoration_configuration_missing");

    const now = new Date();
    // Keep rows and idempotency keys. The appointment reconciler cannot reopen BLOCKED rows.
    if (requested === "ACTIVE") {
      await tx.update(notifications).set({ status: "BLOCKED", reason: "LIFECYCLE_STALE_NOTIFICATION" })
        .where(and(eq(notifications.tenantId, row.id), eq(notifications.status, "PENDING"), lte(notifications.scheduledFor, now)));
    } else {
      await tx.delete(sessions).where(inArray(sessions.userId, tx.select({ id: users.id }).from(users).where(eq(users.tenantId, row.id))));
    }
    const [updated] = await tx.update(tenants).set({
      lifecycleStatus: requested, loginEnabled: requested === "ACTIVE",
      lifecycleVersion: row.lifecycleVersion + 1, lifecycleChangedAt: now,
    }).where(eq(tenants.id, row.id)).returning();
    await record("applied");
    if (requested === "SUSPENDED") await enqueueMessagingPause(tx, row.id, updated!.lifecycleVersion, actor.id);
    return { lifecycle: await lifecycleView(tx, updated!) };
  });
}
