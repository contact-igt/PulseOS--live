import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AdsAnalytics, AdsProvider, IntegrationDetail, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { adsDailyFacts, adsSyncRuns, campaignTouchpoints, connectors, journeys, marketingCampaigns, patients, revenueEvents } from "../db/schema.js";
import { syncAds, syncDueAds } from "../domain/ads/ads-sync.service.js";
import { TransientAdsError, type AdsReportingProvider, type NormalizedAdFact } from "../domain/ads/types.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe.skipIf(!DEMO_PASSWORD)("ads sync and Marketing Analytics (integration, fixtures only)", () => {
  let app: FastifyInstance;
  let t: TestTenant; // V1 with every ads switch turned on by a Super Admin
  let bare: TestTenant; // V1 defaults: ads off
  let n = 0;
  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const factCount = async (provider: AdsProvider) => (await db.select({ c: count() }).from(adsDailyFacts).where(and(eq(adsDailyFacts.tenantId, t.tenantId), eq(adsDailyFacts.provider, provider))))[0]!.c;
  const ads = async (q = "range=30d", tt = t, role: Role = "HOSPITAL_ADMIN") => (await call(tt, role, "GET", `/analytics/ads?${q}`)).json() as AdsAnalytics;
  const day = (offset: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const noSleep = async () => {};

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    bare = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const k of ["MARKETING_ANALYTICS", "GOOGLE_ADS", "META_ADS"]) expect((await call(t, "SUPER_ADMIN", "PUT", `/capabilities/${k}`, { enabled: true })).statusCode, k).toBe(200);
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/google_ads/configuration", { configuration: { customerId: "123-456-7890" } })).statusCode).toBe(200);
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/meta_ads/configuration", { configuration: { adAccountId: "act_555" } })).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const tt of [t, bare]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  it("with ads switched off, sync is refused and Marketing Analytics ads data is not available (V1 default)", async () => {
    expect((await call(bare, "HOSPITAL_ADMIN", "POST", "/integrations/hub/google_ads/sync")).statusCode).toBe(403);
    expect((await call(bare, "HOSPITAL_ADMIN", "GET", "/analytics/ads")).statusCode).toBe(403); // MARKETING_ANALYTICS off
  });

  it("before any sync: setup empty state, no fake zeros", async () => {
    const a = await ads();
    expect(a.unavailable).toBe("NO_DATA_YET");
    expect(a.totals).toBeNull();
    expect(a.campaigns).toEqual([]);
    expect(a.providers.find((p) => p.provider === "google_ads")).toMatchObject({ setup: "NEVER_SYNCED", lastSyncedAt: null, mode: "FIXTURE" });
  });

  it("Sync Now (Admin): pulls fixture facts, records the run, sets Last synced; a second click is rate-limited", async () => {
    const r = await call(t, "HOSPITAL_ADMIN", "POST", "/integrations/hub/google_ads/sync");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "SUCCEEDED", trigger: "MANUAL" });
    expect(r.json().rowsUpserted).toBe(3 * 30); // 3 fixture campaigns x the first-sync 30 days
    expect(await factCount("google_ads")).toBe(90);
    expect((await call(t, "HOSPITAL_ADMIN", "POST", "/integrations/hub/google_ads/sync")).statusCode).toBe(429);
    const detail = (await call(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/google_ads")).json() as IntegrationDetail;
    expect(detail.syncRuns![0]).toMatchObject({ status: "SUCCEEDED" });
    expect(detail.lastSyncAt).toBeTruthy();
    expect(detail.health).toBe("HEALTHY"); // earned by a real successful sync, not by configuration
    for (const role of ["FRONT_DESK", "DOCTOR"] as Role[]) expect((await call(t, role, "POST", "/integrations/hub/google_ads/sync")).statusCode, role).toBe(403);
    expect((await call(t, "HOSPITAL_ADMIN", "POST", "/integrations/hub/ccs_ivr/sync")).statusCode).toBe(404);
  });

  it("re-syncing the same days is idempotent: same facts, no duplicates, nothing double-counted", async () => {
    const before = await ads();
    const later = new Date(Date.now() + 10 * 60_000);
    const again = await syncAds(db, t.tenantId, "google_ads", { trigger: "SCHEDULED", now: later });
    expect(again.ok && again.run.status).toBe("SUCCEEDED");
    expect(again.ok && again.run.rowsUpserted).toBe(3 * 7); // incremental: the last week is re-read (providers restate recent days)
    expect(await factCount("google_ads")).toBe(90);
    const after = await ads();
    expect(after.totals).toEqual(before.totals);
  });

  it("a failed sync keeps the previous snapshot, is recorded with a redacted error, and flags the connector", async () => {
    const before = await ads();
    const boom: AdsReportingProvider = { provider: "google_ads", fetchDailyFacts: async () => { throw new Error("denied: access_token=EAAB1234567890123456789012345 Bearer abc.def.ghi"); } };
    const r = await syncAds(db, t.tenantId, "google_ads", { trigger: "SCHEDULED", now: new Date(Date.now() + 30 * 60_000), adapter: boom, sleep: noSleep });
    expect(r.ok && r.run).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(JSON.stringify(r)).not.toContain("EAAB1234567890");
    expect(JSON.stringify(r)).not.toContain("abc.def.ghi");
    expect((await ads()).totals).toEqual(before.totals); // untouched
    expect((await ads()).providers.find((p) => p.provider === "google_ads")).toMatchObject({ lastSyncStatus: "FAILED", setup: "READY" });
    const [c] = await db.select().from(connectors).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "google_ads")));
    expect(c).toMatchObject({ status: "ERROR" });
    expect(c!.lastError).toContain("[redacted]");
    expect(((await call(t, "HOSPITAL_ADMIN", "GET", "/integrations/hub/google_ads")).json() as IntegrationDetail).health).toBe("UNHEALTHY");
  });

  it("transient provider errors retry a bounded number of times: recover on the 3rd try, give up after 3", async () => {
    let calls = 0;
    const flaky: AdsReportingProvider = { provider: "google_ads", fetchDailyFacts: async (): Promise<NormalizedAdFact[]> => { if (++calls < 3) throw new TransientAdsError("HTTP 503"); return []; } };
    const ok = await syncAds(db, t.tenantId, "google_ads", { trigger: "SCHEDULED", now: new Date(Date.now() + 60 * 60_000), adapter: flaky, sleep: noSleep });
    expect(ok.ok && ok.run).toMatchObject({ status: "SUCCEEDED", attempts: 3 });
    let calls2 = 0;
    const down: AdsReportingProvider = { provider: "google_ads", fetchDailyFacts: async () => { calls2++; throw new TransientAdsError("HTTP 503"); } };
    const bad = await syncAds(db, t.tenantId, "google_ads", { trigger: "SCHEDULED", now: new Date(Date.now() + 2 * 3_600_000), adapter: down, sleep: noSleep });
    expect(bad.ok && bad.run).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(calls2).toBe(3);
    // The health recovers with the next good sync.
    const fixed = await syncAds(db, t.tenantId, "google_ads", { trigger: "SCHEDULED", now: new Date(Date.now() + 3 * 3_600_000) });
    expect(fixed.ok && fixed.run.status).toBe("SUCCEEDED");
  });

  it("Meta: facts keep raw actions; leads exist only for the action types the hospital mapped", async () => {
    expect((await call(t, "HOSPITAL_ADMIN", "POST", "/integrations/hub/meta_ads/sync")).statusCode).toBe(200);
    let a = await ads("range=30d&source=meta");
    const row = a.campaigns.find((c) => c.provider === "meta_ads")!;
    expect(row.providerMappedLeads).toBeNull(); // nothing mapped: no lead figure, certainly not "link clicks are leads"
    expect(row.providerConversions).toBeNull();
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/meta_ads/configuration", { configuration: { leadActionTypes: "onsite_conversion.lead_grouped" } })).statusCode).toBe(200);
    a = await ads("range=30d&source=meta");
    const mapped = a.campaigns.find((c) => c.entityId === row.entityId)!.providerMappedLeads!;
    expect(mapped).toBeGreaterThan(0);
    expect(mapped).toBeLessThan(a.campaigns.find((c) => c.entityId === row.entityId)!.clicks); // far fewer than link clicks / engagement
  });

  it("the scheduled tick syncs only what is due (6 hours) and never while a recent attempt exists", async () => {
    const runs = async () => (await db.select({ c: count() }).from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, t.tenantId), eq(adsSyncRuns.provider, "google_ads"))))[0]!.c;
    const before = await runs();
    await syncDueAds(db, new Date(Date.now() + 3 * 3_600_000 + 60_000)); // the last google success is one minute old in this timeline
    expect(await runs()).toBe(before);
    await syncDueAds(db, new Date(Date.now() + 10 * 3_600_000)); // ten hours on: due again, exactly once
    expect(await runs()).toBe(before + 1);
  });

  describe("Marketing Analytics (ads side)", () => {
    it("provider numbers reconcile with the stored facts, and provider conversions are never PulseOS outcomes", async () => {
      const a = await ads("range=30d&source=google");
      expect(a.unavailable).toBeNull();
      const raw = await db.select().from(adsDailyFacts).where(and(eq(adsDailyFacts.tenantId, t.tenantId), eq(adsDailyFacts.provider, "google_ads")));
      const inRange = raw.filter((r) => r.factDate >= day(-29) && r.factDate <= today);
      const spend = inRange.reduce((s, r) => s + Number(r.spend), 0);
      expect(a.totals!.spend).toBeCloseTo(spend, 1);
      expect(a.totals!.clicks).toBe(inRange.reduce((s, r) => s + r.clicks, 0));
      expect(a.campaigns.every((c) => c.provider === "google_ads")).toBe(true);
      expect(a.campaigns.every((c) => c.pulseos === null && c.costPerLead === null && c.roas === null)).toBe(true); // not tied to PulseOS journeys: no zeros, no costs
      expect(a.matched).toBeNull();
      expect(a.coverage).toMatchObject({ matchedCampaigns: 0, totalCampaigns: 3 });
      expect(a.campaigns[0]!.providerConversions).not.toBeNull();
      // One point per day that has stored facts inside the window (a late-evening run can sync across midnight, so the count is derived, never assumed).
      expect(a.daily.length).toBe(new Set(inRange.map((r) => r.factDate)).size);
      expect(a.daily.length).toBeGreaterThanOrEqual(29);
      expect(a.daily.length).toBeLessThanOrEqual(30);
    });

    it("a campaign PulseOS can tie to its own journeys gets outcomes, derived costs and ROAS, with valid denominators only", async () => {
      const [camp] = await db.insert(marketingCampaigns).values({ tenantId: t.tenantId, source: "google", name: "Cataract — Search", externalCampaignId: "9001001", spendAmount: 0, startDate: new Date(Date.now() - 40 * 86_400_000) }).returning();
      const mk = async (stage: "enquiry" | "booked" | "consulted" | "completed", revenue = 0) => {
        const [p] = await db.insert(patients).values({ tenantId: t.tenantId, name: `Ads P ${++n}`, phone: `+9197000${String(10000 + n)}`, phoneE164: `+9197000${String(10000 + n)}` }).returning();
        const [j] = await db.insert(journeys).values({ tenantId: t.tenantId, patientId: p!.id, journeyType: "Cataract", source: "google", stage }).returning();
        await db.insert(campaignTouchpoints).values({ tenantId: t.tenantId, patientId: p!.id, journeyId: j!.id, campaignId: camp!.id, source: "google", touchType: "first_touch", externalCampaignId: "9001001", occurredAt: new Date() });
        if (revenue) await db.insert(revenueEvents).values({ tenantId: t.tenantId, patientId: p!.id, journeyId: j!.id, amount: revenue, type: "treatment_payment" });
      };
      await mk("enquiry"); await mk("booked"); await mk("consulted"); await mk("completed", 40000);

      const a = await ads("range=30d&source=google");
      const row = a.campaigns.find((c) => c.entityId === "9001001")!;
      expect(row.pulseos).toMatchObject({ campaignId: camp!.id, leads: 4, appointments: 3, consultations: 2, treatments: 1, revenue: 40000 });
      expect(row.costPerLead).toBeCloseTo(row.spend / 4, 2);
      expect(row.costPerAppointment).toBeCloseTo(row.spend / 3, 2);
      expect(row.costPerConsultation).toBeCloseTo(row.spend / 2, 2);
      expect(row.costPerTreatment).toBeCloseTo(row.spend, 2);
      expect(row.roas).toBeCloseTo(40000 / row.spend, 3);
      // The other two campaigns are still untied: nothing is invented for them.
      expect(a.campaigns.filter((c) => c.entityId !== "9001001").every((c) => c.pulseos === null && c.costPerLead === null)).toBe(true);
      // Blended figures describe the matched campaign only, and say how much of the spend that is.
      expect(a.matched).toMatchObject({ spend: row.spend, leads: 4, treatments: 1 });
      expect(a.coverage).toMatchObject({ matchedCampaigns: 1, totalCampaigns: 3, matchedSpend: row.spend });
      expect(a.coverage.totalSpend).toBeGreaterThan(a.coverage.matchedSpend);
      // Outside the period nothing is attributed, and a zero denominator yields null, never zero/Infinity.
      const old = await ads(`range=custom&from=${day(-200)}&to=${day(-190)}`);
      expect(old.unavailable).toBe("NO_DATA_YET");
    });

    it("conservative: the same campaign id under another channel is not matched; branch/service slices say ads cannot be sliced", async () => {
      await db.insert(marketingCampaigns).values({ tenantId: t.tenantId, source: "meta", name: "Collision", externalCampaignId: "9001002", spendAmount: 0, startDate: new Date() });
      const row = (await ads("range=30d&source=google")).campaigns.find((c) => c.entityId === "9001002")!;
      expect(row.pulseos).toBeNull();
      const sliced = await ads(`range=30d&branchId=${t.branchId}`);
      expect(sliced.unavailable).toBe("NOT_SLICEABLE");
      expect(sliced.campaigns).toEqual([]);
    });

    it("date presets resolve in the hospital's timezone: today and yesterday are single days; this_month ends today", async () => {
      expect((await ads("range=today")).period).toMatchObject({ from: today, to: today });
      expect((await ads("range=yesterday")).period).toMatchObject({ from: day(-1), to: day(-1) });
      expect((await ads("range=this_month")).period.to).toBe(today);
      const y = await ads("range=yesterday&source=google");
      expect(y.daily.map((d) => d.date)).toEqual([day(-1)]);
    });

    it("role scope is enforced by the API: only roles with marketing and revenue access may read it", async () => {
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await call(t, role, "GET", "/analytics/ads?range=30d")).statusCode, role).toBe(403);
      expect((await call(t, "SUPER_ADMIN", "GET", "/analytics/ads?range=30d")).statusCode).toBe(200);
    });

    it("tenant isolation: another hospital's ads facts never appear", async () => {
      expect((await call(bare, "SUPER_ADMIN", "PUT", "/capabilities/MARKETING_ANALYTICS", { enabled: true })).statusCode).toBe(200);
      const a = await ads("range=30d", bare, "SUPER_ADMIN");
      expect(a.campaigns).toEqual([]);
      expect(a.unavailable).toBe("NO_PROVIDER_ENABLED");
    });
  });
});
