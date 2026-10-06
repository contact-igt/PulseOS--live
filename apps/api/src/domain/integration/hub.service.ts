import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { communicationEndpoints, connectorEvents, connectors, connectorSecrets, outboundWebhookDeliveries, outboundWebhooks } from "../../db/schema.js";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "../security/encryption.js";
import { readSecretFacts } from "./secret-facts.js";
import { getPayloadShapes, getTelephonyCallDetail, listRecentCalls } from "./telephony-calls.js";
import { inLocalRange, isRealDate, tenantTimezone } from "../../lib/hospital-time.js";
import { hasPermission, type CapabilityMap, type IntegrationCard, type IntegrationDetail, type IntegrationLogRow, type Role } from "@pulseos/types";
import { redactLogText } from "../security/redact.js";
import { listSyncRuns } from "../ads/ads-sync.service.js";
import { ADS_PROVIDERS, type AdsProvider } from "@pulseos/types";
import { INTEGRATION_CATALOGUE, catalogueEntry, type CatalogueEntry } from "./hub-catalogue.js";
import { deriveConfiguration, deriveHealth, deriveMode, type ConnectorFacts } from "./hub-state.js";
import { recordConnectorEvent, markEventProcessed } from "../connector/connector-event.service.js";
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
    // Only the NAMES of stored secrets leave this function, never a value. A row that cannot be opened (key missing or
    // changed) is "unreadable", which is not the same as nothing saved.
    const { keys: secretKeys, unreadable: secretsUnreadable } = readSecretFacts(secret?.encryptedPayload);
    const phoneNumbers = endpoints
      .filter((e) => e.connectorId === row.id)
      .map((e) => ({ number: e.publicNumber, label: e.displayLabel, active: e.isActive }));
    out.set(row.provider, { row, facts: { status: row.status, mode: row.mode, configuration: (row.configuration as Record<string, unknown> | null) ?? null, secretKeys, secretsUnreadable }, phoneNumbers });
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
  if (entry.key === "whatsnexus") configuration = wh.whatsNexusTotal > 0 ? "CONFIGURED" : "NOT_CONFIGURED";

  const mode =
    entry.key === "webhooks"
      ? wh.total === 0 ? "NOT_CONFIGURED" : wh.enabled === 0 ? "DISABLED" : wh.lastDelivery === "SENT" ? "LIVE_CONFIGURED" : "LIVE_CAPABLE"
      : entry.key === "whatsnexus"
      ? wh.whatsNexusTotal === 0 ? "NOT_CONFIGURED" : wh.whatsNexusEnabled === 0 ? "DISABLED" : "LIVE_CONFIGURED"
      : deriveMode(entry, enabled, configuration, facts);

  const health =
    entry.key === "webhooks"
      ? wh.lastDelivery === "SENT" ? "HEALTHY" : wh.lastDelivery === "FAILED" ? "UNHEALTHY" : wh.total > 0 ? "UNKNOWN" : "NOT_APPLICABLE"
      : entry.key === "whatsnexus"
      ? wh.whatsNexusEnabled > 0 ? "HEALTHY" : "NOT_APPLICABLE"
      : deriveHealth(entry, facts);

  const isConnected =
    (found?.row.status === "CONNECTED" && !(found.facts.secretsUnreadable && found.facts.mode !== "FIXTURE") && (!entry.requiredAnySecret || configuration === "CONFIGURED")) ||
    (entry.key === "whatsnexus" && wh.whatsNexusEnabled > 0) ||
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
  return INTEGRATION_CATALOGUE.map((e) => card(e, caps, role, e.connectorProvider ? facts.get(e.connectorProvider) : undefined, wh));
}

/**
 * `requestOrigin` is where this very request reached the API (protocol + host). It is the fallback for the webhook URL shown to the
 * operator when PUBLIC_API_BASE_URL is not set, so the URL is always complete enough to paste into a provider.
 */
export async function getHubDetail(db: Db, tenantId: string, role: Role, caps: CapabilityMap, key: string, requestOrigin?: string): Promise<IntegrationDetail | null> {
  const entry = catalogueEntry(key);
  if (!entry) return null;
  const facts = await loadFacts(db, tenantId);
  const found = entry.connectorProvider ? facts.get(entry.connectorProvider) : undefined;
  const base = card(entry, caps, role, found, await webhookFacts(db, tenantId));

  const [wnHook] =
    entry.key === "whatsnexus"
      ? await db.select().from(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.webhookCategory, "WHATSNEXUS"))).limit(1)
      : [];

  const config = wnHook ? { webhookUrl: wnHook.url, endpointPath: wnHook.endpointPath ?? "" } : (found?.facts.configuration ?? {});
  const base_ = process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || requestOrigin || (process.env.NODE_ENV === "production" ? "" : `http://localhost:${process.env.PORT || 4310}`);
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
  const recentCalls = isTelephony && found ? await listRecentCalls(db, tenantId, found.row.id) : undefined;

  return {
    ...base,
    configurationFields: entry.configurationFields,
    configurationValues: Object.fromEntries(entry.configurationFields.map((f) => [f.key, (config as any)[f.key] == null ? "" : String((config as any)[f.key])])),
    secretFields: entry.secretFields.map((f) => ({
      ...f,
      hasSecret: entry.key === "whatsnexus" ? !!(wnHook?.headers as any[])?.some((h) => h.key === "x-api-key" && h.value) : !!found?.facts.secretKeys.includes(f.key),
    })),
    secretsUnreadable: !!found?.facts.secretsUnreadable,
    connectorId: isTelephony ? found?.row.id ?? null : undefined,
    inbound: isTelephony && found ? inboundState(entry, base.enabled, found, await lastRealEventAt(db, tenantId, found.row.id)) : undefined,
    mappingNotes: entry.mappingNotes,
    syncRuns: (ADS_PROVIDERS as readonly string[]).includes(entry.key) ? await listSyncRuns(db, tenantId, entry.key as AdsProvider) : undefined,
    recentCalls,
    webhookUrl: webhookPath ? `${base_}${webhookPath}` : null,
    connectorMode: found?.row.mode ?? null,
  };
}

/**
 * Inbound-webhook readiness, as four separate facts. Credentials: are keys saved, and can this server read them.
 * Webhook: would it accept a correctly authenticated call report right now. Last valid event: the last call report that
 * authenticated and was processed (not a status someone typed). None of these claims a connection PulseOS cannot see.
 */
function inboundState(entry: CatalogueEntry, enabled: boolean, found: { row: ConnectorRowT; facts: ConnectorFacts }, lastValidEventAt: Date | null): NonNullable<IntegrationDetail["inbound"]> {
  const keys = entry.requiredAnySecret ?? entry.requiredSecrets;
  const credentials = found.facts.secretsUnreadable ? "UNREADABLE" : keys.some((k) => found.facts.secretKeys.includes(k)) ? "SAVED" : "NOT_CONFIGURED";
  const disabled = found.row.status === "DISABLED";
  const webhook = enabled && !disabled && credentials === "SAVED" ? "READY" : "NOT_READY";
  const note =
    credentials === "UNREADABLE"
      ? "Saved credentials cannot be read by this server, so every call report is refused until they are re-entered."
      : credentials === "NOT_CONFIGURED"
      ? "Call reports are refused until at least one key is saved: PulseOS will not accept unauthenticated calls."
      : !enabled || disabled
      ? "Switched off: call reports are acknowledged and ignored."
      : entry.key === "ccs_ivr"
      ? "Each call report must carry a saved key: as a header, or add ?api_key=<key> to the webhook URL pasted into CCS."
      : "Each call report must carry the saved shared secret in its x-api-key header.";
  return { webhook, credentials, lastValidEventAt: lastValidEventAt?.toISOString() ?? null, note };
}

/** The last call report that authenticated and was processed. The "send test call" button's simulated events do not count. */
async function lastRealEventAt(db: Db, tenantId: string, connectorId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${connectorEvents.receivedAt})` })
    .from(connectorEvents)
    .where(and(eq(connectorEvents.tenantId, tenantId), eq(connectorEvents.connectorId, connectorId), eq(connectorEvents.status, "processed"), sql`coalesce(${connectorEvents.payload}->>'test', 'false') <> 'true'`));
  return row?.at ? new Date(row.at) : null;
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

  if (key === "whatsnexus") {
    const url = input.configuration?.webhookUrl?.trim();
    if (!url) return { ok: false, reason: "invalid_url" };
    const endpointPath = input.configuration?.endpointPath?.trim() || null;
    const apiKey = input.secrets?.apiKey?.trim();
    const headers = apiKey ? [{ key: "x-api-key", value: apiKey }] : [];
    const [existing] = await db
      .select()
      .from(outboundWebhooks)
      .where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.webhookCategory, "WHATSNEXUS")))
      .limit(1);

    if (existing) {
      await db
        .update(outboundWebhooks)
        .set({
          url,
          endpointPath,
          headers: headers.length > 0 ? headers : existing.headers,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(outboundWebhooks.id, existing.id));
    } else {
      await db.insert(outboundWebhooks).values({
        tenantId,
        name: "WhatsNexus WhatsApp",
        url,
        endpointPath,
        httpMethod: "POST",
        headers,
        payloadMapping: [
          { key: "call_Id", field: "call_Id" },
          { key: "customerName", field: "customerName" },
          { key: "phoneNumber", field: "phoneNumber" },
          { key: "agentName", field: "agentName" },
          { key: "createdAt", field: "createdAt" },
          { key: "status", field: "status" },
          { key: "typeOfEnquiry", field: "typeOfEnquiry" },
          { key: "source", field: "source" },
          { key: "templateName", field: "templateName" },
          { key: "message", field: "message" },
        ],
        webhookCategory: "WHATSNEXUS",
        events: ["whatsapp.followup_requested", "interaction.logged"],
        conditions: [],
        enabled: true,
        encryptedSecret: encryptSecret({ signingSecret: "whsec_whatsnexus" }),
      });
    }
    return { ok: true };
  }

  if (entry.blockedReason || !entry.connectorProvider) return { ok: false, reason: "blocked" };
  // Refuse before touching anything: a save that needs to encrypt cannot succeed without a key, and must not leave a
  // half-written connector behind. (The caller maps this to a 503 with a safe message.)
  const writesSecrets = Object.values(input.secrets ?? {}).some((v) => v.trim() !== "");
  if (writesSecrets && !isEncryptionConfigured()) return { ok: false, reason: "encryption_not_configured" };
  const connector = await ensureConnector(db, tenantId, entry);
  if (!connector) return { ok: false, reason: "blocked" };

  const configKeys = new Set(entry.configurationFields.map((f) => f.key));
  const secretKeys = new Set(entry.secretFields.map((f) => f.key));
  for (const k of Object.keys(input.configuration ?? {})) if (!configKeys.has(k)) return { ok: false, reason: "unknown_field" };
  for (const k of Object.keys(input.secrets ?? {})) if (!secretKeys.has(k)) return { ok: false, reason: "unknown_field" };

  let configuration = (connector.configuration as Record<string, unknown> | null) ?? {};
  if (input.configuration) {
    configuration = { ...configuration };
    for (const [k, v] of Object.entries(input.configuration)) {
      if (v.trim() === "") delete configuration[k];
      else configuration[k] = v.trim();
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
  let encryptedPayload: string | null = null;
  if (input.secrets) {
    secretsNow = { ...secretsNow };
    for (const [k, v] of Object.entries(input.secrets)) if (v.trim() !== "") secretsNow[k] = v.trim();
    // Only write when a value was actually entered: blank means "keep what is stored", never "store an empty payload".
    if (writesSecrets) encryptedPayload = encryptSecret(secretsNow);
  }

  const mode = input.mode ?? connector.mode;
  const complete =
    entry.requiredConfig.every((k) => configuration[k] != null && String(configuration[k]) !== "") && entry.requiredSecrets.every((k) => secretsNow[k] != null && secretsNow[k] !== "");
  // Configured is NOT connected: a fully configured connector waits (CONNECTING) until a real event or sync confirms it.
  // What was confirmed under the OLD mode/credentials proves nothing about the new ones: a changed mode or secret starts over
  // (a fixture's "connected" must never carry into Live). Plain setting edits keep the status.
  const identityChanged = input.mode !== undefined && input.mode !== connector.mode || !!input.secrets && Object.values(input.secrets).some((v) => v.trim() !== "");
  const status = !identityChanged && (connector.status === "CONNECTED" || connector.status === "ERROR" || connector.status === "DEGRADED") ? connector.status : complete ? "CONNECTING" : "NOT_CONFIGURED";
  // The secrets upsert and the connector row move together: no new credentials with the old status, or the reverse.
  await db.transaction(async (tx) => {
    if (encryptedPayload) {
      await tx.insert(connectorSecrets).values({ connectorId: connector.id, encryptedPayload }).onConflictDoUpdate({ target: connectorSecrets.connectorId, set: { encryptedPayload, updatedAt: new Date() } });
    }
    await tx.update(connectors).set({ configuration, mode, status, updatedAt: new Date() }).where(eq(connectors.id, connector.id));
  });
  return { ok: true };
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

  if (entry.key === "whatsnexus") {
    const [wh] = await db.select().from(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.webhookCategory, "WHATSNEXUS"))).limit(1);
    if (!wh || !wh.enabled) {
      return {
        ok: false,
        health: "UNKNOWN",
        status: "NOT_CONFIGURED",
        message: "WhatsNexus webhook is not configured yet. Set up the endpoint URL and API key.",
        checkedAt: now.toISOString(),
      };
    }
    return {
      ok: true,
      health: "HEALTHY",
      status: "CONNECTED",
      message: "WhatsNexus outbound webhook is active and enabled.",
      checkedAt: now.toISOString(),
      details: { url: wh.url, endpointPath: wh.endpointPath },
    };
  }

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
  const sf = readSecretFacts(secret?.encryptedPayload);
  const secretsUnreadable = sf.unreadable;
  // A provider that authenticates its callers with a stored key refuses every call until one is saved: old events say nothing now.
  const needsKey = !!entry.requiredAnySecret && !secretsUnreadable && !entry.requiredAnySecret.some((k) => sf.keys.includes(k));
  if (needsKey) {
    return {
      ok: false,
      health: "UNKNOWN",
      status: connector.status,
      message: "No key is saved, so call reports are refused until at least one key is saved. Save a key in Credentials.",
      checkedAt: now.toISOString(),
      details: { mode: connector.mode, eventsReceived: eventCount, lastEventAt: lastEvent ? new Date(lastEvent).toISOString() : null, hasSecrets, secretsUnreadable },
    };
  }

  // Connected means a real call report arrived. Stored credentials prove nothing about the provider: PulseOS only
  // RECEIVES from CCS/Runo (there is no outbound API call to verify them with), so a secrets row never upgrades the status.
  let newStatus = connector.status;
  if (eventCount > 0 && !secretsUnreadable) {
    newStatus = "CONNECTED";
    await db.update(connectors).set({ status: "CONNECTED", lastSyncAt: now, updatedAt: now }).where(eq(connectors.id, connector.id));
  }

  const health: HealthCheckResult["health"] = secretsUnreadable
    ? "DEGRADED"
    : newStatus === "CONNECTED" ? "HEALTHY" : newStatus === "ERROR" ? "UNHEALTHY" : newStatus === "DEGRADED" ? "DEGRADED" : "UNKNOWN";

  return {
    ok: !secretsUnreadable,
    health,
    status: newStatus,
    message: secretsUnreadable
      ? "Saved credentials cannot be read by this server (its encryption key is missing or has changed). Re-enter the credentials and save to fix it."
      : eventCount > 0
      ? `Connected & healthy. Received ${eventCount} call event(s) (latest at ${lastEvent ? new Date(lastEvent).toLocaleTimeString() : "recently"}).`
      : hasSecrets
      ? `Credentials are saved (${connector.mode} mode). Waiting for the first call report to confirm the connection — PulseOS cannot verify credentials with the provider directly.`
      : "Connector configured. Awaiting a first call report.",
    checkedAt: now.toISOString(),
    details: {
      mode: connector.mode,
      eventsReceived: eventCount,
      lastEventAt: lastEvent ? new Date(lastEvent).toISOString() : null,
      hasSecrets,
      secretsUnreadable,
    },
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
      simulated: true,
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

/** The connector row behind a telephony catalogue key for this tenant, or null (not telephony, or not set up yet). */
async function telephonyConnectorId(db: Db, tenantId: string, key: string): Promise<string | null> {
  const entry = catalogueEntry(key);
  if (!entry || !entry.connectorProvider || !(key === "ccs_ivr" || key === "runo")) return null;
  const [row] = await db.select({ id: connectors.id }).from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, entry.connectorProvider))).limit(1);
  return row?.id ?? null;
}

export async function getCallDetail(db: Db, tenantId: string, key: string, callId: string) {
  const connectorId = await telephonyConnectorId(db, tenantId, key);
  return connectorId ? getTelephonyCallDetail(db, tenantId, connectorId, callId) : null;
}

export async function getCcsPayloadShapes(db: Db, tenantId: string, key: string) {
  if (key !== "ccs_ivr") return null;
  const connectorId = await telephonyConnectorId(db, tenantId, key);
  return connectorId ? getPayloadShapes(db, tenantId, connectorId) : { events: 0, fields: [], values: {} };
}
