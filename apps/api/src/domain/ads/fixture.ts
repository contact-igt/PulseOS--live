import type { NormalizedAdFact } from "./types.js";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = new Date(`${from}T00:00:00Z`).getTime(), end = new Date(`${to}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface FixtureCampaign {
  id: string;
  name: string;
  baseSpend: number;
}

/**
 * Deterministic sample numbers (a pure function of provider, account, campaign and date), so a fixture sync run twice
 * writes exactly the same rows — which is what makes idempotency testable. It is sample data, never presented as real.
 */
export function fixtureFacts(provider: string, accountId: string, campaigns: FixtureCampaign[], range: { from: string; to: string }, withActions: boolean): NormalizedAdFact[] {
  const facts: NormalizedAdFact[] = [];
  for (const date of daysBetween(range.from, range.to)) {
    for (const c of campaigns) {
      const r = hash(`${provider}|${accountId}|${c.id}|${date}`);
      const spend = Math.round(c.baseSpend * (0.7 + r * 0.6) * 100) / 100;
      const impressions = Math.round(spend * (18 + r * 10));
      const clicks = Math.round(impressions * (0.018 + r * 0.02));
      facts.push({
        accountId, entityType: "CAMPAIGN", entityId: c.id, entityName: c.name, date, currency: "INR", spend, impressions, clicks,
        providerConversions: withActions ? null : Math.round(clicks * (0.04 + r * 0.05) * 10) / 10,
        actions: withActions
          ? { "onsite_conversion.lead_grouped": Math.round(clicks * 0.05), link_click: clicks, landing_page_view: Math.round(clicks * 0.8), post_engagement: Math.round(clicks * 1.6) }
          : null,
      });
    }
  }
  return facts;
}
