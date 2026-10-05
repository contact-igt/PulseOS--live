import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureFacts, daysBetween } from "../domain/ads/fixture.js";
import { googleAdsProvider, microsToMajor, parseGoogleRows } from "../domain/ads/google-ads.js";
import { metaAdsProvider, parseMetaInsights } from "../domain/ads/meta-ads.js";
import { TransientAdsError } from "../domain/ads/types.js";
import { mappedActionTypes, sumMappedActions } from "../domain/ads/ads-analytics.service.js";

afterEach(() => vi.unstubAllGlobals());

describe("ads fixtures", () => {
  it("are deterministic: the same inputs always produce the same rows (what makes a repeat sync idempotent)", () => {
    const c = [{ id: "1", name: "A", baseSpend: 1000 }];
    const range = { from: "2026-09-01", to: "2026-09-05" };
    expect(fixtureFacts("google_ads", "acct", c, range, false)).toEqual(fixtureFacts("google_ads", "acct", c, range, false));
    expect(fixtureFacts("google_ads", "acct", c, range, false)).toHaveLength(5);
    expect(fixtureFacts("google_ads", "other", c, range, false)[0]!.spend).not.toBe(fixtureFacts("google_ads", "acct", c, range, false)[0]!.spend);
    expect(daysBetween("2026-09-30", "2026-10-02")).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("fixture mode never touches the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await googleAdsProvider.fetchDailyFacts({ mode: "fixture", customerId: "123" }, {}, { from: "2026-09-01", to: "2026-09-02" })).length).toBeGreaterThan(0);
    expect((await metaAdsProvider.fetchDailyFacts({ mode: "fixture", adAccountId: "act_9" }, {}, { from: "2026-09-01", to: "2026-09-02" })).length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Google Ads adapter", () => {
  it("converts micros to the account currency and keeps provider conversions separate", () => {
    expect(microsToMajor("1234567890")).toBe(1234.57);
    const facts = parseGoogleRows("123", [{ results: [{ campaign: { id: "55", name: "Cataract" }, segments: { date: "2026-09-01" }, metrics: { costMicros: "2500000", impressions: "1000", clicks: "40", conversions: 3.5 }, customer: { currencyCode: "INR" } }] }]);
    expect(facts).toEqual([{ accountId: "123", entityType: "CAMPAIGN", entityId: "55", entityName: "Cataract", date: "2026-09-01", currency: "INR", spend: 2.5, impressions: 1000, clicks: 40, providerConversions: 3.5, actions: null }]);
  });

  it("live: refresh-token exchange then a read-only GAQL SELECT; credentials only in the OAuth body / auth headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("oauth2")) return { ok: true, json: async () => ({ access_token: "ya29.access" }) };
      return { ok: true, status: 200, json: async () => [{ results: [] }] };
    }));
    await googleAdsProvider.fetchDailyFacts({ customerId: "123-456-7890" }, { developerToken: "dev-tok", clientId: "cid", clientSecret: "csecret", refreshToken: "rtok" }, { from: "2026-09-01", to: "2026-09-02" });
    expect(calls).toHaveLength(2);
    const search = calls[1]!;
    expect(search.url).toContain("/customers/1234567890/googleAds:searchStream");
    expect(search.url).not.toContain("mutate");
    expect(search.url).not.toMatch(/dev-tok|ya29|csecret|rtok/);
    expect(String(JSON.parse(String(search.init.body)).query)).toMatch(/^SELECT /);
    expect((search.init.headers as Record<string, string>)["developer-token"]).toBe("dev-tok");
  });

  it("5xx and 429 are transient (retryable); other failures are not; errors carry the status only", async () => {
    const stub = (status: number) => vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("oauth2") ? { ok: true, json: async () => ({ access_token: "a" }) } : { ok: false, status, text: async () => "secret=zzz" })));
    const cfg = { customerId: "1" };
    const sec = { developerToken: "d", clientId: "c", clientSecret: "s", refreshToken: "r" };
    stub(503);
    await expect(googleAdsProvider.fetchDailyFacts(cfg, sec, { from: "2026-09-01", to: "2026-09-01" })).rejects.toBeInstanceOf(TransientAdsError);
    stub(401);
    const err = await googleAdsProvider.fetchDailyFacts(cfg, sec, { from: "2026-09-01", to: "2026-09-01" }).catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(TransientAdsError);
    expect((err as Error).message).toBe("Google Ads request failed: HTTP 401");
  });

  it("refuses to run without credentials rather than guessing", async () => {
    await expect(googleAdsProvider.fetchDailyFacts({ customerId: "1" }, {}, { from: "2026-09-01", to: "2026-09-01" })).rejects.toThrow(/missing/);
  });
});

describe("Meta Ads adapter and the action mapping", () => {
  const rows = [{ campaign_id: "7", campaign_name: "Lead form", date_start: "2026-09-01", spend: "120.50", impressions: "5000", clicks: "90", account_currency: "INR", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "4" }, { action_type: "link_click", value: "90" }, { action_type: "post_engagement", value: "200" }] }];

  it("keeps every action type raw; none is ever called a lead by the adapter", () => {
    const [f] = parseMetaInsights("9", rows);
    expect(f).toMatchObject({ entityId: "7", spend: 120.5, providerConversions: null, actions: { "onsite_conversion.lead_grouped": 4, link_click: 90, post_engagement: 200 } });
  });

  it("only the action types the hospital mapped count as leads; with none mapped there is no lead figure at all", () => {
    const [f] = parseMetaInsights("9", rows);
    expect(sumMappedActions(f!.actions, [])).toBeNull();
    expect(sumMappedActions(f!.actions, mappedActionTypes({ leadActionTypes: " onsite_conversion.lead_grouped , " }))).toBe(4);
    expect(sumMappedActions(f!.actions, ["lead"])).toBe(0); // an arbitrary "lead" label matches nothing unless the provider sent exactly that type
    expect(mappedActionTypes(null)).toEqual([]);
  });

  it("live: a GET on the insights edge with the token in the header only (read-only)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: rows }) }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await metaAdsProvider.fetchDailyFacts({ adAccountId: "act_9" }, { accessToken: "EAAB-secret" }, { from: "2026-09-01", to: "2026-09-02" });
    expect(out).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toContain("/act_9/insights?");
    expect(url).not.toContain("EAAB-secret");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer EAAB-secret");
  });

  it("follows paging and classifies throttling as transient", async () => {
    const pages = [{ data: rows, paging: { next: "https://graph.facebook.com/next" } }, { data: rows }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => pages.shift() })));
    expect(await metaAdsProvider.fetchDailyFacts({ adAccountId: "9" }, { accessToken: "t" }, { from: "2026-09-01", to: "2026-09-01" })).toHaveLength(2);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 })));
    await expect(metaAdsProvider.fetchDailyFacts({ adAccountId: "9" }, { accessToken: "t" }, { from: "2026-09-01", to: "2026-09-01" })).rejects.toBeInstanceOf(TransientAdsError);
  });
});
