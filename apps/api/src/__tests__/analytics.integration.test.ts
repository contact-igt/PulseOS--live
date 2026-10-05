import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, sql, sum } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, journeys, marketingCampaigns, patients, revenueEvents } from "../db/schema.js";
import { addDays } from "../lib/hospital-time.js";
import { roas as roasOf } from "../domain/marketing/formulas.js";
import type { FastifyInstance } from "fastify";
import type {
  AnalyticsCampaigns,
  AnalyticsFilterOptions,
  AnalyticsFlow,
  AnalyticsFunnel,
  AnalyticsRevenue,
  AnalyticsServices,
  AnalyticsSummary,
  AnalyticsTeam,
  Branch,
  JourneyHealth,
  LeadsBySourceResponse,
  ServiceMixRow,
  SourceConversionResponse,
} from "@pulseos/types";

// Every analytics figure is re-derived from raw rows, per tenant, and compared
// with what the API reports. The window is the longest allowed (366 hospital-local
// days ending today) — the seed dates everything relative to "now", so this covers
// everything the tenant has whatever year the suite runs in (no fixed calendar year).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const istToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ALL = `range=custom&from=${addDays(istToday, -365)}&to=${istToday}`;

interface Session { cookie: string; tenantId: string }

describe.skipIf(!DEMO_PASSWORD)("analytics endpoints reconcile with raw rows (integration)", () => {
  let app: FastifyInstance;
  const sessions: Record<string, Session> = {};

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const [key, email] of [["gynecology", "gyn.admin@pulseos.local"], ["ophthalmology", "eye.admin@pulseos.local"]]) {
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
      const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
      const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } });
      sessions[key] = { cookie, tenantId: (session.json() as { user: { tenantId: string } }).user.tenantId };
    }
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  async function get<T>(key: string, url: string): Promise<T> {
    const res = await app.inject({ method: "GET", url, cookies: { pulseos_session: sessions[key].cookie } });
    expect(res.statusCode, url).toBe(200);
    return res.json() as T;
  }

  describe.each(["gynecology", "ophthalmology"])("%s tenant", (key) => {
    const tenantId = () => sessions[key].tenantId;

    it("daily source counts sum to the journeys created in range, per source and per day", async () => {
      const res = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      const raw = await db
        .select({ source: journeys.source, c: count() })
        .from(journeys)
        .where(eq(journeys.tenantId, tenantId()))
        .groupBy(journeys.source);
      const rawTotal = raw.reduce((s, r) => s + r.c, 0);
      expect(res.total).toBe(rawTotal);
      expect(res.buckets.reduce((s, b) => s + b.total, 0)).toBe(rawTotal);
      for (const b of res.buckets) expect(Object.values(b.bySource).reduce((s, n) => s + n, 0)).toBe(b.total);
      for (const r of raw) {
        const fromBuckets = res.buckets.reduce((s, b) => s + (b.bySource[r.source] ?? 0), 0);
        expect(fromBuckets, `source ${r.source}`).toBe(r.c);
      }
      // Only sources that actually occur are listed.
      expect([...res.sources].sort()).toEqual(raw.map((r) => r.source).sort());
      // Buckets are contiguous, one per local day.
      expect(res.granularity).toBe("week");
      expect(res.buckets.reduce((s, b) => s + b.days, 0)).toBe(res.period.days);
    });

    it("daily buckets match a raw per-local-day grouping (30D)", async () => {
      const res = await get<LeadsBySourceResponse>(key, "/analytics/leads?range=30d");
      expect(res.granularity).toBe("day");
      expect(res.buckets).toHaveLength(30);
      const rows = await db.execute<{ day: string; c: number }>(sql`
        select to_char(created_at at time zone ${res.period.timezone}, 'YYYY-MM-DD') as day, count(*)::int as c
        from journeys
        where tenant_id = ${tenantId()}
          and (created_at at time zone ${res.period.timezone})::date between ${res.period.from}::date and ${res.period.to}::date
        group by 1`);
      const rawByDay = new Map([...rows].map((r) => [r.day, r.c]));
      for (const b of res.buckets) expect(b.total, b.key).toBe(rawByDay.get(b.key) ?? 0);
      expect(res.total).toBe([...rawByDay.values()].reduce((s, n) => s + n, 0));
    });

    it("the funnel counts each journey once at its furthest stage, is monotonic, and matches journey-health", async () => {
      const funnel = await get<AnalyticsFunnel>(key, `/analytics/funnel?${ALL}`);
      const health = await get<JourneyHealth>(key, "/dashboard/journey-health");
      const stageRows = await db.select({ stage: journeys.stage, c: count() }).from(journeys).where(eq(journeys.tenantId, tenantId())).groupBy(journeys.stage);
      const total = stageRows.reduce((s, r) => s + r.c, 0);

      const enquiry = funnel.stages.find((s) => s.key === "enquiry")!;
      expect(enquiry.count).toBe(total);
      expect(health.totalJourneys).toBe(total);
      for (let i = 1; i < funnel.stages.length; i++) {
        expect(funnel.stages[i].count, funnel.stages[i].key).toBeLessThanOrEqual(funnel.stages[i - 1].count);
        expect(funnel.stages[i].dropOff).toBe(funnel.stages[i - 1].count - funnel.stages[i].count);
      }
      const order = ["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed"];
      for (const stage of funnel.stages) {
        const reached = stageRows.filter((r) => order.indexOf(r.stage) >= order.indexOf(stage.key)).reduce((s, r) => s + r.c, 0);
        const expected = stage.key === "enquiry" ? total : reached;
        expect(stage.count, stage.key).toBe(expected);
      }
      // Same numbers as the Command Centre's journey-health for the stages both show.
      for (const seg of health.segments) {
        const stage = funnel.stages.find((s) => s.key === seg.key);
        if (stage) expect(stage.count, `journey-health ${seg.key}`).toBe(seg.count);
      }
      expect(funnel.lost).toBe(stageRows.find((r) => r.stage === "lost")?.c ?? 0);
    });

    it("revenue total and buckets equal the raw revenue_events in range", async () => {
      const res = await get<AnalyticsRevenue>(key, `/analytics/revenue?${ALL}`);
      const [{ total, c }] = await db.select({ total: sum(revenueEvents.amount), c: count() }).from(revenueEvents).where(eq(revenueEvents.tenantId, tenantId()));
      expect(res.total).toBe(Number(total ?? 0));
      expect(res.events).toBe(c);
      expect(res.buckets.reduce((s, b) => s + b.revenue, 0)).toBe(res.total);
      expect(res.buckets.reduce((s, b) => s + b.events, 0)).toBe(c);
      expect(res.byService.reduce((s, r) => s + r.revenue, 0)).toBe(res.total);
      expect(res.recent.reduce((s, r) => s + r.amount, 0)).toBeLessThanOrEqual(res.total);
      expect(res.recent.length).toBe(Math.min(c, 10));
    });

    it("ROAS = attributed revenue / spend, using the shared formula, with spend from the tenant's own campaigns", async () => {
      const res = await get<AnalyticsRevenue>(key, `/analytics/revenue?${ALL}`);
      const summary = await get<AnalyticsSummary>(key, `/analytics/summary?${ALL}`);
      const [{ spend }] = await db.select({ spend: sum(marketingCampaigns.spendAmount) }).from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, tenantId()));
      // Range covers every campaign's whole run -> pro-rated spend == full spend.
      expect(res.spend).toBeCloseTo(Number(spend ?? 0), 6);
      expect(summary.spend).toBeCloseTo(Number(spend ?? 0), 6);
      const attributed = await db
        .select({ total: sum(revenueEvents.amount) })
        .from(revenueEvents)
        .where(and(eq(revenueEvents.tenantId, tenantId()), sql`exists (select 1 from campaign_touchpoints ct where ct.journey_id = ${revenueEvents.journeyId} and ct.touch_type = 'first_touch' and ct.campaign_id is not null)`));
      expect(res.attributedRevenue).toBe(Number(attributed[0].total ?? 0));
      expect(res.roas).toBe(roasOf(res.attributedRevenue, res.spend));
      expect(summary.roas).toBe(res.roas);
      // Per-source ROAS uses the same formula and sums back to the total.
      for (const s of res.bySource) expect(s.roas).toBe(roasOf(s.attributedRevenue, s.spend));
      expect(res.bySource.reduce((n, s) => n + s.attributedRevenue, 0)).toBe(res.attributedRevenue);
      expect(res.bySource.reduce((n, s) => n + s.spend, 0)).toBeCloseTo(res.spend, 6);
    });

    it("summary KPIs agree with the leads and funnel endpoints", async () => {
      const summary = await get<AnalyticsSummary>(key, `/analytics/summary?${ALL}`);
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      const funnel = await get<AnalyticsFunnel>(key, `/analytics/funnel?${ALL}`);
      expect(summary.leads).toBe(leads.total);
      expect(summary.appointments).toBe(funnel.stages.find((s) => s.key === "booked")!.count);
      expect(summary.treatmentsCompleted).toBe(funnel.stages.find((s) => s.key === "completed")!.count);
      expect(summary.appointmentRate).toBe(summary.leads > 0 ? summary.appointments / summary.leads : null);
    });

    it("source conversion carries an explicit numerator AND denominator that reconcile with the funnel", async () => {
      const res = await get<SourceConversionResponse>(key, `/analytics/source-conversion?${ALL}`);
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      const funnel = await get<AnalyticsFunnel>(key, `/analytics/funnel?${ALL}`);
      expect(res.rows.reduce((s, r) => s + r.leads, 0)).toBe(leads.total);
      for (const r of res.rows) {
        const bySource = leads.buckets.reduce((s, b) => s + (b.bySource[r.source] ?? 0), 0);
        expect(r.leads, r.source).toBe(bySource);
        for (const ratio of [r.toAppointment, r.toConsultation, r.toTreatment]) {
          expect(ratio.denominator, r.source).toBe(r.leads);
          expect(ratio.numerator).toBeLessThanOrEqual(ratio.denominator);
          expect(ratio.rate).toBe(ratio.denominator > 0 ? ratio.numerator / ratio.denominator : null);
        }
        expect(r.toConsultation.numerator).toBeLessThanOrEqual(r.toAppointment.numerator);
        expect(r.toTreatment.numerator).toBeLessThanOrEqual(r.toConsultation.numerator);
      }
      expect(res.rows.reduce((s, r) => s + r.toAppointment.numerator, 0)).toBe(funnel.stages.find((s) => s.key === "booked")!.count);
      expect(res.rows.reduce((s, r) => s + r.toConsultation.numerator, 0)).toBe(funnel.stages.find((s) => s.key === "consulted")!.count);
      expect(res.rows.reduce((s, r) => s + r.toTreatment.numerator, 0)).toBe(funnel.stages.find((s) => s.key === "treatment_advised")!.count);
    });

    it("campaign rows plus the unattributed remainder equal the tenant totals", async () => {
      const res = await get<AnalyticsCampaigns>(key, `/analytics/campaigns?${ALL}`);
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      const revenue = await get<AnalyticsRevenue>(key, `/analytics/revenue?${ALL}`);
      expect(res.rows.reduce((s, r) => s + r.leads, 0) + res.unattributed.leads).toBe(leads.total);
      expect(res.rows.reduce((s, r) => s + r.revenue, 0) + res.unattributed.revenue).toBe(revenue.total);
      const [{ c }] = await db.select({ c: count() }).from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, tenantId()));
      expect(res.rows).toHaveLength(c);
      for (const r of res.rows) {
        expect(r.roas).toBe(roasOf(r.revenue, r.spend));
        expect(r.appointments).toBeLessThanOrEqual(r.leads);
      }
    });

    it("service lines reconcile with /dashboard/service-mix over the full range", async () => {
      const res = await get<AnalyticsServices>(key, `/analytics/services?${ALL}`);
      const mix = await get<ServiceMixRow[]>(key, "/dashboard/service-mix");
      expect(res.rows.map((r) => r.service).sort()).toEqual(mix.map((r) => r.service).sort());
      for (const m of mix) {
        const row = res.rows.find((r) => r.service === m.service)!;
        expect(row.leads, m.service).toBe(m.journeys);
        expect(row.revenue, m.service).toBe(m.revenue);
        expect(row.trend.reduce((s, n) => s + n, 0)).toBe(row.leads);
      }
    });

    it("the flow conserves journeys across source -> service -> outcome", async () => {
      const flow = await get<AnalyticsFlow>(key, `/analytics/flow?${ALL}`);
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      expect(flow.total).toBe(leads.total);
      const nodeKind = new Map(flow.nodes.map((n) => [n.id, n.kind]));
      const sum = (pred: (from: string, to: string) => boolean) => flow.links.filter((l) => pred(l.source, l.target)).reduce((s, l) => s + l.value, 0);
      expect(sum((s, t) => nodeKind.get(s) === "source" && nodeKind.get(t) === "service")).toBe(flow.total);
      expect(sum((s, t) => nodeKind.get(s) === "service" && nodeKind.get(t) === "outcome")).toBe(flow.total);
      for (const n of flow.nodes.filter((n) => n.kind === "service")) {
        expect(sum((_s, t) => t === n.id), n.label).toBe(sum((s) => s === n.id));
      }
      // Source -> outcome edges cover every journey once, and agree with both layers.
      const outcomeIds = new Set(flow.nodes.filter((n) => n.kind === "outcome").map((n) => n.id));
      expect(flow.sourceOutcomes.reduce((n, l) => n + l.value, 0)).toBe(flow.total);
      for (const l of flow.sourceOutcomes) {
        expect(nodeKind.get(l.source)).toBe("source");
        expect(outcomeIds.has(l.target)).toBe(true);
      }
      for (const n of flow.nodes.filter((n) => n.kind === "source")) {
        expect(flow.sourceOutcomes.filter((l) => l.source === n.id).reduce((a, l) => a + l.value, 0), n.label).toBe(sum((s) => s === n.id));
      }
      for (const id of outcomeIds) {
        expect(flow.sourceOutcomes.filter((l) => l.target === id).reduce((a, l) => a + l.value, 0), id).toBe(sum((_s, t) => t === id && nodeKind.get(_s) === "service"));
      }
      // "Not progressed" is an explicit outcome, never dropped.
      const [{ c: stalled }] = await db
        .select({ c: count() })
        .from(journeys)
        .where(and(eq(journeys.tenantId, tenantId()), sql`${journeys.stage} in ('enquiry', 'contacted')`));
      const notProgressed = flow.nodes.find((n) => n.kind === "outcome" && /not progressed/i.test(n.label));
      expect(Boolean(notProgressed)).toBe(stalled > 0);
      if (notProgressed) expect(sum((_s, t) => t === notProgressed.id)).toBe(stalled);
    });

    it("team rows attribute every journey exactly once", async () => {
      const team = await get<AnalyticsTeam>(key, `/analytics/team?${ALL}`);
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      expect(team.rows.reduce((s, r) => s + r.assignedJourneys, 0)).toBe(leads.total);
      for (const r of team.rows) {
        expect(r.appointmentsBooked).toBeLessThanOrEqual(r.assignedJourneys);
        expect(r.conversion.denominator).toBe(r.assignedJourneys);
        expect(r.conversion.numerator).toBe(r.appointmentsBooked);
      }
    });
  });

  describe("filters narrow every endpoint consistently (ophthalmology)", () => {
    const key = "ophthalmology";

    it("source filter: only that source, and every endpoint agrees on the count", async () => {
      const q = `${ALL}&source=meta`;
      const [{ c }] = await db.select({ c: count() }).from(journeys).where(and(eq(journeys.tenantId, sessions[key].tenantId), eq(journeys.source, "meta")));
      expect(c).toBeGreaterThan(0);
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${q}`);
      const summary = await get<AnalyticsSummary>(key, `/analytics/summary?${q}`);
      const funnel = await get<AnalyticsFunnel>(key, `/analytics/funnel?${q}`);
      const conv = await get<SourceConversionResponse>(key, `/analytics/source-conversion?${q}`);
      const services = await get<AnalyticsServices>(key, `/analytics/services?${q}`);
      const flow = await get<AnalyticsFlow>(key, `/analytics/flow?${q}`);
      expect(leads.sources).toEqual(["meta"]);
      expect(leads.total).toBe(c);
      expect(summary.leads).toBe(c);
      expect(funnel.stages[0].count).toBe(c);
      expect(conv.rows.map((r) => r.source)).toEqual(["meta"]);
      expect(services.rows.reduce((s, r) => s + r.leads, 0)).toBe(c);
      expect(flow.total).toBe(c);
    });

    it("service filter: only that service line", async () => {
      const [{ c }] = await db.select({ c: count() }).from(journeys).where(and(eq(journeys.tenantId, sessions[key].tenantId), eq(journeys.journeyType, "Cataract")));
      const q = `${ALL}&service=Cataract`;
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${q}`);
      const services = await get<AnalyticsServices>(key, `/analytics/services?${q}`);
      const revenue = await get<AnalyticsRevenue>(key, `/analytics/revenue?${q}`);
      expect(leads.total).toBe(c);
      expect(services.rows.map((r) => r.service)).toEqual(["Cataract"]);
      const [{ total }] = await db
        .select({ total: sum(revenueEvents.amount) })
        .from(revenueEvents)
        .innerJoin(journeys, eq(revenueEvents.journeyId, journeys.id))
        .where(and(eq(revenueEvents.tenantId, sessions[key].tenantId), eq(journeys.journeyType, "Cataract")));
      expect(revenue.total).toBe(Number(total ?? 0));
    });

    it("campaign filter: only journeys first-touched by that campaign; revenue follows", async () => {
      const options = await get<AnalyticsFilterOptions>(key, "/analytics/filter-options");
      const campaign = options.campaigns[0];
      const [{ c }] = await db
        .select({ c: count() })
        .from(campaignTouchpoints)
        .where(and(eq(campaignTouchpoints.tenantId, sessions[key].tenantId), eq(campaignTouchpoints.campaignId, campaign.id), eq(campaignTouchpoints.touchType, "first_touch")));
      const q = `${ALL}&campaignId=${campaign.id}`;
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${q}`);
      const campaigns = await get<AnalyticsCampaigns>(key, `/analytics/campaigns?${q}`);
      expect(leads.total).toBe(c);
      expect(campaigns.rows.map((r) => r.campaignId)).toEqual([campaign.id]);
      expect(campaigns.rows[0].leads).toBe(c);
    });

    it("branch filter narrows by the patient's branch", async () => {
      const branches = await get<Branch[]>(key, "/branches");
      let sumBranches = 0;
      for (const b of branches) {
        const [{ c }] = await db
          .select({ c: count() })
          .from(journeys)
          .innerJoin(patients, eq(journeys.patientId, patients.id))
          .where(and(eq(journeys.tenantId, sessions[key].tenantId), eq(patients.branchId, b.id)));
        const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}&branchId=${b.id}`);
        expect(leads.total, b.name).toBe(c);
        sumBranches += leads.total;
      }
      const all = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      expect(sumBranches).toBeLessThanOrEqual(all.total);
    });

    it("combined filters intersect (source AND service)", async () => {
      const [{ c }] = await db
        .select({ c: count() })
        .from(journeys)
        .where(and(eq(journeys.tenantId, sessions[key].tenantId), eq(journeys.source, "google"), eq(journeys.journeyType, "Cataract")));
      const leads = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}&source=google&service=Cataract`);
      expect(leads.total).toBe(c);
      const services = await get<AnalyticsServices>(key, `/analytics/services?${ALL}&source=google&service=Cataract`);
      expect(services.rows).toHaveLength(c > 0 ? 1 : 0);
    });

    it("slicing by service allocates campaign spend by lead share, so per-service spend adds back up", async () => {
      const whole = await get<AnalyticsRevenue>(key, `/analytics/revenue?${ALL}`);
      const campaigns = await get<AnalyticsCampaigns>(key, `/analytics/campaigns?${ALL}`);
      const services = await get<AnalyticsServices>(key, `/analytics/services?${ALL}`);
      let spendSum = 0;
      for (const svc of services.rows) {
        const slice = await get<AnalyticsRevenue>(key, `/analytics/revenue?${ALL}&service=${encodeURIComponent(svc.service)}`);
        spendSum += slice.spend;
        expect(slice.roas).toBe(roasOf(slice.attributedRevenue, slice.spend));
      }
      // Campaigns that acquired no journeys have no lead share to allocate.
      const allocatable = campaigns.rows.filter((r) => r.leads > 0).reduce((n, r) => n + r.spend, 0);
      expect(spendSum).toBeCloseTo(allocatable, 4);
      expect(spendSum).toBeLessThanOrEqual(whole.spend + 1e-6);
    });

    it("a narrower range returns a subset", async () => {
      const wide = await get<LeadsBySourceResponse>(key, `/analytics/leads?${ALL}`);
      const week = await get<LeadsBySourceResponse>(key, "/analytics/leads?range=7d");
      expect(week.period.days).toBe(7);
      expect(week.buckets).toHaveLength(7);
      expect(week.total).toBeLessThanOrEqual(wide.total);
    });
  });

  describe("tenant isolation and access", () => {
    it("one tenant's analytics never contain the other's services, sources or campaigns", async () => {
      const eyeServices = await get<AnalyticsServices>("ophthalmology", `/analytics/services?${ALL}`);
      const gynServices = await get<AnalyticsServices>("gynecology", `/analytics/services?${ALL}`);
      expect(eyeServices.rows.some((r) => /cataract/i.test(r.service))).toBe(true);
      expect(gynServices.rows.some((r) => /cataract/i.test(r.service))).toBe(false);

      const eyeOptions = await get<AnalyticsFilterOptions>("ophthalmology", "/analytics/filter-options");
      const gynOptions = await get<AnalyticsFilterOptions>("gynecology", "/analytics/filter-options");
      const eyeCampaignIds = new Set(eyeOptions.campaigns.map((c) => c.id));
      expect(gynOptions.campaigns.some((c) => eyeCampaignIds.has(c.id))).toBe(false);
    });

    it("a campaign id from another tenant yields nothing rather than leaking", async () => {
      const eyeOptions = await get<AnalyticsFilterOptions>("ophthalmology", "/analytics/filter-options");
      const leads = await get<LeadsBySourceResponse>("gynecology", `/analytics/leads?${ALL}&campaignId=${eyeOptions.campaigns[0].id}`);
      expect(leads.total).toBe(0);
      const campaigns = await get<AnalyticsCampaigns>("gynecology", `/analytics/campaigns?${ALL}&campaignId=${eyeOptions.campaigns[0].id}`);
      expect(campaigns.rows).toHaveLength(0);
    });

    it("ignores a tenantId smuggled into the query string", async () => {
      const gyn = sessions.gynecology.tenantId;
      const eyeLeads = await get<LeadsBySourceResponse>("ophthalmology", `/analytics/leads?${ALL}&tenantId=${gyn}`);
      const plain = await get<LeadsBySourceResponse>("ophthalmology", `/analytics/leads?${ALL}`);
      expect(eyeLeads.total).toBe(plain.total);
    });

    it("requires a session (401) and marketing + revenue access (403 for front desk)", async () => {
      const anon = await app.inject({ method: "GET", url: "/analytics/summary" });
      expect(anon.statusCode).toBe(401);
      for (const email of ["eye.frontdesk@pulseos.local", "eye.coordinator@pulseos.local", "eye.doctor@pulseos.local"]) {
        const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
        const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
        for (const path of ["summary", "leads", "funnel", "source-conversion", "revenue", "campaigns", "services", "flow", "team", "filter-options"]) {
          const res = await app.inject({ method: "GET", url: `/analytics/${path}?${ALL}`, cookies: { pulseos_session: cookie } });
          expect(res.statusCode, `${email} ${path}`).toBe(403);
        }
      }
    });

    it("rejects malformed filters with 400", async () => {
      for (const bad of ["range=1y", "range=custom", "range=custom&from=2026-02-30&to=2026-03-01", "range=custom&from=2026-03-05&to=2026-03-01", "source=telepathy", "campaignId=not-a-uuid", "branchId=nope"]) {
        const res = await app.inject({ method: "GET", url: `/analytics/leads?${bad}`, cookies: { pulseos_session: sessions.ophthalmology.cookie } });
        expect(res.statusCode, bad).toBe(400);
      }
    });
  });
});
