import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CAPABILITIES,
  CAPABILITY_DEPENDENCIES,
  CAPABILITY_META,
  EDITIONS,
  EDITION_CAPABILITIES,
  LOCKED_CAPABILITIES,
  PLAN_META,
  resolveCapabilities,
  validateCapabilityChange,
  type Capability,
  type Edition,
} from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { tenantCapabilities, tenants } from "../../db/schema.js";
import { loadCapabilityOverrides } from "../capability/capability.service.js";
import { recordActivity } from "../activity/activity.service.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";
import { capabilityProblems, UUID } from "./tenants.service.js";

// Plans are the editions: a named DEFAULT bundle of capabilities, defined once in code (EDITION_CAPABILITIES, reviewed and
// versioned with the product). A tenant's own overrides sit on top; plan default + overrides = what the tenant can do,
// and the API enforces that on every request (requireCapability). Entitlements only: there is no billing here.

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number; detail?: unknown };

export async function listPlans(db: Db) {
  const counts = await db
    .select({ edition: tenants.edition, status: tenants.status, n: sql<number>`count(*)::int` })
    .from(tenants)
    .groupBy(tenants.edition, tenants.status);
  const overrides = await db
    .select({ edition: tenants.edition, n: sql<number>`count(distinct ${tenantCapabilities.tenantId})::int` })
    .from(tenantCapabilities)
    .innerJoin(tenants, eq(tenants.id, tenantCapabilities.tenantId))
    .groupBy(tenants.edition);
  return {
    plans: EDITIONS.map((e) => {
      const rows = counts.filter((c) => c.edition === e.key);
      return {
        key: e.key,
        name: PLAN_META[e.key].name,
        label: e.label,
        description: PLAN_META[e.key].description,
        status: "ACTIVE" as const,
        capabilities: CAPABILITIES.map((c) => ({ key: c, label: CAPABILITY_META[c].label, description: CAPABILITY_META[c].description, included: EDITION_CAPABILITIES[e.key].includes(c), locked: LOCKED_CAPABILITIES.includes(c), dependsOn: CAPABILITY_DEPENDENCIES[c] ?? [], provider: CAPABILITY_META[c].provider ?? null })),
        tenants: { total: rows.reduce((a, r) => a + r.n, 0), byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])) },
        tenantsWithOverrides: overrides.find((o) => o.edition === e.key)?.n ?? 0,
      };
    }),
  };
}

/** Plan provides / tenant override / effective, per capability. */
export async function tenantCapabilityMatrix(db: Db, tenantId: string) {
  if (!UUID.test(tenantId)) return null;
  const [t] = await db.select({ edition: tenants.edition, version: tenants.version }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) return null;
  const overrides = await loadCapabilityOverrides(db, tenantId);
  const effective = resolveCapabilities(t.edition, overrides);
  return {
    edition: t.edition,
    plan: PLAN_META[t.edition].name,
    version: t.version,
    capabilities: CAPABILITIES.map((c) => ({
      key: c,
      label: CAPABILITY_META[c].label,
      description: CAPABILITY_META[c].description,
      planDefault: EDITION_CAPABILITIES[t.edition].includes(c),
      override: overrides[c] ?? null,
      effective: effective[c],
      locked: LOCKED_CAPABILITIES.includes(c),
      dependsOn: CAPABILITY_DEPENDENCIES[c] ?? [],
      provider: CAPABILITY_META[c].provider ?? null,
    })),
  };
}

const isCapability = (v: string): v is Capability => (CAPABILITIES as readonly string[]).includes(v);

/**
 * Switch one capability for a tenant from the console (null = back to the plan default). The same dependency rules as the
 * hospital's own Features page, under the same row lock. Written to the tenant's own activity log (attributed to PulseOS
 * platform staff, never to a hospital user) and to the platform audit trail.
 */
export async function setTenantCapability(db: Db, tenantId: string, key: string, enabled: boolean | null, actor: AuditActor): Promise<Result<{ effective: Record<string, boolean> }>> {
  if (!UUID.test(tenantId)) return { ok: false, reason: "not_found", status: 404 };
  if (!isCapability(key)) return { ok: false, reason: "unknown_capability", status: 404 };
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update").limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    const txDb = tx as unknown as Db;
    const overrides = await loadCapabilityOverrides(txDb, tenantId);
    const current = resolveCapabilities(t.edition, overrides);
    const target = enabled === null ? EDITION_CAPABILITIES[t.edition].includes(key) : enabled;
    if (target !== current[key]) {
      const check = validateCapabilityChange(current, key, target);
      if (!check.ok) return { ok: false as const, reason: check.reason, status: 409, detail: check.capabilities };
    }
    if (enabled === null) await tx.delete(tenantCapabilities).where(and(eq(tenantCapabilities.tenantId, tenantId), eq(tenantCapabilities.capability, key)));
    else
      await tx
        .insert(tenantCapabilities)
        .values({ tenantId, capability: key, enabled, updatedBy: null })
        .onConflictDoUpdate({ target: [tenantCapabilities.tenantId, tenantCapabilities.capability], set: { enabled, updatedBy: null, updatedAt: new Date() } });
    await recordActivity(txDb, { tenantId, actorId: null, action: "capability.changed", entityType: "capability", entityKey: key, metadata: { enabled, from: current[key], to: target, by: "PulseOS platform staff" } });
    await recordPlatformAudit(tx, actor, { action: "capability.changed", summary: `${CAPABILITY_META[key].label} for ${t.name}: ${enabled === null ? "back to plan default" : enabled ? "on" : "off"}`, targetType: "capability", targetId: key, tenantId, metadata: { from: current[key], to: target, override: enabled } });
    return { ok: true as const, effective: resolveCapabilities(t.edition, await loadCapabilityOverrides(txDb, tenantId)) };
  });
}

export const changePlanSchema = z.object({ edition: z.enum(["BETA_V1_CORE", "BETA_V2_GROWTH"]), version: z.number().int().positive(), reason: z.string().trim().min(5).max(500) }).strict();

/** Move a tenant to another plan. Its overrides stay; a combination the new defaults make impossible is refused. */
export async function changeTenantPlan(db: Db, tenantId: string, input: z.infer<typeof changePlanSchema>, actor: AuditActor): Promise<Result<object>> {
  if (!UUID.test(tenantId)) return { ok: false, reason: "not_found", status: 404 };
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update").limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    if (t.version !== input.version) return { ok: false as const, reason: "stale_version", status: 409 };
    if (t.edition === input.edition) return { ok: true as const };
    const overrides = await loadCapabilityOverrides(tx as unknown as Db, tenantId);
    const problems = capabilityProblems(resolveCapabilities(input.edition as Edition, overrides));
    if (problems.length) return { ok: false as const, reason: "invalid_capabilities", status: 409, detail: problems };
    await tx.update(tenants).set({ edition: input.edition, updatedAt: new Date(), version: t.version + 1 }).where(eq(tenants.id, tenantId));
    await recordActivity(tx as unknown as Db, { tenantId, actorId: null, action: "plan.changed", entityType: "plan", entityKey: input.edition, metadata: { from: t.edition, to: input.edition, by: "PulseOS platform staff" } });
    await recordPlatformAudit(tx, actor, { action: "tenant.plan_changed", summary: `${t.name}: ${PLAN_META[t.edition].name} → ${PLAN_META[input.edition].name}`, targetType: "tenant", targetId: tenantId, tenantId, reason: input.reason, metadata: { from: t.edition, to: input.edition, overrides } });
    return { ok: true as const };
  });
}
