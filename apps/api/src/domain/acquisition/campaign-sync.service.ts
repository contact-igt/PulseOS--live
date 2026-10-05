import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { marketingCampaigns } from "../../db/schema.js";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { getAcquisitionAdapter } from "../connector/registry.js";

export type SyncCampaignsResult =
  | { ok: true; syncedCount: number }
  | { ok: false; reason: "connector_not_found" | "unsupported_capability" | "sync_failed"; message?: string };

// Pulls campaign/spend dimensions from a connector's own adapter (fixture
// data in FIXTURE mode, a real provider call in LIVE/SANDBOX mode — see
// each adapter's syncCampaigns) and upserts them into marketing_campaigns,
// find-or-create by (tenantId, externalCampaignId) exactly like
// attribution.service.ts's resolveCampaign — this is the same table, the
// same identity rule, just a bulk proactive sync instead of a reactive
// per-touchpoint lookup. connectorId is stamped on every synced row so
// downstream UI (Group AJ) can join back to the connector's mode and never
// display fixture spend as if it were real.
export async function syncConnectorCampaigns(db: Db, tenantId: string, connectorId: string): Promise<SyncCampaignsResult> {
  const connector = await getConnectorById(db, connectorId);
  if (!connector || connector.tenantId !== tenantId) {
    return { ok: false, reason: "connector_not_found" };
  }

  const adapter = getAcquisitionAdapter(connector.provider);
  if (!adapter?.syncCampaigns || !connector.capabilities.includes("SYNC_CAMPAIGNS")) {
    return { ok: false, reason: "unsupported_capability" };
  }

  const secrets = (await getConnectorSecrets(db, connectorId)) ?? {};
  const config = { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase() };

  try {
    const records = await adapter.syncCampaigns(config, secrets);

    for (const record of records) {
      const [existing] = await db
        .select({ id: marketingCampaigns.id })
        .from(marketingCampaigns)
        .where(and(eq(marketingCampaigns.tenantId, tenantId), eq(marketingCampaigns.externalCampaignId, record.externalCampaignId)))
        .limit(1);

      const values = {
        connectorId,
        source: record.source,
        name: record.name,
        externalAccountId: record.externalAccountId,
        spendAmount: record.spendAmount,
        currency: record.currency,
        startDate: record.startDate,
        endDate: record.endDate,
        status: record.status,
      };

      if (existing) {
        await db.update(marketingCampaigns).set(values).where(eq(marketingCampaigns.id, existing.id));
      } else {
        await db.insert(marketingCampaigns).values({ tenantId, externalCampaignId: record.externalCampaignId, ...values });
      }
    }

    await touchConnectorSuccess(db, connectorId);
    return { ok: true, syncedCount: records.length };
  } catch (err) {
    const message = (err as Error).message;
    await touchConnectorError(db, connectorId, message);
    return { ok: false, reason: "sync_failed", message };
  }
}
