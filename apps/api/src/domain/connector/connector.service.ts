import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectorEvents, connectors, connectorSecrets } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../security/encryption.js";
import type { ConnectorDetail, ConnectorRow, ConnectorStatus } from "@pulseos/types";

function toRow(c: typeof connectors.$inferSelect, hasSecrets: boolean): ConnectorRow {
  return {
    id: c.id,
    type: c.type,
    provider: c.provider,
    displayName: c.displayName,
    status: c.status,
    mode: c.mode,
    capabilities: c.capabilities,
    hasSecrets,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastEventAt: c.lastEventAt?.toISOString() ?? null,
    lastError: c.lastError,
  };
}

export async function listConnectors(db: Db, tenantId: string): Promise<ConnectorRow[]> {
  const rows = await db.select().from(connectors).where(eq(connectors.tenantId, tenantId)).orderBy(connectors.type, connectors.displayName);
  if (rows.length === 0) return [];

  const secretRows = await db.select({ connectorId: connectorSecrets.connectorId }).from(connectorSecrets);
  const withSecrets = new Set(secretRows.map((s) => s.connectorId));
  return rows.map((c) => toRow(c, withSecrets.has(c.id)));
}

async function findConnector(db: Db, tenantId: string, connectorId: string) {
  const [row] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, connectorId))).limit(1);
  return row ?? null;
}

export async function getConnectorDetail(db: Db, tenantId: string, connectorId: string): Promise<ConnectorDetail | null> {
  const connector = await findConnector(db, tenantId, connectorId);
  if (!connector) return null;

  const [secret] = await db.select({ connectorId: connectorSecrets.connectorId }).from(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId)).limit(1);

  const eventRows = await db
    .select()
    .from(connectorEvents)
    .where(eq(connectorEvents.connectorId, connectorId))
    .orderBy(desc(connectorEvents.receivedAt))
    .limit(20);

  return {
    connector: toRow(connector, !!secret),
    configuration: (connector.configuration as Record<string, unknown> | null) ?? null,
    recentEvents: eventRows.map((e) => ({
      id: e.id,
      externalEventId: e.externalEventId,
      direction: e.direction,
      status: e.status,
      error: e.error,
      receivedAt: e.receivedAt.toISOString(),
    })),
  };
}

export interface UpsertConnectorConfigInput {
  displayName?: string;
  configuration?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

export async function upsertConnectorConfig(
  db: Db,
  tenantId: string,
  connectorId: string,
  input: UpsertConnectorConfigInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const connector = await findConnector(db, tenantId, connectorId);
  if (!connector) return { ok: false, reason: "connector_not_found" };

  if (input.secrets) {
    const encryptedPayload = encryptSecret(input.secrets);
    await db
      .insert(connectorSecrets)
      .values({ connectorId, encryptedPayload })
      .onConflictDoUpdate({ target: connectorSecrets.connectorId, set: { encryptedPayload, updatedAt: new Date() } });
  }

  const [hasSecretsNow] = await db.select({ connectorId: connectorSecrets.connectorId }).from(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId)).limit(1);
  const hasConfig = !!(input.configuration ?? connector.configuration);
  const nextStatus: ConnectorStatus = hasSecretsNow && hasConfig ? "CONNECTED" : connector.status === "CONNECTED" ? "CONNECTED" : "NOT_CONFIGURED";

  await db
    .update(connectors)
    .set({
      displayName: input.displayName ?? connector.displayName,
      configuration: input.configuration ?? connector.configuration,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(eq(connectors.id, connectorId));

  return { ok: true };
}

export async function getConnectorSecrets(db: Db, connectorId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId)).limit(1);
  if (!row) return null;
  return decryptSecret(row.encryptedPayload);
}

export async function getConnectorByTenantAndProvider(db: Db, tenantId: string, provider: string) {
  const [row] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, provider))).limit(1);
  return row ?? null;
}

export async function getConnectorById(db: Db, connectorId: string) {
  const [row] = await db.select().from(connectors).where(eq(connectors.id, connectorId)).limit(1);
  return row ?? null;
}

export async function touchConnectorSuccess(db: Db, connectorId: string): Promise<void> {
  await db
    .update(connectors)
    .set({ lastEventAt: new Date(), lastSyncAt: new Date(), lastError: null, status: sql`case when ${connectors.status} = 'DISABLED' then ${connectors.status} else 'CONNECTED'::connector_status end`, updatedAt: new Date() })
    .where(eq(connectors.id, connectorId));
}

export async function touchConnectorError(db: Db, connectorId: string, error: string): Promise<void> {
  await db
    .update(connectors)
    .set({ lastError: error, status: "ERROR", updatedAt: new Date() })
    .where(eq(connectors.id, connectorId));
}
