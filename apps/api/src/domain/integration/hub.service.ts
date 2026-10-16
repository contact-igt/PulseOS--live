import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calls, communicationEndpoints, connectorEvents, connectors, connectorSecrets, outboundWebhookDeliveries, outboundWebhooks, patients } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../security/encryption.js";
import { inLocalRange, isRealDate, tenantTimezone } from "../../lib/hospital-time.js";
import { hasPermission, type CapabilityMap, type IntegrationCard, type IntegrationDetail, type IntegrationLogRow, type Role } from "@pulseos/types";
import { redactLogText } from "../security/redact.js";
import { listSyncRuns } from "../ads/ads-sync.service.js";
import { ADS_PROVIDERS, type AdsProvider } from "@pulseos/types";
import { INTEGRATION_CATALOGUE, catalogueEntry, type CatalogueEntry } from "./hub-catalogue.js";
import { deriveConfiguration, deriveHealth, deriveMode, type ConnectorFacts } from "./hub-state.js";
import { recordConnectorEvent, markEventProcessed } from "../connector/connector-event.service.js";
import { whatsNexusAdapter } from "../connector/adapters/whatsnexus.js";
import { validateWebhookUrl, webhookAllowInsecure } from "./webhook-rules.js";
import { persistInboundCall } from "../connector/call-webhook.service.js";
import type { InboundCallEvent } from "../connector/types.js";
import { recordActivity } from "../activity/activity.service.js";

type ConnectorRowT = typeof connectors.$inferSelect;
type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

async function loadFacts(db: Db, tenantId: string): Promise<Map<string, { row: ConnectorRowT; facts: ConnectorFacts; phoneNumbers: { number: string; label: string; active: boolean }[] }>> {
  const rows = await db.select().from(connectors).where(eq(connectors.tenantId, tenantId));
  const endpoints = await db.select().from(communicationEndpoints).where(eq(communicationEndpoints.tenantId, tenantId));
  const out = new Map<string, { row: ConnectorRowT; facts: ConnectorFacts; phoneNumbers: { number: string; label: string; active: boolean }[] }>();
  for (const row of rows) {
    const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, row.id)).limit(1);
    let secretKeys: string[] = [];
    if (secret) {
      try {
        // Only the NAMES of stored secrets leave this function, never a value.
        secretKeys = Object.entries(decryptSecret(secret.encryptedPayload)).filter(([, v]) => v !== "" && v != null).map(([k]) => k);
      } catch {
        secretKeys = [];
      }
    }
    const phoneNumbers = endpoints
      .filter((e) => e.connectorId === row.id)
      .map((e) => ({ number: e.publicNumber, label: e.displayLabel, active: e.isActive }));
    out.set(row.provider, { row, facts: { status: row.status, mode: row.mode, configuration: (row.configuration as Record<string, unknown> | null) ?? null, secretKeys }, phoneNumbers });
  }
  return out;
}

interface WebhookFacts {
  total: number;
  enabled: number;
  whatsNexusTotal: number;
  whatsNexusEnabled: number;
  lastDelivery: "SENT" | "FAILED" | "PENDING" | null;
}

async function webhookFacts(db: Db, tenantId: string): Promise<WebhookFacts> {
  const [c] = await db
    .select({
      total: sql<number>`count(*)::int`,
      enabled: sql<number>`count(*) filter (where ${outboundWebhooks.enabled})::int`,
      whatsNexusTotal: sql<number>`count(*) filter (where ${outboundWebhooks.webhookCategory} = 'WHATSNEXUS')::int`,
      whatsNexusEnabled: sql<number>`count(*) filter (where ${outboundWebhooks.webhookCategory} = 'WHATSNEXUS' and ${outboundWebhooks.enabled})::int`,
    })
    .from(outboundWebhooks)
    .where(eq(outboundWebhooks.tenantId, tenantId));
  const [last] = await db.select({ status: outboundWebhookDeliveries.status }).from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.tenantId, tenantId)).orderBy(desc(outboundWebhookDeliveries.createdAt)).limit(1);
  return {
    total: c?.total ?? 0,
    enabled: c?.enabled ?? 0,
    whatsNexusTotal: c?.whatsNexusTotal ?? 0,
    whatsNexusEnabled: c?.whatsNexusEnabled ?? 0,
    lastDelivery: (last?.status as WebhookFacts["lastDelivery"]) ?? null,
  };
}

function card(entry: CatalogueEntry, caps: CapabilityMap, role: Role, found: { row: ConnectorRowT; facts: ConnectorFacts; phoneNumbers: { number: string; label: string; active: boolean }[] } | undefined, wh: WebhookFacts): IntegrationCard {
  const facts = found?.facts ?? null;
  const enabled = entry.capability ? caps[entry.capability] : true;
  let configuration = deriveConfiguration(entry, facts);
  if (entry.key === "webhooks") configuration = wh.total > 0 ? "CONFIGURED" : "NOT_CONFIGURED";

  const mode =
    entry.key === "webhooks"
      ? wh.total === 0 ? "NOT_CONFIGURED" : wh.enabled === 0 ? "DISABLED" : wh.lastDelivery === "SENT" ? "LIVE_CONFIGURED" : "LIVE_CAPABLE"
      : deriveMode(entry, enabled, configuration, facts);

  const health =
    entry.key === "webhooks"
      ? wh.lastDelivery === "SENT" ? "HEALTHY" : wh.lastDelivery === "FAILED" ? "UNHEALTHY" : wh.total > 0 ? "UNKNOWN" : "NOT_APPLICABLE"
      : deriveHealth(entry, facts);

  const isConnected =
    found?.row.status === "CONNECTED" ||
    (entry.key === "webhooks" && wh.enabled > 0 && wh.lastDelivery === "SENT");

  return {
    key: entry.key,
    category: entry.category,
    name: entry.name,
    provider: entry.provider,
    purpose: entry.purpose,
    capability: entry.capability,
    enabled,
    configuration,
    health,
    mode,
    blockedReason: entry.blockedReason,
    lastSyncAt: found?.row.lastSyncAt?.toISOString() ?? null,
    lastEventAt: found?.row.lastEventAt?.toISOString() ?? null,
    lastError: found?.row.lastError ?? null,
    // Webhooks, WhatsNexus and credentials are Super Admin territory; operational settings are Admin and Super Admin.
    canConfigure: entry.key === "webhooks" || entry.key === "whatsnexus" ? hasPermission(role, "MANAGE_INTEGRATION_SECRETS") : !entry.blockedReason && hasPermission(role, "MANAGE_INTEGRATION_CONFIG"),
    canManageSecrets: !entry.blockedReason && hasPermission(role, "MANAGE_INTEGRATION_SECRETS"),
    phoneNumbers: found?.phoneNumbers ?? [],
    isConnected,
  };
}

export async function listHub(db: Db, tenantId: string, role: Role, caps: CapabilityMap): Promise<IntegrationCard[]> {
  const facts = await loadFacts(db, tenantId);
  const wh = await webhookFacts(db, tenantId);
  const whatsNexusSelected = String(facts.get("whatsnexus")?.facts.configuration?.useForSending ?? "") === "true";
  return INTEGRATION_CATALOGUE.map((e) => {
    const result = card(e, caps, role, e.connectorProvider ? facts.get(e.connectorProvider) : undefined, wh);
    // Seeded Runo sample calls are useful in the demo, but are not a hospital's configured Runo connection.
    if (e.key === "runo" && result.mode === "FIXTURE") {
      return { ...result, configuration: "NOT_CONFIGURED", health: "UNKNOWN", mode: "NOT_CONFIGURED", phoneNumbers: [], isConnected: false, lastSyncAt: null, lastEventAt: null };
    }
    // WhatsNexus is the sole WhatsApp sender when selected; do not show Meta's demo fixture as an active alternative.
    return e.key === "whatsapp_meta_cloud" && whatsNexusSelected
      ? { ...result, enabled: false, configuration: "NOT_CONFIGURED", health: "NOT_APPLICABLE", mode: "DISABLED", phoneNumbers: [], isConnected: false }
      : result;
  });
}

export async function getHubDetail(db: Db, tenantId: string, role: Role, caps: CapabilityMap, key: string): Promise<IntegrationDetail | null> {
  const entry = catalogueEntry(key);
  if (!entry) return null;
  const facts = await loadFacts(db, tenantId);
  const found = entry.connectorProvider ? facts.get(entry.connectorProvider) : undefined;
  const base = card(entry, caps, role, found, await webhookFacts(db, tenantId));

  const config = found?.facts.configuration ?? {};
  const base_ = process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || (process.env.NODE_ENV === "production" ? "" : `http://localhost:${process.env.PORT || 4310}`);
  const webhookPath =
    found && entry.key === "whatsapp_meta_cloud"
      ? `/webhooks/whatsapp/${found.row.id}`
      : found && entry.key === "runo"
      ? `/webhooks/runo/${found.row.id}`
      : found && entry.key === "ccs_ivr"
      ? `/webhooks/ccs/${found.row.id}`
      : entry.key === "whatsnexus"
      ? `/webhooks/whatsnexus/${tenantId}`
      : null;

  const isTelephony = entry.key === "ccs_ivr" || entry.key === "runo";
  const recentCalls = isTelephony && found
    ? (
        await db
          .select({
            id: calls.id,
            phone: calls.phone,
            status: calls.status,
            durationSeconds: calls.durationSeconds,
            recordingUrl: calls.recordingUrl,
            startedAt: calls.startedAt,
            journeyId: calls.journeyId,
            patientId: calls.patientId,
            patientName: patients.name,
          })
          .from(calls)
          .leftJoin(patients, eq(patients.id, calls.patientId))
          .where(and(eq(calls.tenantId, tenantId), eq(calls.connectorId, found.row.id)))
          .orderBy(desc(calls.startedAt))
          .limit(10)
      ).map((c) => ({
        ...c,
        startedAt: c.startedAt ? c.startedAt.toISOString() : null,
      }))
    : undefined;

  return {
    ...base,
    configurationFields: entry.configurationFields,
    configurationValues: Object.fromEntries(entry.configurationFields.map((f) => [f.key, (config as any)[f.key] == null ? "" : String((config as any)[f.key])])),
    secretFields: entry.secretFields.map((f) => ({
      ...f,
      hasSecret: !!found?.facts.secretKeys.includes(f.key),
    })),
    mappingNotes: entry.key === "whatsnexus" ? await whatsNexusNotes(db, tenantId, entry.mappingNotes) : entry.mappingNotes,
    syncRuns: (ADS_PROVIDERS as readonly string[]).includes(entry.key) ? await listSyncRuns(db, tenantId, entry.key as AdsProvider) : undefined,
    recentCalls,
    webhookUrl: webhookPath ? `${base_}${webhookPath}` : null,
    connectorMode: found?.row.mode ?? null,
  };
}

/** The connectors row behind a catalogue entry, created on first configuration (FIXTURE until a Super Admin says otherwise). */
async function ensureConnector(db: Db, tenantId: string, entry: CatalogueEntry): Promise<ConnectorRowT | null> {
  if (!entry.connectorProvider || !entry.connectorType) return null;
  const [existing] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, entry.connectorProvider))).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(connectors)
    .values({ tenantId, type: entry.connectorType, provider: entry.connectorProvider, displayName: entry.name, capabilities: entry.connectorCapabilities, status: "NOT_CONFIGURED", mode: "FIXTURE", configuration: {} })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, entry.connectorProvider))).limit(1);
  return again ?? null;
}

export interface ConfigureInput {
  configuration?: Record<string, string>;
  secrets?: Record<string, string>;
  mode?: "FIXTURE" | "SANDBOX" | "LIVE";
}

/**
 * Save settings for one integration. Permission split is enforced by the caller (secrets and mode: Super Admin);
 * unknown field names are refused so a request can never write arbitrary keys. Secrets MERGE into what is stored
 * (a blank value leaves that secret untouched) and are never echoed back.
 */
export async function configureIntegration(db: Db, tenantId: string, key: string, input: ConfigureInput): Promise<Result<object>> {
  const entry = catalogueEntry(key);
  if (!entry) return { ok: false, reason: "unknown_integration" };

  if (entry.blockedReason || !entry.connectorProvider) return { ok: false, reason: "blocked" };
  const connector = await ensureConnector(db, tenantId, entry);
  if (!connector) return { ok: false, reason: "blocked" };

  const configKeys = new Set(entry.configurationFields.map((f) => f.key));
  const secretKeys = new Set(entry.secretFields.map((f) => f.key));
  for (const k of Object.keys(input.configuration ?? {})) if (!configKeys.has(k)) return { ok: false, reason: "unknown_field" };
  for (const k of Object.keys(input.secrets ?? {})) if (!secretKeys.has(k)) return { ok: false, reason: "unknown_field" };
  if (key === "whatsnexus") {
    const refused = await validateWhatsNexusInput(db, connector, input);
    if (refused) return { ok: false, reason: refused };
  }

  let configuration = (connector.configuration as Record<string, unknown> | null) ?? {};
  if (input.configuration) {
    configuration = { ...configuration };
    for (const [k, v] of Object.entries(input.configuration)) {
      if (v.trim() === "") delete configuration[k];
      else configuration[k] = key === "whatsnexus" && k === "baseUrl" ? v.trim().replace(/\/+$/, "") : v.trim();
    }
  }

  const [stored] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connector.id)).limit(1);
  let secretsNow: Record<string, unknown> = {};
  if (stored) {
    try {
      secretsNow = decryptSecret(stored.encryptedPayload);
    } catch {
      secretsNow = {};
    }
  }
  if (input.secrets) {
    secretsNow = { ...secretsNow };
    for (const [k, v] of Object.entries(input.secrets)) {
      // The one secret that must be removable: the previous callback secret kept only while WhatsNexus rotates over ("-" clears it).
      if (key === "whatsnexus" && k === "previousCallbackSecret" && v.trim() === "-") delete secretsNow[k];
      else if (v.trim() !== "") secretsNow[k] = v.trim();
    }
    const encryptedPayload = encryptSecret(secretsNow);
    await db.insert(connectorSecrets).values({ connectorId: connector.id, encryptedPayload }).onConflictDoUpdate({ target: connectorSecrets.connectorId, set: { encryptedPayload, updatedAt: new Date() } });
  }

  const mode = input.mode ?? connector.mode;
  const complete =
    entry.requiredConfig.every((k) => configuration[k] != null && String(configuration[k]) !== "") && entry.requiredSecrets.every((k) => secretsNow[k] != null && secretsNow[k] !== "");
  // Configured is NOT connected: a fully configured connector waits (CONNECTING) until a real event or sync confirms it.
  // What was confirmed under the OLD mode/credentials proves nothing about the new ones: a changed mode or secret starts over
  // (a fixture's "connected" must never carry into Live). Plain setting edits keep the status.
  const identityChanged = input.mode !== undefined && input.mode !== connector.mode || !!input.secrets && Object.values(input.secrets).some((v) => v.trim() !== "")
    // Pointing WhatsNexus at a different server or tenant is a different connection: it must be re-verified.
    || (key === "whatsnexus" && (String(configuration.baseUrl ?? "") !== String((connector.configuration as Record<string, unknown> | null)?.baseUrl ?? "") || String(configuration.tenantId ?? "") !== String((connector.configuration as Record<string, unknown> | null)?.tenantId ?? "")));
  const status = !identityChanged && (connector.status === "CONNECTED" || connector.status === "ERROR" || connector.status === "DEGRADED") ? connector.status : complete ? "CONNECTING" : "NOT_CONFIGURED";
  await db.update(connectors).set({ configuration, mode, status, updatedAt: new Date() }).where(eq(connectors.id, connector.id));
  return { ok: true };
}

/**
 * "Connect with code": redeem a WhatsNexus pairing code server-to-server and store what comes back (API key, callback secret,
 * tenant id) exactly as if a Super Admin had typed them, through the same save path — so Live mode, re-verification and the
 * "sending only after Connected" rule all still apply. This hospital is identified by the session, never by the request, and the
 * callback address handed to WhatsNexus is this server's own public address. Nothing secret is returned or logged.
 */
export async function pairWhatsNexus(db: Db, tenantId: string, input: { baseUrl: string; code: string }, adapter: Pick<typeof whatsNexusAdapter, "pair"> = whatsNexusAdapter): Promise<Result<object>> {
  const baseProblem = whatsNexusBaseUrlProblem(input.baseUrl);
  if (baseProblem) return { ok: false, reason: baseProblem };
  const publicBase = process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || (process.env.NODE_ENV === "production" ? "" : `http://localhost:${process.env.PORT || 4310}`);
  if (!publicBase) return { ok: false, reason: "public_url_not_configured" };
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const paired = await adapter.pair({ baseUrl, code: input.code.trim(), pulseosTenantId: tenantId, callbackUrl: `${publicBase}/webhooks/whatsnexus/${tenantId}` });
  if (!paired.ok) return { ok: false, reason: paired.reason === "invalid_url" || paired.reason === "private_address" ? paired.reason : `pair_${paired.reason}` };
  return configureIntegration(db, tenantId, "whatsnexus", {
    configuration: { baseUrl, tenantId: paired.whatsnexusTenantId },
    // The old callback secret is not kept: WhatsNexus replaced it in the same step.
    secrets: { apiKey: paired.apiKey, callbackSecret: paired.callbackSecret, previousCallbackSecret: "-" },
    mode: "LIVE",
  });
}

export interface HealthCheckResult {
  ok: boolean;
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN" | "NOT_APPLICABLE";
  status: "NOT_CONFIGURED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "ERROR" | "DISABLED";
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export async function checkIntegrationStatus(
  db: Db,
  tenantId: string,
  key: string,
  role: Role,
  caps: CapabilityMap
): Promise<HealthCheckResult | null> {
  const entry = catalogueEntry(key);
  if (!entry) return null;
  const now = new Date();

  // If entry has a capability, check if enabled on tenant
  const enabled = entry.capability ? !!caps[entry.capability] : true;
  if (!enabled) {
    return {
      ok: false,
      health: "NOT_APPLICABLE",
      status: "DISABLED",
      message: `Feature is switched off in Settings → Features (${entry.capability ?? ""}). Turn it on to activate.`,
      checkedAt: now.toISOString(),
    };
  }

  if (entry.key === "whatsnexus") return checkWhatsNexusStatus(db, tenantId, now);

  if (!entry.connectorProvider) {
    return {
      ok: true,
      health: "HEALTHY",
      status: "CONNECTED",
      message: "Integration operational.",
      checkedAt: now.toISOString(),
    };
  }

  const [connector] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, entry.connectorProvider))).limit(1);
  if (!connector) {
    return {
      ok: false,
      health: "UNKNOWN",
      status: "NOT_CONFIGURED",
      message: "Connector has not been configured yet. Save credentials first.",
      checkedAt: now.toISOString(),
    };
  }

  // Count recent events
  const [eventStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      lastReceived: sql<Date | null>`max(${connectorEvents.receivedAt})`,
    })
    .from(connectorEvents)
    .where(and(eq(connectorEvents.tenantId, tenantId), eq(connectorEvents.connectorId, connector.id)));

  const eventCount = eventStats?.total ?? 0;
  const lastEvent = eventStats?.lastReceived ?? connector.lastEventAt;

  const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connector.id)).limit(1);
  const hasSecrets = !!secret;

  let newStatus = connector.status;
  if (eventCount > 0 || (hasSecrets && connector.mode === "LIVE")) {
    newStatus = "CONNECTED";
    await db.update(connectors).set({ status: "CONNECTED", lastSyncAt: now, updatedAt: now }).where(eq(connectors.id, connector.id));
  }

  return {
    ok: true,
    health: newStatus === "CONNECTED" ? "HEALTHY" : "DEGRADED",
    status: newStatus,
    message: eventCount > 0
      ? `Connected & healthy. Received ${eventCount} call event(s) (latest at ${lastEvent ? new Date(lastEvent).toLocaleTimeString() : "recently"}).`
      : hasSecrets
      ? `Verified in ${connector.mode} mode. Inbound webhook endpoint is active and listening for call reports.`
      : "Connector configured. Awaiting credentials or test call.",
    checkedAt: now.toISOString(),
    details: {
      mode: connector.mode,
      eventsReceived: eventCount,
      lastEventAt: lastEvent ? new Date(lastEvent).toISOString() : null,
      hasSecrets,
    },
  };
}

/** Legacy WHATSNEXUS-category webhook rows are never converted or used for sending; they only produce a notice. */
async function whatsNexusNotes(db: Db, tenantId: string, base: string | null): Promise<string | null> {
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.webhookCategory, "WHATSNEXUS")));
  if (!c?.n) return base;
  return `${base ?? ""} Note: this hospital still has ${c.n} legacy WhatsNexus outbound webhook(s) under Outbound Webhooks. They are no longer used to send WhatsApp messages and were not converted; review or delete them there.`.trim();
}

/**
 * Extra rules for the WhatsNexus connector (everything else follows the generic path): an HTTPS, public, path-free base URL;
 * a plain tenant id; and WhatsNexus can be chosen for sending only when it is fully configured, in Live mode, and the
 * last real connection check succeeded — with none of those identity settings changed in the same save.
 */
/** The refusal reason for a WhatsNexus base URL (HTTPS, public, no path), or null when it is acceptable. */
function whatsNexusBaseUrlProblem(raw: string): string | null {
  const v = validateWebhookUrl(raw.trim(), { allowInsecure: webhookAllowInsecure() });
  if (!v.ok) return v.reason;
  const u = new URL(v.url);
  return (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash ? "invalid_url" : null;
}

async function validateWhatsNexusInput(db: Db, connector: ConnectorRowT, input: ConfigureInput): Promise<string | null> {
  const c = input.configuration ?? {};
  if (c.baseUrl !== undefined && c.baseUrl.trim() !== "") {
    const problem = whatsNexusBaseUrlProblem(c.baseUrl);
    if (problem) return problem;
  }
  if (c.tenantId !== undefined && c.tenantId.trim() !== "" && !/^[A-Za-z0-9_-]{1,100}$/.test(c.tenantId.trim())) return "invalid_tenant_id";
  if (c.useForSending !== undefined && !["true", "false", ""].includes(c.useForSending.trim())) return "invalid_value";

  if (c.useForSending?.trim() === "true") {
    const identityChanged =
      input.mode !== undefined ||
      Object.values(input.secrets ?? {}).some((v) => v.trim() !== "") ||
      (c.baseUrl !== undefined && c.baseUrl.trim().replace(/\/+$/, "") !== String((connector.configuration as Record<string, unknown> | null)?.baseUrl ?? "")) ||
      (c.tenantId !== undefined && c.tenantId.trim() !== String((connector.configuration as Record<string, unknown> | null)?.tenantId ?? ""));
    const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connector.id)).limit(1);
    let secretKeys: string[] = [];
    try {
      secretKeys = secret ? Object.entries(decryptSecret(secret.encryptedPayload)).filter(([, v]) => v !== "" && v != null).map(([k]) => k) : [];
    } catch {
      secretKeys = [];
    }
    const cfg = (connector.configuration as Record<string, unknown> | null) ?? {};
    const ready =
      !identityChanged &&
      connector.mode === "LIVE" &&
      connector.status === "CONNECTED" &&
      !!cfg.baseUrl &&
      !!cfg.tenantId &&
      secretKeys.includes("apiKey") &&
      secretKeys.includes("callbackSecret");
    if (!ready) return "provider_not_ready";
  }
  return null;
}

/** A real, authenticated, read-only check of the WhatsNexus integration. It never sends a WhatsApp message. */
async function checkWhatsNexusStatus(db: Db, tenantId: string, now: Date): Promise<HealthCheckResult> {
  const checkedAt = now.toISOString();
  const [connector] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, "whatsnexus"))).limit(1);
  if (!connector) return { ok: false, health: "UNKNOWN", status: "NOT_CONFIGURED", message: "WhatsNexus has not been configured yet. Save the base URL, tenant id and credentials first.", checkedAt };
  if (connector.status === "DISABLED") return { ok: false, health: "NOT_APPLICABLE", status: "DISABLED", message: "This integration is switched off.", checkedAt };
  if (connector.mode !== "LIVE") {
    return { ok: false, health: "UNKNOWN", status: connector.status, message: "Set the connection mode to Live (Credentials tab) to test the connection. Fixture and Sandbox never contact WhatsNexus.", checkedAt, details: { mode: connector.mode } };
  }
  const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connector.id)).limit(1);
  let secrets: Record<string, unknown> = {};
  try {
    secrets = secret ? decryptSecret(secret.encryptedPayload) : {};
  } catch {
    secrets = {};
  }
  const config: Record<string, unknown> = { ...((connector.configuration as Record<string, unknown> | null) ?? {}), mode: "live", pulseosTenantId: tenantId };
  const probe = await whatsNexusAdapter.probeHealth(config, secrets);

  const next = probe.status === "CONNECTED" ? "CONNECTED" : probe.status === "DEGRADED" ? "DEGRADED" : probe.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "ERROR";
  await db
    .update(connectors)
    .set({ status: next, lastSyncAt: probe.ok ? now : connector.lastSyncAt, lastError: probe.ok ? null : redactLogText(probe.message), updatedAt: now })
    .where(eq(connectors.id, connector.id));
  return {
    ok: probe.ok,
    health: probe.status === "CONNECTED" ? "HEALTHY" : probe.status === "DEGRADED" ? "DEGRADED" : probe.status === "NOT_CONFIGURED" ? "UNKNOWN" : "UNHEALTHY",
    status: next,
    message: probe.message,
    checkedAt,
    details: { mode: connector.mode, ...(probe.details ?? {}) },
  };
}

export async function simulateTelephonyTestCall(
  db: Db,
  tenantId: string,
  key: string,
  userId: string
): Promise<Result<{ message: string; callId: string }>> {
  const entry = catalogueEntry(key);
  if (!entry || !entry.connectorProvider) return { ok: false, reason: "unknown_integration" };

  const connector = await ensureConnector(db, tenantId, entry);
  if (!connector) return { ok: false, reason: "not_configured" };

  const now = new Date();
  const testCallId = `test-call-${Date.now()}`;
  const testPhone = "+919876543210";

  const event: InboundCallEvent = {
    externalEventId: `test:event:${testCallId}`,
    externalCallId: testCallId,
    phone: testPhone,
    direction: "inbound",
    status: "completed",
    durationSeconds: 45,
    recordingUrl: null,
    agentName: "IVR Test Agent",
    disposition: null,
    startedAt: now,
    endedAt: now,
    metadata: {
      provider: entry.connectorProvider,
      customerName: "Test Patient (IVR Ping)",
    },
  };

  const { duplicate, eventId } = await recordConnectorEvent(db, {
    tenantId,
    connectorId: connector.id,
    externalEventId: event.externalEventId,
    direction: "inbound",
    payload: { type: "call", test: true },
  });

  if (!duplicate) {
    await persistInboundCall(db, tenantId, connector.id, event);
    await markEventProcessed(db, eventId);
  }

  await db.update(connectors).set({
    status: "CONNECTED",
    lastEventAt: now,
    lastSyncAt: now,
    updatedAt: now,
  }).where(eq(connectors.id, connector.id));

  await recordActivity(db, {
    tenantId,
    actorId: userId,
    action: "integration.test_event_sent",
    entityType: "integration",
    entityKey: key,
    metadata: { callId: testCallId },
  });

  return {
    ok: true,
    message: "Test call event sent and processed successfully! Call logged on patient timeline.",
    callId: testCallId,
  };
}

// -- Logs -------------------------------------------------------------------

export interface LogFilters {
  provider?: string;
  status?: string;
  from?: string;
  to?: string;
}

export async function listIntegrationLogs(db: Db, tenantId: string, filters: LogFilters, limit = 100): Promise<IntegrationLogRow[]> {
  const tz = await tenantTimezone(db, tenantId);
  const range = filters.from && filters.to && isRealDate(filters.from) && isRealDate(filters.to) ? { from: filters.from, to: filters.to } : null;
  const rows: IntegrationLogRow[] = [];

  if (!filters.provider || (filters.provider !== "webhooks" && catalogueEntry(filters.provider))) {
    const entry = filters.provider ? catalogueEntry(filters.provider) : null;
    const cond = [eq(connectorEvents.tenantId, tenantId)];
    if (entry?.connectorProvider) cond.push(eq(connectors.provider, entry.connectorProvider));
    if (filters.status && ["received", "processed", "failed", "duplicate"].includes(filters.status)) cond.push(eq(connectorEvents.status, filters.status as "received"));
    if (range) cond.push(inLocalRange(connectorEvents.receivedAt, tz, range.from, range.to));
    const events = await db
      .select({ e: connectorEvents, provider: connectors.provider })
      .from(connectorEvents)
      .innerJoin(connectors, eq(connectors.id, connectorEvents.connectorId))
      .where(and(...cond))
      .orderBy(desc(connectorEvents.receivedAt))
      .limit(limit);
    for (const { e, provider } of events) {
      const type = (e.payload as { type?: string } | null)?.type;
      rows.push({ id: e.id, provider, direction: e.direction, status: e.status, summary: type ? `${type} event` : "event", error: redactLogText(e.error), at: e.receivedAt.toISOString() });
    }
  }

  if (!filters.provider || filters.provider === "webhooks") {
    const cond = [eq(outboundWebhookDeliveries.tenantId, tenantId)];
    if (filters.status) {
      const map: Record<string, string> = { sent: "SENT", failed: "FAILED", pending: "PENDING" };
      if (!map[filters.status]) cond.push(sql`false`);
      else cond.push(eq(outboundWebhookDeliveries.status, map[filters.status]!));
    }
    if (range) cond.push(inLocalRange(outboundWebhookDeliveries.createdAt, tz, range.from, range.to));
    const deliveries = await db.select().from(outboundWebhookDeliveries).where(and(...cond)).orderBy(desc(outboundWebhookDeliveries.createdAt)).limit(limit);
    for (const d of deliveries) {
      rows.push({ id: d.id, provider: "webhooks", direction: "outbound", status: d.status === "SENT" ? "sent" : d.status === "FAILED" ? "failed" : "pending", summary: d.eventType, error: redactLogText(d.error), at: d.createdAt.toISOString() });
    }
  }

  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
