import { and, between, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { adsDailyFacts, adsSyncRuns, connectors, marketingCampaigns } from "../../db/schema.js";
import type { AdsAnalytics, AdsCampaignOutcomes, AdsCampaignRow, AdsProvider, AdsProviderStatus, AnalyticsQuery } from "@pulseos/types";
import { ADS_PROVIDERS, ADS_PROVIDER_LABEL } from "@pulseos/types";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { catalogueEntry } from "../integration/hub-catalogue.js";
import { deriveConfiguration, deriveMode, type ConnectorFacts } from "../integration/hub-state.js";
import { readSecretFacts } from "../integration/secret-facts.js";
import { connectorSecrets } from "../../db/schema.js";
import { costPer, roas as roasOf } from "../marketing/formulas.js";
import { fetchJourneys, fetchRevenue, reached, resolvePeriod, sumBy } from "../analytics/analytics.service.js";
import { CAPABILITY_FOR } from "./ads-sync.service.js";

/** The PulseOS source channel a provider's campaigns are filed under. */
const CHANNEL: Record<AdsProvider, "google" | "meta"> = { google_ads: "google", meta_ads: "meta" };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Which Meta action types the hospital has chosen to count as leads; anything not listed is never called a lead. */
export function mappedActionTypes(config: Record<string, unknown> | null): string[] {
  return String(config?.leadActionTypes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function sumMappedActions(actions: Record<string, number> | null, mapped: string[]): number | null {
  if (mapped.length === 0) return null;
  return mapped.reduce((n, t) => n + (actions?.[t] ?? 0), 0);
}

async function providerStatuses(db: Db, tenantId: string, caps: Record<string, boolean>): Promise<AdsProviderStatus[]> {
  const out: AdsProviderStatus[] = [];
  for (const provider of ADS_PROVIDERS) {
    const entry = catalogueEntry(provider)!;
    const enabled = !!caps[CAPABILITY_FOR[provider]];
    const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, provider))).limit(1);
    let facts: ConnectorFacts | null = null;
    if (c) {
      const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, c.id)).limit(1);
      const sf = readSecretFacts(secret?.encryptedPayload);
      facts = { status: c.status, mode: c.mode, configuration: (c.configuration as Record<string, unknown> | null) ?? null, secretKeys: sf.keys, secretsUnreadable: sf.unreadable };
    }
    const configuration = deriveConfiguration(entry, facts);
    const [ok] = await db.select({ at: adsSyncRuns.finishedAt }).from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, provider), eq(adsSyncRuns.status, "SUCCEEDED"))).orderBy(desc(adsSyncRuns.finishedAt)).limit(1);
    const [last] = await db.select().from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.provider, provider))).orderBy(desc(adsSyncRuns.startedAt)).limit(1);
    out.push({
      provider,
      name: ADS_PROVIDER_LABEL[provider],
      setup: !enabled ? "NOT_ENABLED" : configuration !== "CONFIGURED" ? "NOT_CONFIGURED" : !ok ? "NEVER_SYNCED" : "READY",
      mode: deriveMode(entry, enabled, configuration, facts),
      lastSyncedAt: ok?.at?.toISOString() ?? null,
      lastSyncStatus: (last?.status as AdsProviderStatus["lastSyncStatus"]) ?? null,
      lastSyncError: last?.status === "FAILED" ? last.error : null,
    });
  }
  return out;
}

const emptyCoverage = { matchedCampaigns: 0, totalCampaigns: 0, matchedSpend: 0, totalSpend: 0 };

/**
 * Marketing Analytics, ad-account side. Provider numbers (spend, impressions, clicks, provider conversions) come from synced
 * facts; PulseOS outcomes come from PulseOS's own journeys and only for campaigns it can tie to the provider's campaign id.
 * A campaign it cannot tie has `pulseos: null` and no derived costs — never a zero. Costs and ROAS exist only with a valid
 * denominator, and the blended figures are computed over the matched campaigns alone so spend and outcomes describe the same set.
 */
export async function getAdsAnalytics(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AdsAnalytics> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const caps = await tenantCapabilityMap(db, tenantId);
  const providers = await providerStatuses(db, tenantId, caps);
  const base: AdsAnalytics = {
    period: { from: period.from, to: period.to, timezone: period.timezone }, providers, unavailable: null, currency: null, totals: null, matched: null, coverage: emptyCoverage, campaigns: [], daily: [],
  };

  const active = ADS_PROVIDERS.filter((p) => caps[CAPABILITY_FOR[p]] && (!query.source || query.source === CHANNEL[p]));
  if (!ADS_PROVIDERS.some((p) => caps[CAPABILITY_FOR[p]])) return { ...base, unavailable: "NO_PROVIDER_ENABLED" };
  // Ad accounts are not split by branch or service line: say so rather than show an account total as if it were a slice.
  if (query.branchId || query.service || query.campaignId) return { ...base, unavailable: "NOT_SLICEABLE" };

  // A source filter that excludes every enabled ad account (e.g. Phone) is not "no data yet": say what the filter did.
  if (active.length === 0) return { ...base, unavailable: "NO_PROVIDER_FOR_SOURCE" };
  const facts = active.length
    ? await db.select().from(adsDailyFacts).where(and(eq(adsDailyFacts.tenantId, tenantId), inArray(adsDailyFacts.provider, active), between(adsDailyFacts.factDate, period.from, period.to)))
    : [];
  if (facts.length === 0) return { ...base, unavailable: "NO_DATA_YET" };
  const currencies = new Set(facts.map((f) => f.currency));
  if (currencies.size > 1) return { ...base, unavailable: "MIXED_CURRENCY" };

  const configs = new Map<string, Record<string, unknown> | null>();
  for (const p of active) {
    const [c] = await db.select({ configuration: connectors.configuration }).from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, p))).limit(1);
    configs.set(p, (c?.configuration as Record<string, unknown> | null) ?? null);
  }

  // Aggregate per (provider, campaign).
  interface Agg { provider: AdsProvider; entityId: string; name: string; spend: number; impressions: number; clicks: number; conv: number | null; actions: Record<string, number> | null }
  const byKey = new Map<string, Agg>();
  const dailyMap = new Map<string, { spend: number; clicks: number; impressions: number }>();
  for (const f of facts) {
    const k = `${f.provider}|${f.entityId}`;
    const a = byKey.get(k) ?? { provider: f.provider as AdsProvider, entityId: f.entityId, name: f.entityName, spend: 0, impressions: 0, clicks: 0, conv: null, actions: null };
    a.name = f.entityName;
    a.spend += Number(f.spend);
    a.impressions += f.impressions;
    a.clicks += f.clicks;
    if (f.providerConversions !== null) a.conv = (a.conv ?? 0) + Number(f.providerConversions);
    if (f.actions) {
      a.actions ??= {};
      for (const [t, v] of Object.entries(f.actions as Record<string, number>)) a.actions[t] = (a.actions[t] ?? 0) + Number(v);
    }
    byKey.set(k, a);
    const d = dailyMap.get(f.factDate) ?? { spend: 0, clicks: 0, impressions: 0 };
    d.spend += Number(f.spend); d.clicks += f.clicks; d.impressions += f.impressions;
    dailyMap.set(f.factDate, d);
  }

  // Tie provider campaigns to PulseOS campaigns by the provider's own campaign id, within the matching channel only.
  const aggs = [...byKey.values()];
  const entityIds = [...new Set(aggs.map((a) => a.entityId))];
  const pulseCampaigns = entityIds.length ? await db.select({ id: marketingCampaigns.id, ext: marketingCampaigns.externalCampaignId, source: marketingCampaigns.source }).from(marketingCampaigns).where(and(eq(marketingCampaigns.tenantId, tenantId), inArray(marketingCampaigns.externalCampaignId, entityIds))) : [];
  const pulseFor = (a: Agg) => pulseCampaigns.find((c) => c.ext === a.entityId && c.source === CHANNEL[a.provider]) ?? null;

  const [journeyFacts, revenueFacts] = await Promise.all([
    fetchJourneys(db, tenantId, period.timezone, period.from, period.to, {}),
    fetchRevenue(db, tenantId, period.timezone, period.from, period.to, {}),
  ]);

  const campaigns: AdsCampaignRow[] = aggs.map((a) => {
    const pc = pulseFor(a);
    let pulseos: AdsCampaignOutcomes | null = null;
    if (pc) {
      const mine = journeyFacts.filter((j) => j.campaignId === pc.id);
      pulseos = {
        campaignId: pc.id,
        leads: mine.length,
        appointments: mine.filter((j) => reached(j.stage, "booked")).length,
        consultations: mine.filter((j) => reached(j.stage, "consulted")).length,
        treatments: mine.filter((j) => j.stage === "completed").length,
        revenue: sumBy(revenueFacts.filter((r) => r.campaignId === pc.id), (r) => r.amount),
      };
    }
    const spend = round2(a.spend);
    return {
      provider: a.provider, entityId: a.entityId, name: a.name, currency: [...currencies][0]!, spend, impressions: a.impressions, clicks: a.clicks,
      ctr: a.impressions > 0 ? a.clicks / a.impressions : null,
      cpc: a.clicks > 0 ? round2(spend / a.clicks) : null,
      providerConversions: a.conv === null ? null : round2(a.conv),
      providerMappedLeads: a.provider === "meta_ads" ? sumMappedActions(a.actions, mappedActionTypes(configs.get("meta_ads") ?? null)) : null,
      pulseos,
      costPerLead: pulseos ? costPer(spend, pulseos.leads) : null,
      costPerAppointment: pulseos ? costPer(spend, pulseos.appointments) : null,
      costPerConsultation: pulseos ? costPer(spend, pulseos.consultations) : null,
      costPerTreatment: pulseos ? costPer(spend, pulseos.treatments) : null,
      roas: pulseos ? roasOf(pulseos.revenue, spend) : null,
    };
  });
  campaigns.sort((a, b) => b.spend - a.spend);

  const matchedRows = campaigns.filter((c) => c.pulseos);
  const mSpend = round2(sumBy(matchedRows, (c) => c.spend));
  const sum = (pick: (o: AdsCampaignOutcomes) => number) => sumBy(matchedRows, (c) => pick(c.pulseos!));
  const mLeads = sum((o) => o.leads), mAppts = sum((o) => o.appointments), mConsults = sum((o) => o.consultations), mTreat = sum((o) => o.treatments), mRev = sum((o) => o.revenue);
  const convValues = campaigns.map((c) => c.providerConversions).filter((v): v is number => v !== null);

  return {
    ...base,
    currency: [...currencies][0]!,
    totals: { spend: round2(sumBy(campaigns, (c) => c.spend)), impressions: sumBy(campaigns, (c) => c.impressions), clicks: sumBy(campaigns, (c) => c.clicks), providerConversions: convValues.length ? round2(convValues.reduce((x, y) => x + y, 0)) : null },
    matched: matchedRows.length === 0 ? null : {
      spend: mSpend, leads: mLeads, appointments: mAppts, consultations: mConsults, treatments: mTreat, revenue: mRev,
      costPerLead: costPer(mSpend, mLeads), costPerAppointment: costPer(mSpend, mAppts), costPerConsultation: costPer(mSpend, mConsults), costPerTreatment: costPer(mSpend, mTreat), roas: roasOf(mRev, mSpend),
    },
    coverage: { matchedCampaigns: matchedRows.length, totalCampaigns: campaigns.length, matchedSpend: mSpend, totalSpend: round2(sumBy(campaigns, (c) => c.spend)) },
    campaigns,
    daily: [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, spend: round2(d.spend), clicks: d.clicks, impressions: d.impressions })),
  };
}
