import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { adsDailyFacts, adsSyncRuns, connectors } from "../../db/schema.js";
import { ADS_PROVIDERS, type AdsProvider, type AdsSyncRunVm, type Capability } from "@pulseos/types";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { addDays, localToday, tenantTimezone } from "../../lib/hospital-time.js";
import { redactLogText } from "../security/redact.js";
import { catalogueEntry } from "../integration/hub-catalogue.js";
import { deriveConfiguration } from "../integration/hub-state.js";
import { readSecretFacts } from "../integration/secret-facts.js";
import { connectorSecrets } from "../../db/schema.js";
import { getAdsProvider } from "./registry.js";
import { TransientAdsError, type AdsReportingProvider } from "./types.js";

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

export const CAPABILITY_FOR: Record<AdsProvider, Capability> = { google_ads: "GOOGLE_ADS", meta_ads: "META_ADS" };
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];
/** Providers restate recent days (late conversions, invoicing corrections), so every incremental sync re-reads the last week. */
const RESTATEMENT_DAYS = 7;
const FIRST_SYNC_DAYS = 30;
const MAX_RANGE_DAYS = 92;
const MANUAL_COOLDOWN_MS = 60_000;
const STALE_RUNNING_MS = 10 * 60_000;
export const SCHEDULED_SYNC_EVERY_MS = 6 * 3_600_000;
const SCHEDULED_RETRY_AFTER_FAILURE_MS = 30 * 60_000;

const runVm = (r: typeof adsSyncRuns.$inferSelect): AdsSyncRunVm => ({
  id: r.id, status: r.status as AdsSyncRunVm["status"], trigger: r.trigger as AdsSyncRunVm["trigger"], rangeFrom: r.rangeFrom, rangeTo: r.rangeTo,
  rowsUpserted: r.rowsUpserted, attempts: r.attempts, error: r.error, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
});

export async function listSyncRuns(db: Db, tenantId: string, provider: AdsProvider, limit = 5): Promise<AdsSyncRunVm[]> {
  const rows = await db.select().from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, provider))).orderBy(desc(adsSyncRuns.startedAt)).limit(limit);
  return rows.map(runVm);
}

async function connectorFor(db: Db, tenantId: string, provider: AdsProvider) {
  const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, provider))).limit(1);
  return c ?? null;
}

type ConfiguredState = { configured: boolean; unusable: "encryption_not_configured" | "secrets_unreadable" | null };

async function configuredState(db: Db, provider: AdsProvider, c: typeof connectors.$inferSelect): Promise<ConfiguredState> {
  const entry = catalogueEntry(provider)!;
  const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, c.id)).limit(1);
  const sf = readSecretFacts(secret?.encryptedPayload);
  // Fixture mode never reads credentials, so unreadable ones do not block it.
  if (sf.reason && c.mode !== "FIXTURE") return { configured: false, unusable: sf.reason };
  return { configured: deriveConfiguration(entry, { status: c.status, mode: c.mode, configuration: (c.configuration as Record<string, unknown> | null) ?? null, secretKeys: sf.keys, secretsUnreadable: sf.unreadable }) === "CONFIGURED", unusable: null };
}

export interface SyncOptions {
  trigger: "MANUAL" | "SCHEDULED";
  now?: Date;
  range?: { from: string; to: string };
  adapter?: AdsReportingProvider | null;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Pull read-only reporting from one ads provider into normalized daily facts. Idempotent (same day overwrites), bounded retry
 * on transient provider errors, and a failure never touches what is already stored: the previous snapshot stays in use.
 */
export async function syncAds(db: Db, tenantId: string, provider: AdsProvider, opts: SyncOptions): Promise<Result<{ run: AdsSyncRunVm }>> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const caps = await tenantCapabilityMap(db, tenantId);
  if (!caps[CAPABILITY_FOR[provider]]) return { ok: false, reason: "feature_not_available" };
  const adapter = opts.adapter === undefined ? getAdsProvider(provider) : opts.adapter;
  const connector = await connectorFor(db, tenantId, provider);
  if (!adapter || !connector) return { ok: false, reason: "not_configured" };
  const state = await configuredState(db, provider, connector);
  if (state.unusable) return { ok: false, reason: state.unusable };
  if (!state.configured) return { ok: false, reason: "not_configured" };

  // One sync at a time per provider, and a manual "Sync now" cannot be used to hammer the provider's API.
  const [latest] = await db.select().from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, provider))).orderBy(desc(adsSyncRuns.startedAt)).limit(1);
  if (latest?.status === "RUNNING" && now.getTime() - latest.startedAt.getTime() < STALE_RUNNING_MS) return { ok: false, reason: "sync_in_progress" };
  if (opts.trigger === "MANUAL" && latest?.finishedAt && now.getTime() - latest.finishedAt.getTime() < MANUAL_COOLDOWN_MS) return { ok: false, reason: "too_soon" };

  const tz = await tenantTimezone(db, tenantId);
  const today = await localToday(db, tz, now);
  const [prior] = await db.select({ id: adsSyncRuns.id }).from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, provider), eq(adsSyncRuns.status, "SUCCEEDED"))).limit(1);
  const range = opts.range ?? { from: addDays(today, -((prior ? RESTATEMENT_DAYS : FIRST_SYNC_DAYS) - 1)), to: today };
  if (range.from > range.to || (new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / 86_400_000 > MAX_RANGE_DAYS) return { ok: false, reason: "invalid_range" };

  const [run] = await db.insert(adsSyncRuns).values({ tenantId, connectorId: connector.id, provider, trigger: opts.trigger, rangeFrom: range.from, rangeTo: range.to, startedAt: now }).returning();
  const config = { ...((connector.configuration as Record<string, unknown> | null) ?? {}), mode: connector.mode.toLowerCase() };

  let attempts = 0;
  try {
    // Inside the try: a credential that cannot be read must end the run as FAILED, never strand it RUNNING.
    const secrets = connector.mode === "FIXTURE" ? {} : (await getConnectorSecrets(db, connector.id)) ?? {};
    let facts;
    for (;;) {
      attempts++;
      try {
        facts = await adapter.fetchDailyFacts(config, secrets, range);
        break;
      } catch (err) {
        if (!(err instanceof TransientAdsError) || attempts >= MAX_ATTEMPTS) throw err;
        await sleep(RETRY_DELAYS_MS[attempts - 1] ?? 3000);
      }
    }

    // All-or-nothing: a half-written sync would leave a day with some campaigns and not others.
    await db.transaction(async (tx) => {
      // The provider's answer for this window REPLACES what was stored for it: a day or campaign it no longer reports
      // (restated to nothing, removed) must not keep its old spend forever.
      await tx.delete(adsDailyFacts).where(and(eq(adsDailyFacts.tenantId, tenantId), eq(adsDailyFacts.connectorId, connector.id), gte(adsDailyFacts.factDate, range.from), lte(adsDailyFacts.factDate, range.to)));
      for (let i = 0; i < facts.length; i += 500) {
        const chunk = facts.slice(i, i + 500).map((f) => ({
          tenantId, connectorId: connector.id, provider, accountId: f.accountId, entityType: f.entityType, entityId: f.entityId, entityName: f.entityName, factDate: f.date,
          currency: f.currency, spend: String(f.spend), impressions: f.impressions, clicks: f.clicks,
          providerConversions: f.providerConversions === null ? null : String(f.providerConversions), actions: f.actions, syncedAt: now,
        }));
        if (chunk.length === 0) continue;
        await tx.insert(adsDailyFacts).values(chunk).onConflictDoUpdate({
          target: [adsDailyFacts.tenantId, adsDailyFacts.provider, adsDailyFacts.accountId, adsDailyFacts.entityType, adsDailyFacts.entityId, adsDailyFacts.factDate],
          set: {
            entityName: sql`excluded.entity_name`, currency: sql`excluded.currency`, spend: sql`excluded.spend`, impressions: sql`excluded.impressions`, clicks: sql`excluded.clicks`,
            providerConversions: sql`excluded.provider_conversions`, actions: sql`excluded.actions`, syncedAt: sql`excluded.synced_at`,
          },
        });
      }
    });
    const [done] = await db.update(adsSyncRuns).set({ status: "SUCCEEDED", rowsUpserted: facts.length, attempts, finishedAt: now }).where(eq(adsSyncRuns.id, run!.id)).returning();
    await touchConnectorSuccess(db, connector.id);
    return { ok: true, run: runVm(done!) };
  } catch (err) {
    const message = redactLogText(err instanceof Error ? err.message : String(err)) ?? "sync failed";
    const [failed] = await db.update(adsSyncRuns).set({ status: "FAILED", attempts, error: message, finishedAt: now }).where(eq(adsSyncRuns.id, run!.id)).returning();
    await touchConnectorError(db, connector.id, message);
    return { ok: true, run: runVm(failed!) };
  }
}

/** Scheduled tick: every configured, enabled ads connector that has not synced successfully in the last 6 hours. */
export async function syncDueAds(db: Db, now: Date, opts: { adapterFor?: (p: AdsProvider) => AdsReportingProvider | null } = {}): Promise<{ synced: number; skipped: number }> {
  const rows = await db.select({ tenantId: connectors.tenantId, provider: connectors.provider }).from(connectors).where(inArray(connectors.provider, [...ADS_PROVIDERS]));
  let synced = 0;
  let skipped = 0;
  for (const { tenantId, provider } of rows) {
    const p = provider as AdsProvider;
    const [lastOk] = await db.select({ at: adsSyncRuns.finishedAt }).from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, p), eq(adsSyncRuns.status, "SUCCEEDED"))).orderBy(desc(adsSyncRuns.finishedAt)).limit(1);
    const [recent] = await db.select({ id: adsSyncRuns.id }).from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, p), gt(adsSyncRuns.startedAt, new Date(now.getTime() - SCHEDULED_RETRY_AFTER_FAILURE_MS)))).limit(1);
    if (recent || (lastOk?.at && now.getTime() - lastOk.at.getTime() < SCHEDULED_SYNC_EVERY_MS)) { skipped++; continue; }
    const r = await syncAds(db, tenantId, p, { trigger: "SCHEDULED", now, adapter: opts.adapterFor ? opts.adapterFor(p) : undefined });
    if (r.ok) synced++;
    else skipped++;
  }
  return { synced, skipped };
}
