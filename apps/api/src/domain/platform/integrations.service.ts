import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { branches, calls, communicationEndpoints, connectorDispositionMappings, connectorEvents, connectors, outboundWebhookDeliveries, outboundWebhooks, tenants } from "../../db/schema.js";
import { resolveCapabilitiesForTenants } from "../capability/capability.service.js";
import { catalogueEntry, INTEGRATION_CATALOGUE } from "../integration/hub-catalogue.js";
import { listHubForTenants, type TenantHubCard } from "../integration/hub.service.js";
import { redactLogText } from "../security/redact.js";
import { integrationAttention, integrationBucket } from "./integration-health.js";
import { UUID } from "./tenants.service.js";

// Integrations across every hospital, as STATE: enabled, configured, credential readability, last activity, health and
// what needs attention - never a credential, never ciphertext, never a payload or a recording link. Configuration itself
// is changed only through the hospital's own Integration Hub (in Support Mode with edits enabled), never duplicated here.

export const listIntegrationsSchema = z
  .object({
    connector: z.string().max(40).optional(),
    tenantId: z.string().regex(UUID).optional(),
    bucket: z.enum(["healthy", "attention", "not_configured"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

function row(t: { id: string; name: string; status: string; environment: string }, c: TenantHubCard) {
  return {
    tenantId: t.id,
    tenantName: t.name,
    tenantStatus: t.status,
    environment: t.environment,
    connector: c.key,
    connectorName: c.name,
    category: c.category,
    enabled: c.enabled,
    configuration: c.configuration,
    credentialState: c.credentialState,
    mode: c.mode,
    health: c.health,
    lastEventAt: c.lastEventAt,
    lastError: c.lastError,
    endpointCount: c.endpointCount,
    attention: integrationAttention(c),
    bucket: integrationBucket(c),
  };
}

/** Every hospital x integration that is switched on or has been set up. Same derivation as each hospital's own Hub. */
export async function listPlatformIntegrations(db: Db, f: z.infer<typeof listIntegrationsSchema>) {
  const list = await db
    .select({ id: tenants.id, name: tenants.name, status: tenants.status, environment: tenants.environment, edition: tenants.edition })
    .from(tenants)
    .where(f.tenantId ? eq(tenants.id, f.tenantId) : ne(tenants.status, "ARCHIVED"))
    .orderBy(tenants.name);
  const caps = await resolveCapabilitiesForTenants(db, list);
  const hubs = await listHubForTenants(db, list.map((t) => ({ id: t.id, caps: caps.get(t.id)! })));
  let rows = list.flatMap((t) => (hubs.get(t.id) ?? []).filter((c) => !c.blockedReason && (c.enabled || c.connectorId || c.configuration !== "NOT_CONFIGURED")).map((c) => row(t, c)));
  const totals = { all: rows.length, healthy: rows.filter((r) => r.bucket === "healthy").length, attention: rows.filter((r) => r.bucket === "attention").length, not_configured: rows.filter((r) => r.bucket === "not_configured").length };
  if (f.connector) rows = rows.filter((r) => r.connector === f.connector);
  if (f.bucket) rows = rows.filter((r) => r.bucket === f.bucket);
  // Attention first, then by hospital.
  rows.sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || a.tenantName.localeCompare(b.tenantName) || a.connectorName.localeCompare(b.connectorName));
  return {
    rows: rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize),
    total: rows.length,
    page: f.page,
    pageSize: f.pageSize,
    totals,
    connectors: INTEGRATION_CATALOGUE.filter((e) => !e.blockedReason).map((e) => ({ key: e.key, name: e.name })),
  };
}

/**
 * One hospital's integration for support: which settings and credentials are present (by name only), its phone lines and
 * mappings, recent events (time, direction, outcome - no payload), redacted errors, and a recording count (never a link).
 */
export async function getTenantIntegrationDetail(db: Db, tenantId: string, key: string) {
  if (!UUID.test(tenantId)) return null;
  const entry = catalogueEntry(key);
  if (!entry) return null;
  const [t] = await db.select({ id: tenants.id, name: tenants.name, status: tenants.status, environment: tenants.environment, edition: tenants.edition }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) return null;
  const caps = await resolveCapabilitiesForTenants(db, [t]);
  const card = (await listHubForTenants(db, [{ id: tenantId, caps: caps.get(tenantId)! }])).get(tenantId)!.find((c) => c.key === key)!;
  const [conn] = entry.connectorProvider ? await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, entry.connectorProvider))).limit(1) : [];
  const config = (conn?.configuration as Record<string, unknown> | null) ?? {};
  const isSet = (k: string) => config[k] !== undefined && config[k] !== null && String(config[k]).trim() !== "";

  const endpoints = conn
    ? await db
        .select({ id: communicationEndpoints.id, type: communicationEndpoints.type, publicNumber: communicationEndpoints.publicNumber, label: communicationEndpoints.displayLabel, active: communicationEndpoints.isActive, branch: branches.name })
        .from(communicationEndpoints)
        .leftJoin(branches, eq(branches.id, communicationEndpoints.branchId))
        .where(eq(communicationEndpoints.connectorId, conn.id))
    : [];
  const mappings = conn ? await db.select({ disposition: connectorDispositionMappings.providerDisposition, action: connectorDispositionMappings.action }).from(connectorDispositionMappings).where(eq(connectorDispositionMappings.connectorId, conn.id)) : [];
  const events = conn
    ? await db
        .select({ at: connectorEvents.receivedAt, processedAt: connectorEvents.processedAt, status: connectorEvents.status, direction: connectorEvents.direction, error: connectorEvents.error })
        .from(connectorEvents)
        .where(eq(connectorEvents.connectorId, conn.id))
        .orderBy(desc(connectorEvents.receivedAt))
        .limit(20)
    : [];
  const [eventTotals] = conn
    ? await db.select({ last24h: sql<number>`count(*) filter (where ${connectorEvents.receivedAt} > now() - interval '24 hours')::int`, failed24h: sql<number>`count(*) filter (where ${connectorEvents.status} = 'failed' and ${connectorEvents.receivedAt} > now() - interval '24 hours')::int`, lastProcessedAt: sql<Date | null>`max(${connectorEvents.processedAt})` }).from(connectorEvents).where(eq(connectorEvents.connectorId, conn.id))
    : [];
  const telephony = entry.connectorType === "TELEPHONY";
  const [rec] = telephony && conn ? await db.select({ calls: sql<number>`count(*)::int`, withRecording: sql<number>`count(*) filter (where ${calls.recordingUrl} is not null)::int`, lastCallAt: sql<Date | null>`max(${calls.startedAt})` }).from(calls).where(eq(calls.connectorId, conn.id)) : [];
  const webhooks =
    key === "webhooks"
      ? await db
          .select({ id: outboundWebhooks.id, name: outboundWebhooks.name, enabled: outboundWebhooks.enabled, category: outboundWebhooks.webhookCategory, events: outboundWebhooks.events, lastStatus: sql<string | null>`(select d.status from ${outboundWebhookDeliveries} d where d.webhook_id = ${outboundWebhooks.id} order by d.created_at desc limit 1)` })
          .from(outboundWebhooks)
          .where(eq(outboundWebhooks.tenantId, tenantId))
      : [];

  return {
    tenant: { id: t.id, name: t.name, status: t.status, environment: t.environment },
    integration: { ...row(t, card), purpose: entry.purpose, provider: entry.provider, capability: entry.capability, connectorMode: conn?.mode ?? null, lastSyncAt: card.lastSyncAt },
    configurationFields: entry.configurationFields.map((f) => ({ key: f.key, label: f.label, set: isSet(f.key) })),
    secretFields: entry.secretFields.map((f) => ({ key: f.key, label: f.label, saved: card.secretKeys.includes(f.key) })),
    endpoints,
    dispositionMappings: mappings,
    recentEvents: events.map((e) => ({ at: e.at.toISOString(), processedAt: e.processedAt?.toISOString() ?? null, status: e.status, direction: e.direction, error: redactLogText(e.error) })),
    eventTotals: eventTotals ? { last24h: eventTotals.last24h, failed24h: eventTotals.failed24h, lastProcessedAt: eventTotals.lastProcessedAt ? new Date(eventTotals.lastProcessedAt).toISOString() : null } : null,
    recordings: rec ? { calls: rec.calls, withRecording: rec.withRecording, lastCallAt: rec.lastCallAt ? new Date(rec.lastCallAt).toISOString() : null } : null,
    webhooks: webhooks.map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, category: w.category, events: w.events, lastDelivery: w.lastStatus })),
  };
}
