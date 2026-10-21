import { inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { tenants } from "../../db/schema.js";

// Tenant lifecycle and AUTOMATED outbound communication (reminders, confirmations, scheduled WhatsApp, outbound webhooks).
//
//   canSendOutbound = tenant is ACTIVE  &&  the capability is on  &&  the tenant's own rule/setting allows it
//
// This module decides the first part; the jobs keep checking capabilities and rules exactly as before. Nothing here ever
// changes a tenant's saved settings: suspension pauses sending by DERIVING permission, so reactivation restores it as it was.
// Inbound ingestion (calls, WhatsApp, forms, webhooks) is never gated by this: a suspended hospital loses no enquiry.

export interface TenantLifecycleFacts {
  status: string;
  statusChangedAt: Date | null;
}

export type OutboundDecision = { ok: true } | { ok: false; reason: "TENANT_NOT_ACTIVE" };

/**
 * May an automated message that fell due at `dueAt` be sent now? Only for an ACTIVE tenant, and never a message that fell
 * due before the tenant (re)became active - so reactivating never releases a backlog of stale messages.
 */
export function outboundDecision(t: TenantLifecycleFacts | undefined, dueAt: Date): OutboundDecision {
  if (!t || t.status !== "ACTIVE") return { ok: false, reason: "TENANT_NOT_ACTIVE" };
  if (t.statusChangedAt && dueAt.getTime() < t.statusChangedAt.getTime()) return { ok: false, reason: "TENANT_NOT_ACTIVE" };
  return { ok: true };
}

/** Lifecycle facts for several tenants in one query. */
export async function tenantLifecycleFacts(db: DbOrTx, tenantIds: string[]): Promise<Map<string, TenantLifecycleFacts>> {
  const ids = [...new Set(tenantIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: tenants.id, status: tenants.status, statusChangedAt: tenants.statusChangedAt }).from(tenants).where(inArray(tenants.id, ids));
  return new Map(rows.map((r) => [r.id, { status: r.status, statusChangedAt: r.statusChangedAt }]));
}
