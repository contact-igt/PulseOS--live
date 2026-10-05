import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { gbpPerformanceMetrics } from "../../db/schema.js";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { getAcquisitionAdapter } from "../connector/registry.js";

export type SyncPerformanceResult =
  | { ok: true; syncedCount: number }
  | { ok: false; reason: "connector_not_found" | "unsupported_capability" | "sync_failed"; message?: string };

// Persists Google Business Profile's aggregate listing metrics only —
// writes exclusively to gbp_performance_metrics, which has no
// patientId/journeyId/touchpoint column of any kind. Structurally cannot
// create, update, or reference a Patient, by design (Group AH's core rule).
export async function syncConnectorPerformance(db: Db, tenantId: string, connectorId: string): Promise<SyncPerformanceResult> {
  const connector = await getConnectorById(db, connectorId);
  if (!connector || connector.tenantId !== tenantId) {
    return { ok: false, reason: "connector_not_found" };
  }

  const adapter = getAcquisitionAdapter(connector.provider);
  if (!adapter?.syncPerformance || !connector.capabilities.includes("SYNC_PERFORMANCE")) {
    return { ok: false, reason: "unsupported_capability" };
  }

  const secrets = (await getConnectorSecrets(db, connectorId)) ?? {};
  const config = { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase() };

  try {
    const records = await adapter.syncPerformance(config, secrets);

    for (const record of records) {
      const [existing] = await db
        .select({ id: gbpPerformanceMetrics.id })
        .from(gbpPerformanceMetrics)
        .where(and(eq(gbpPerformanceMetrics.connectorId, connectorId), eq(gbpPerformanceMetrics.metricDate, record.metricDate)))
        .limit(1);

      const values = {
        impressions: record.impressions,
        clicks: record.clicks,
        searchImpressions: record.searchImpressions,
        websiteClicks: record.websiteClicks,
        callClicks: record.callClicks,
        directionRequests: record.directionRequests,
      };

      if (existing) {
        await db.update(gbpPerformanceMetrics).set(values).where(eq(gbpPerformanceMetrics.id, existing.id));
      } else {
        await db.insert(gbpPerformanceMetrics).values({ tenantId, connectorId, metricDate: record.metricDate, ...values });
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
