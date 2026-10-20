import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { accountTokens, tenants, users } from "../../db/schema.js";
import type { TenantStatus } from "@pulseos/types";
import { resolveCapabilitiesForTenants } from "../capability/capability.service.js";
import { listHubForTenants } from "../integration/hub.service.js";
import { listPlatformAudit } from "./audit.service.js";
import { integrationAttention, isConfiguredIntegration } from "./integration-health.js";

/**
 * The company dashboard. Every number is a count of real rows right now - no growth percentages, because there is no
 * historical series to compare against. Aggregates only: nothing patient-level.
 */
export async function getPlatformOverview(db: Db) {
  const statusRows = await db.select({ status: tenants.status, n: sql<number>`count(*)::int` }).from(tenants).groupBy(tenants.status);
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Partial<Record<TenantStatus, number>>;
  const totalTenants = statusRows.reduce((a, r) => a + r.n, 0);

  const [activeUsers] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.status, "ACTIVE"), eq(users.isSystem, false), ne(tenants.status, "ARCHIVED")));
  const [pendingInvites] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountTokens)
    .where(and(eq(accountTokens.purpose, "INVITE"), eq(accountTokens.status, "PENDING"), gt(accountTokens.expiresAt, new Date())));

  // Integration health across every hospital that is not archived: the same derivation as each hospital's own Hub.
  const live = await db.select({ id: tenants.id, name: tenants.name, edition: tenants.edition }).from(tenants).where(ne(tenants.status, "ARCHIVED"));
  const caps = await resolveCapabilitiesForTenants(db, live);
  const hubs = await listHubForTenants(db, live.map((t) => ({ id: t.id, caps: caps.get(t.id)! })));
  let configuredIntegrations = 0;
  const integrationIssues: { tenantId: string; tenantName: string; integration: string; reason: string }[] = [];
  for (const t of live) {
    for (const card of hubs.get(t.id) ?? []) {
      if (isConfiguredIntegration(card)) configuredIntegrations++;
      const reason = integrationAttention(card);
      if (reason) integrationIssues.push({ tenantId: t.id, tenantName: t.name, integration: card.name, reason });
    }
  }

  // Recently active hospitals: the latest staff sign-in per hospital.
  const recentActivity = await db
    .select({ tenantId: tenants.id, tenantName: tenants.name, status: tenants.status, lastSignInAt: sql<Date>`max(${users.lastSignInAt})`, activeUsers: sql<number>`count(*) filter (where ${users.status} = 'ACTIVE' and not ${users.isSystem})::int` })
    .from(tenants)
    .innerJoin(users, eq(users.tenantId, tenants.id))
    .where(isNotNull(users.lastSignInAt))
    .groupBy(tenants.id)
    .orderBy(desc(sql`max(${users.lastSignInAt})`))
    .limit(8);

  const onboarding = await db
    .select({ id: tenants.id, name: tenants.name, status: tenants.status, createdAt: tenants.createdAt })
    .from(tenants)
    .where(inArray(tenants.status, ["DRAFT", "ONBOARDING"]))
    .orderBy(desc(tenants.createdAt))
    .limit(8);

  const security = await listPlatformAudit(db, { security: true, page: 1, pageSize: 8 });

  return {
    tenants: {
      total: totalTenants,
      active: byStatus.ACTIVE ?? 0,
      onboarding: (byStatus.ONBOARDING ?? 0) + (byStatus.DRAFT ?? 0),
      suspended: byStatus.SUSPENDED ?? 0,
      archived: byStatus.ARCHIVED ?? 0,
      byStatus,
    },
    activeUsers: activeUsers?.n ?? 0,
    pendingInvitations: pendingInvites?.n ?? 0,
    configuredIntegrations,
    integrationsNeedingAttention: integrationIssues.length,
    integrationIssues: integrationIssues.slice(0, 10),
    recentActivity: recentActivity.map((r) => ({ ...r, lastSignInAt: r.lastSignInAt ? new Date(r.lastSignInAt).toISOString() : null })),
    onboarding: onboarding.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    recentSecurity: security.rows.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), action: r.action, outcome: r.outcome, actor: r.actorLabel, summary: r.summary })),
  };
}
