import { TransientAdsError, adsFetch, type AdsReportingProvider, type NormalizedAdFact } from "./types.js";
import { fixtureFacts } from "./fixture.js";

/** Configurable per tenant (`apiVersion`) because Google retires API versions on a fixed schedule. */
export const GOOGLE_ADS_API_VERSION = "v21";

/** Google reports money in micros of the account currency. */
export const microsToMajor = (micros: string | number): number => Math.round((Number(micros) / 1_000_000) * 100) / 100;

interface GaqlRow {
  campaign?: { id?: string; name?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number };
  customer?: { currencyCode?: string };
}

/** Parse the searchStream payload ([{ results: [...] }, ...]) into normalized facts. Exported for tests. */
export function parseGoogleRows(accountId: string, payload: unknown): NormalizedAdFact[] {
  const batches = Array.isArray(payload) ? payload : [payload];
  const facts: NormalizedAdFact[] = [];
  for (const batch of batches as { results?: GaqlRow[] }[]) {
    for (const r of batch?.results ?? []) {
      if (!r.campaign?.id || !r.segments?.date) continue;
      facts.push({
        accountId, entityType: "CAMPAIGN", entityId: String(r.campaign.id), entityName: r.campaign.name ?? String(r.campaign.id), date: r.segments.date,
        currency: r.customer?.currencyCode ?? "",
        spend: microsToMajor(r.metrics?.costMicros ?? 0), impressions: Number(r.metrics?.impressions ?? 0), clicks: Number(r.metrics?.clicks ?? 0),
        providerConversions: r.metrics?.conversions ?? null, actions: null,
      });
    }
  }
  return facts;
}

export const googleAdsProvider: AdsReportingProvider = {
  provider: "google_ads",

  async fetchDailyFacts(config, secrets, range) {
    const customerId = String(config.customerId ?? "").replace(/-/g, "");
    if (config.mode === "fixture") {
      return fixtureFacts("google_ads", customerId || "fixture", [
        { id: "9001001", name: "Cataract — Search", baseSpend: 3200 },
        { id: "9001002", name: "LASIK — Search", baseSpend: 4100 },
        { id: "9001003", name: "Brand — Search", baseSpend: 900 },
      ], range, false);
    }
    const { developerToken, clientId, clientSecret, refreshToken } = secrets as Record<string, string | undefined>;
    if (!customerId || !developerToken || !clientId || !clientSecret || !refreshToken) throw new Error("Google Ads is missing its customer ID or credentials");
    const version = String(config.apiVersion ?? GOOGLE_ADS_API_VERSION);

    // 1) OAuth refresh-token exchange. Credentials go in the request body to Google's token endpoint and nowhere else.
    const tokenRes = await adsFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (tokenRes.status === 429 || tokenRes.status >= 500) throw new TransientAdsError(`Google OAuth token request failed: HTTP ${tokenRes.status}`);
    if (!tokenRes.ok) throw new Error(`Google OAuth token request failed: HTTP ${tokenRes.status}`);
    const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!accessToken) throw new Error("Google OAuth returned no access token");

    // 2) A read-only GAQL query (searchStream). SELECT only: there is no mutate call anywhere in this adapter.
    const query = `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code FROM campaign WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`;
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, "developer-token": developerToken, "Content-Type": "application/json" };
    if (config.loginCustomerId) headers["login-customer-id"] = String(config.loginCustomerId).replace(/-/g, "");
    const res = await adsFetch(`https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`, { method: "POST", headers, body: JSON.stringify({ query }) });
    if (res.status === 429 || res.status >= 500) throw new TransientAdsError(`Google Ads request failed: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Google Ads request failed: HTTP ${res.status}`);
    const facts = parseGoogleRows(customerId, await res.json());
    // An amount without its currency cannot be trusted as rupees: refuse rather than label it.
    if (facts.some((f) => !f.currency)) throw new Error("Google Ads returned amounts without a currency");
    return facts;
  },
};
