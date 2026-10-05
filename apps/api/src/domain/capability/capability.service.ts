import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { tenantCapabilities, tenants } from "../../db/schema.js";
import { recordActivity } from "../activity/activity.service.js";
import {
  CAPABILITIES,
  CAPABILITY_DEPENDENCIES,
  CAPABILITY_META,
  EDITION_CAPABILITIES,
  OPERATIONAL_CAPABILITIES,
  resolveCapabilities,
  validateCapabilityChange,
  type Capability,
  type CapabilityMap,
  type Edition,
  type Role,
} from "@pulseos/types";

const isCapability = (v: string): v is Capability => (CAPABILITIES as readonly string[]).includes(v);

/** The tenant's own switches (only the ones that differ from nothing: a row means "override"). */
export async function loadCapabilityOverrides(db: Db, tenantId: string): Promise<Partial<Record<Capability, boolean>>> {
  const rows = await db.select().from(tenantCapabilities).where(eq(tenantCapabilities.tenantId, tenantId));
  const out: Partial<Record<Capability, boolean>> = {};
  for (const r of rows) if (isCapability(r.capability)) out[r.capability] = r.enabled;
  return out;
}

export async function resolveTenantCapabilities(db: Db, tenantId: string, edition: Edition): Promise<CapabilityMap> {
  return resolveCapabilities(edition, await loadCapabilityOverrides(db, tenantId));
}

export interface CapabilityState {
  key: Capability;
  label: string;
  description: string;
  enabled: boolean;
  /** What the edition would give this tenant with no override. */
  editionDefault: boolean;
  /** The tenant's own switch differs from the edition default. */
  overridden: boolean;
  dependsOn: Capability[];
  /** The integration provider that makes it do anything (its configuration and health live in the Integration Hub). */
  provider: string | null;
  growth: boolean;
  /** May the caller change this switch? */
  editable: boolean;
}

/** Roles that may change a capability: Super Admin all of them; a Hospital Admin only the operational ones. */
export function canEditCapability(role: Role, capability: Capability): boolean {
  if (role === "SUPER_ADMIN") return true;
  return role === "HOSPITAL_ADMIN" && OPERATIONAL_CAPABILITIES.includes(capability);
}

export async function listCapabilityStates(db: Db, tenantId: string, edition: Edition, role: Role): Promise<CapabilityState[]> {
  const overrides = await loadCapabilityOverrides(db, tenantId);
  const effective = resolveCapabilities(edition, overrides);
  const defaults = new Set(EDITION_CAPABILITIES[edition]);
  return CAPABILITIES.map((key) => ({
    key,
    label: CAPABILITY_META[key].label,
    description: CAPABILITY_META[key].description,
    enabled: effective[key],
    editionDefault: defaults.has(key),
    overridden: overrides[key] !== undefined && overrides[key] !== defaults.has(key),
    dependsOn: CAPABILITY_DEPENDENCIES[key] ?? [],
    provider: CAPABILITY_META[key].provider ?? null,
    growth: !!CAPABILITY_META[key].growth,
    editable: canEditCapability(role, key),
  }));
}

export type SetCapabilityResult = { ok: true; capabilities: CapabilityMap } | { ok: false; reason: string; capabilities?: Capability[] };

/**
 * Switch one capability for THIS tenant (the tenant comes from the session, never the request). `enabled: null` removes the
 * override, returning to the edition default. Invalid combinations are refused with what is in the way.
 */
export async function setCapability(db: Db, tenantId: string, actor: { id: string; role: Role }, key: string, enabled: boolean | null): Promise<SetCapabilityResult> {
  if (!isCapability(key)) return { ok: false, reason: "unknown_capability" };
  if (!canEditCapability(actor.role, key)) return { ok: false, reason: "forbidden" };
  return db.transaction(async (tx) => applyCapabilityChange(tx as unknown as Db, tenantId, actor, key, enabled));
}

async function applyCapabilityChange(db: Db, tenantId: string, actor: { id: string; role: Role }, key: Capability, enabled: boolean | null): Promise<SetCapabilityResult> {
  // One change at a time per hospital: the dependency check and the write see the same state (FOR UPDATE on the tenant row).
  const [tenant] = await db.select({ edition: tenants.edition }).from(tenants).where(eq(tenants.id, tenantId)).for("update").limit(1);
  if (!tenant) return { ok: false, reason: "tenant_not_found" };

  const overrides = await loadCapabilityOverrides(db, tenantId);
  const current = resolveCapabilities(tenant.edition, overrides);
  const target = enabled === null ? EDITION_CAPABILITIES[tenant.edition].includes(key) : enabled;
  if (target !== current[key]) {
    const check = validateCapabilityChange(current, key, target);
    if (!check.ok) return { ok: false, reason: check.reason, capabilities: check.capabilities };
  }

  if (enabled === null) await db.delete(tenantCapabilities).where(and(eq(tenantCapabilities.tenantId, tenantId), eq(tenantCapabilities.capability, key)));
  else
    await db
      .insert(tenantCapabilities)
      .values({ tenantId, capability: key, enabled, updatedBy: actor.id })
      .onConflictDoUpdate({ target: [tenantCapabilities.tenantId, tenantCapabilities.capability], set: { enabled, updatedBy: actor.id, updatedAt: new Date() } });
  await recordActivity(db, { tenantId, actorId: actor.id, action: "capability.changed", entityType: "capability", entityKey: key, metadata: { enabled, from: current[key], to: target } });
  return { ok: true, capabilities: await resolveTenantCapabilities(db, tenantId, tenant.edition) };
}

/** Webhooks have no session: resolve the connector tenant's capabilities directly. */
export async function tenantCapabilityMap(db: Db, tenantId: string): Promise<CapabilityMap> {
  const [tenant] = await db.select({ edition: tenants.edition }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return resolveCapabilities(tenant?.edition ?? "BETA_V1_CORE", await loadCapabilityOverrides(db, tenantId));
}
