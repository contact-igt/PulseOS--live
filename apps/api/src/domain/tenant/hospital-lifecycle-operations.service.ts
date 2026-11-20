import { and, count, eq, gt, isNotNull, like, min, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectors, notifications, outboundWebhookDeliveries as hooks, suspendedMetaLeads as held, tenants } from "../../db/schema.js";
import { readMessagingCoordination } from "./hospital-messaging.service.js";
import { auditPage } from "../platform/platform-directory.service.js";

export async function readLifecycleOperations(db: Db, tenantId: string, includeAudit = false) {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const [[holding], [pending], [webhooks], [unresolved], [connector], [tenant], messaging, audit] = await Promise.all([
    db.select({ count: count(), oldest: min(held.heldAt),
      expiring: sql`count(*) filter (where ${held.expiresAt} <= ${soon.toISOString()}::timestamptz)`.mapWith(Number),
      exhausted: sql`count(*) filter (where ${held.attempts} >= 3)`.mapWith(Number) }).from(held)
      .where(and(eq(held.tenantId, tenantId), gt(held.expiresAt, now), isNotNull(held.reference))),
    db.select({ count: count(), oldest: min(notifications.createdAt) }).from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.status, "PENDING"))),
    db.select({ count: count(), oldest: min(hooks.createdAt) }).from(hooks)
      .where(and(eq(hooks.tenantId, tenantId), eq(hooks.status, "PENDING"))),
    db.select({ count: count() }).from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.status, "FAILED"), eq(notifications.provider, "whatsnexus"), like(notifications.reason, "OUTCOME_UNKNOWN%"))),
    db.select({ status: connectors.status, mode: connectors.mode, lastSyncAt: connectors.lastSyncAt,
      remoteTenantId: sql<string | null>`${connectors.configuration}->>'tenantId'` }).from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, "whatsnexus"))).limit(1),
    db.select({ status: tenants.lifecycleStatus, version: tenants.lifecycleVersion }).from(tenants).where(eq(tenants.id, tenantId)),
    readMessagingCoordination(db, tenantId),
    includeAudit ? auditPage(db, 5, 0, tenantId) : null,
  ]);
  const oldest = [holding?.oldest, pending?.oldest, webhooks?.oldest].filter((value) => value !== null && value !== undefined)
    .map((value) => new Date(value).getTime()).sort((a, b) => a - b)[0];
  return {
    providerCoordination: connector ? "external_pause_unverified" : "no_whatsnexus_connector",
    messaging,
    connector: connector ? {
      ...connector,
      remoteTenantId: connector.mode === "LIVE" && /^[A-Za-z0-9_-]{1,100}$/.test(connector.remoteTenantId ?? "") ? connector.remoteTenantId : null,
    } : null,
    recentAudit: audit?.items ?? [],
    lifecycleStatus: tenant?.status ?? null,
    lifecycleVersion: tenant?.version ?? null,
    oldestHeldMetaLeadAt: holding?.oldest ? new Date(holding.oldest).toISOString() : null,
    expiringMetaLeads: holding?.expiring ?? 0,
    exhaustedMetaLeads: holding?.exhausted ?? 0,
    pendingNotifications: pending?.count ?? 0,
    heldInbound: holding?.count ?? 0,
    queuedOutbound: (pending?.count ?? 0) + (webhooks?.count ?? 0),
    unresolvedDispatches: unresolved?.count ?? 0,
    oldestPendingAt: oldest === undefined ? null : new Date(oldest).toISOString(),
    lastVerifiedProviderHealthAt: null,
    restorationReconciliation: holding?.count ? tenant?.status === "ACTIVE" ? "awaiting_review" : "held" : "no_held_references",
  };
}
