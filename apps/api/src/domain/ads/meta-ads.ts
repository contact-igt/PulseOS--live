import { TransientAdsError, adsFetch, type AdsReportingProvider, type NormalizedAdFact } from "./types.js";
import { fixtureFacts } from "./fixture.js";

export const META_ADS_GRAPH_VERSION = "v23.0";

interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  account_currency?: string;
  actions?: { action_type: string; value: string }[];
}

export function parseMetaInsights(accountId: string, rows: InsightRow[]): NormalizedAdFact[] {
  const out: NormalizedAdFact[] = [];
  for (const r of rows) {
    if (!r.campaign_id || !r.date_start) continue;
    const actions: Record<string, number> = {};
    for (const a of r.actions ?? []) actions[a.action_type] = (actions[a.action_type] ?? 0) + Number(a.value);
    out.push({
      accountId, entityType: "CAMPAIGN", entityId: r.campaign_id, entityName: r.campaign_name ?? r.campaign_id, date: r.date_start,
      currency: r.account_currency ?? "", spend: Math.round(Number(r.spend ?? 0) * 100) / 100, impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0),
      providerConversions: null, actions,
    });
  }
  return out;
}

export const metaAdsProvider: AdsReportingProvider = {
  provider: "meta_ads",

  async fetchDailyFacts(config, secrets, range) {
    const accountId = String(config.adAccountId ?? "").replace(/^act_/, "");
    if (config.mode === "fixture") {
      return fixtureFacts("meta_ads", accountId || "fixture", [
        { id: "6001001", name: "Cataract — Lead form", baseSpend: 2600 },
        { id: "6001002", name: "Eye check — Awareness", baseSpend: 1800 },
      ], range, true);
    }
    const accessToken = secrets.accessToken;
    if (!accountId || typeof accessToken !== "string" || !accessToken) throw new Error("Meta Ads is missing its ad account ID or access token");
    const version = String(config.apiVersion ?? META_ADS_GRAPH_VERSION);

    // Read-only: GET insights, daily, campaign level. The token travels in the Authorization header, never the URL.
    const params = new URLSearchParams({
      level: "campaign",
      time_increment: "1",
      fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency",
      time_range: JSON.stringify({ since: range.from, until: range.to }),
      limit: "500",
    });
    const rows: InsightRow[] = [];
    let url: string | null = `https://graph.facebook.com/${version}/act_${accountId}/insights?${params}`;
    const MAX_PAGES = 40;
    for (let page = 0; url; page++) {
      // A truncated pull must fail the run, never be stored as a complete snapshot.
      if (page >= MAX_PAGES) throw new Error("Meta Ads returned more data than one sync can take; narrow the date range");
      const res: Response = await adsFetch(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 429 || res.status >= 500) throw new TransientAdsError(`Meta Ads request failed: HTTP ${res.status}`);
      if (!res.ok) {
        // Meta signals throttling with HTTP 400 and error codes 4 / 17 / 32 / 613.
        const code = res.status === 400 ? ((await res.json().catch(() => null)) as { error?: { code?: number } } | null)?.error?.code : undefined;
        if (code !== undefined && [4, 17, 32, 613].includes(code)) throw new TransientAdsError(`Meta Ads rate limited: code ${code}`);
        throw new Error(`Meta Ads request failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data?: InsightRow[]; paging?: { next?: string } };
      rows.push(...(body.data ?? []));
      url = body.paging?.next ?? null;
    }
    const facts = parseMetaInsights(accountId, rows);
    if (facts.some((f) => !f.currency)) throw new Error("Meta Ads returned amounts without a currency");
    return facts;
  },
};
