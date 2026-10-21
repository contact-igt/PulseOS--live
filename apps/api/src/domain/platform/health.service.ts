import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectorEvents, connectors, outboundWebhookDeliveries, tenants } from "../../db/schema.js";
import { redactLogText } from "../security/redact.js";
import { emailProvider } from "./email.js";

const STARTED_AT = new Date();

function apiVersion(): string {
  try {
    return (JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Commit of this build, from the platform's own build variables. Never a path, never a secret. */
function commit(): string | null {
  const c = process.env.GIT_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SOURCE_VERSION ?? null;
  return c && /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 12) : null;
}

function expectedMigrations(): number | null {
  try {
    const journal = JSON.parse(readFileSync(resolve(process.cwd(), "src/db/migrations/meta/_journal.json"), "utf8")) as { entries: unknown[] };
    return journal.entries.length;
  } catch {
    return null;
  }
}

/**
 * What can honestly be said about the platform right now: database reachability and latency, versions, migration state,
 * whether background jobs run in this process, connector event processing and recent integration errors (redacted).
 * Not an infrastructure monitor: no CPU, memory or uptime SLAs are invented.
 */
export async function getPlatformHealth(db: Db) {
  const t0 = performance.now();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  const latencyMs = Math.round((performance.now() - t0) * 10) / 10;

  let applied: number | null = null;
  let lastMigrationAt: string | null = null;
  try {
    const rows = (await db.execute(sql`select count(*)::int as n, max(created_at) as last from drizzle.__drizzle_migrations`)) as unknown as { n: number; last: string | number | null }[];
    applied = rows[0]?.n ?? 0;
    lastMigrationAt = rows[0]?.last ? new Date(Number(rows[0].last)).toISOString() : null;
  } catch {
    applied = null;
  }
  const expected = expectedMigrations();

  const [events] = await db
    .select({
      received24h: sql<number>`count(*) filter (where ${connectorEvents.receivedAt} > now() - interval '24 hours')::int`,
      failed24h: sql<number>`count(*) filter (where ${connectorEvents.status} = 'failed' and ${connectorEvents.receivedAt} > now() - interval '24 hours')::int`,
      waiting: sql<number>`count(*) filter (where ${connectorEvents.status} = 'received')::int`,
      oldestWaiting: sql<Date | null>`min(${connectorEvents.receivedAt}) filter (where ${connectorEvents.status} = 'received')`,
      lastProcessed: sql<Date | null>`max(${connectorEvents.processedAt})`,
    })
    .from(connectorEvents);
  const [webhooks] = await db
    .select({ sent24h: sql<number>`count(*) filter (where ${outboundWebhookDeliveries.status} = 'SENT' and ${outboundWebhookDeliveries.createdAt} > now() - interval '24 hours')::int`, failed24h: sql<number>`count(*) filter (where ${outboundWebhookDeliveries.status} = 'FAILED' and ${outboundWebhookDeliveries.createdAt} > now() - interval '24 hours')::int` })
    .from(outboundWebhookDeliveries);
  const recentErrors = await db
    .select({ at: connectorEvents.receivedAt, error: connectorEvents.error, tenantId: tenants.id, tenantName: tenants.name, connector: connectors.displayName })
    .from(connectorEvents)
    .innerJoin(connectors, eq(connectors.id, connectorEvents.connectorId))
    .innerJoin(tenants, eq(tenants.id, connectorEvents.tenantId))
    .where(and(eq(connectorEvents.status, "failed"), gt(connectorEvents.receivedAt, sql`now() - interval '7 days'`)))
    .orderBy(desc(connectorEvents.receivedAt))
    .limit(10);

  return {
    checkedAt: new Date().toISOString(),
    api: { ok: true, version: apiVersion(), commit: commit(), environment: process.env.NODE_ENV ?? "development", startedAt: STARTED_AT.toISOString() },
    database: { ok: dbOk, latencyMs },
    migrations: { applied, expected, pending: applied !== null && expected !== null ? Math.max(0, expected - applied) : null, newestMigrationAt: lastMigrationAt },
    jobs: { runner: process.env.JOBS_DISABLED === "true" ? "disabled" : "enabled" },
    email: { provider: emailProvider().name },
    connectorEvents: {
      received24h: events?.received24h ?? 0,
      failed24h: events?.failed24h ?? 0,
      waiting: events?.waiting ?? 0,
      oldestWaitingAt: events?.oldestWaiting ? new Date(events.oldestWaiting).toISOString() : null,
      lastProcessedAt: events?.lastProcessed ? new Date(events.lastProcessed).toISOString() : null,
    },
    outboundWebhooks: { sent24h: webhooks?.sent24h ?? 0, failed24h: webhooks?.failed24h ?? 0 },
    recentIntegrationErrors: recentErrors.map((e) => ({ at: e.at.toISOString(), tenantId: e.tenantId, tenantName: e.tenantName, connector: e.connector, error: redactLogText(e.error) })),
  };
}
