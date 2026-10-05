import { and, count, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { journeys, marketingCampaigns, patients, revenueEvents, tasks, users } from "../../db/schema.js";
import { costPer, roas as roasOf } from "../marketing/formulas.js";
import { getTeamWorkload } from "../dashboard/dashboard.service.js";
import {
  bucketIndex,
  buildBuckets,
  diffDays,
  inLocalRange,
  leadsGranularity,
  localDay,
  resolvePeriod,
  revenueGranularity,
  tzLiteral,
} from "./period.js";
import type {
  AnalyticsCampaignRow,
  AnalyticsCampaigns,
  AnalyticsFilterOptions,
  AnalyticsFlow,
  AnalyticsFlowLink,
  AnalyticsFlowNode,
  AnalyticsFunnel,
  AnalyticsPeriod,
  AnalyticsQuery,
  AnalyticsRatio,
  AnalyticsRevenue,
  AnalyticsServices,
  AnalyticsSummary,
  AnalyticsTeam,
  AnalyticsTeamRow,
  ConversionStageKey,
  JourneyStage,
  LeadsBySourceResponse,
  SourceChannel,
  SourceConversionResponse,
} from "@pulseos/types";

export { resolvePeriod, AnalyticsInputError } from "./period.js";

// --------------------------------------------------------------------------
// Shared vocabulary
// --------------------------------------------------------------------------

/** Canonical stack order — also the fixed colour-slot order in the UI. */
export const SOURCE_ORDER: SourceChannel[] = ["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"];

// Same stage ladder and "furthest stage" logic as the Command Centre's
// getStageReachedCounts: a journey's current stage stands in for the furthest
// it got, and it counts at every stage up to it — once. A "lost" journey is
// not credited past Enquiry (the stage it was lost from is not stored).
const STAGE_LADDER: ConversionStageKey[] = ["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed"];
const stageRank = (stage: JourneyStage) => STAGE_LADDER.indexOf(stage as ConversionStageKey);
export const reached = (stage: JourneyStage, at: ConversionStageKey) => stageRank(stage) >= STAGE_LADDER.indexOf(at);

const FUNNEL_STAGES: { key: ConversionStageKey; label: string }[] = [
  { key: "enquiry", label: "Enquiry" },
  { key: "contacted", label: "Contacted" },
  { key: "booked", label: "Appointment booked" },
  { key: "consulted", label: "Consulted" },
  { key: "treatment_advised", label: "Treatment advised" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
];

const ratio = (numerator: number, denominator: number): AnalyticsRatio => ({ numerator, denominator, rate: denominator > 0 ? numerator / denominator : null });

type ScopeFilters = Pick<AnalyticsQuery, "branchId" | "service" | "source" | "campaignId">;

const scopeOf = (q: AnalyticsQuery): ScopeFilters => ({ branchId: q.branchId, service: q.service, source: q.source, campaignId: q.campaignId });
const hasSliceFilter = (f: ScopeFilters) => Boolean(f.branchId || f.service);

// --------------------------------------------------------------------------
// Fact loading — one scoped row set per question, aggregated in memory so
// every number on the page derives from the same rows. Days are computed in
// SQL with AT TIME ZONE <tenant tz>.
// --------------------------------------------------------------------------

/** Journey-level filters. `journeys` and `patients` must be in the FROM clause. */
function scopeConditions(tenantId: string, f: ScopeFilters): (SQL | undefined)[] {
  return [
    eq(journeys.tenantId, tenantId),
    f.branchId ? eq(patients.branchId, f.branchId) : undefined,
    f.service ? eq(journeys.journeyType, f.service) : undefined,
    f.source ? eq(journeys.source, f.source) : undefined,
    f.campaignId
      ? sql`exists (select 1 from campaign_touchpoints ct where ct.journey_id = ${journeys.id} and ct.tenant_id = ${tenantId} and ct.touch_type = 'first_touch' and ct.campaign_id = ${f.campaignId})`
      : undefined,
  ];
}

interface JourneyFact {
  id: string;
  day: string;
  source: SourceChannel;
  stage: JourneyStage;
  service: string;
  ownerUserId: string | null;
  campaignId: string | null;
}

/** `before` (ISO instant) additionally cuts the window short — used for the previous period's elapsed point. */
export async function fetchJourneys(db: Db, tenantId: string, timezone: string, from: string, to: string, f: ScopeFilters, before?: string | null): Promise<JourneyFact[]> {
  return db
    .select({
      id: journeys.id,
      day: localDay(journeys.createdAt, timezone),
      source: journeys.source,
      stage: journeys.stage,
      service: journeys.journeyType,
      ownerUserId: journeys.ownerUserId,
      campaignId: sql<string | null>`(select ct.campaign_id from campaign_touchpoints ct where ct.journey_id = ${journeys.id} and ct.tenant_id = ${journeys.tenantId} and ct.touch_type = 'first_touch' limit 1)`,
    })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .where(and(...scopeConditions(tenantId, f), inLocalRange(journeys.createdAt, timezone, from, to), before ? lt(journeys.createdAt, new Date(before)) : undefined));
}

interface RevenueFact {
  id: string;
  journeyId: string;
  day: string;
  occurredAt: Date;
  amount: number;
  type: "consultation_fee" | "treatment_payment" | "other";
  service: string;
  source: SourceChannel;
  campaignId: string | null;
}

export async function fetchRevenue(db: Db, tenantId: string, timezone: string, from: string, to: string, f: ScopeFilters, before?: string | null): Promise<RevenueFact[]> {
  return db
    .select({
      id: revenueEvents.id,
      journeyId: revenueEvents.journeyId,
      day: localDay(revenueEvents.occurredAt, timezone),
      occurredAt: revenueEvents.occurredAt,
      amount: revenueEvents.amount,
      type: revenueEvents.type,
      service: journeys.journeyType,
      source: journeys.source,
      campaignId: sql<string | null>`(select ct.campaign_id from campaign_touchpoints ct where ct.journey_id = ${journeys.id} and ct.tenant_id = ${journeys.tenantId} and ct.touch_type = 'first_touch' limit 1)`,
    })
    .from(revenueEvents)
    .innerJoin(journeys, eq(revenueEvents.journeyId, journeys.id))
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .where(and(eq(revenueEvents.tenantId, tenantId), ...scopeConditions(tenantId, f), inLocalRange(revenueEvents.occurredAt, timezone, from, to), before ? lt(revenueEvents.occurredAt, new Date(before)) : undefined));
}

// --------------------------------------------------------------------------
// Spend. Campaign spend is stored as one lifetime figure per campaign, not a
// daily series, so for a period it is PRO-RATED evenly across the local days
// the campaign ran inside that period. When the view is sliced by branch or
// service, each campaign's spend is further allocated by its lead share in
// that slice (cost-per-enquiry x enquiries — the same allocation idea as
// Spend At Risk), so ROAS never divides a slice's revenue by the whole
// campaign's spend.
// --------------------------------------------------------------------------

interface CampaignSpend {
  id: string;
  name: string;
  source: SourceChannel;
  spend: number;
}

export function proratedSpend(spend: number, runStart: string, runEnd: string, from: string, to: string): number {
  if (diffDays(runStart, runEnd) < 0) return 0;
  const runDays = diffDays(runStart, runEnd) + 1;
  const overlapStart = runStart > from ? runStart : from;
  const overlapEnd = runEnd < to ? runEnd : to;
  const overlap = diffDays(overlapStart, overlapEnd) + 1;
  return overlap <= 0 ? 0 : (spend * overlap) / runDays;
}

/** Earliest day a "lifetime" lookup considers — before any PulseOS data can exist. */
const LIFETIME_FROM = "2000-01-01";

async function fetchCampaignSpend(db: Db, tenantId: string, period: AnalyticsPeriod, f: ScopeFilters, journeyFacts: JourneyFact[]): Promise<CampaignSpend[]> {
  const tz = tzLiteral(period.timezone);
  // An open-ended campaign is still running: its run extends to today (local).
  const rows = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      source: marketingCampaigns.source,
      spendAmount: marketingCampaigns.spendAmount,
      startDay: sql<string>`to_char(${marketingCampaigns.startDate} at time zone ${tz}, 'YYYY-MM-DD')`,
      endDay: sql<string | null>`to_char(${marketingCampaigns.endDate} at time zone ${tz}, 'YYYY-MM-DD')`,
    })
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.tenantId, tenantId), f.source ? eq(marketingCampaigns.source, f.source) : undefined, f.campaignId ? eq(marketingCampaigns.id, f.campaignId) : undefined));

  // Enquiry share inside the slice, per campaign (only needed when sliced by branch/service).
  // A campaign with no enquiries in the period falls back to its lifetime enquiry mix, so
  // its spend is not silently dropped from every slice (slices must add up to the whole).
  // A campaign that has never produced an enquiry has no mix to split by and stays out of slices.
  let shareByCampaign: Map<string, number> | null = null;
  if (hasSliceFilter(f)) {
    const countBy = (facts: JourneyFact[]) => {
      const m = new Map<string, number>();
      for (const j of facts) if (j.campaignId) m.set(j.campaignId, (m.get(j.campaignId) ?? 0) + 1);
      return m;
    };
    const wholeFilter = { source: f.source, campaignId: f.campaignId };
    const wholeCount = countBy(await fetchJourneys(db, tenantId, period.timezone, period.from, period.to, wholeFilter));
    const sliceCount = countBy(journeyFacts);
    shareByCampaign = new Map([...wholeCount].map(([id, total]) => [id, (sliceCount.get(id) ?? 0) / total]));
    // Only campaigns that actually carry spend in this period need a share: a long-ended one prorates to 0.
    const idle = rows
      .filter((r) => !wholeCount.has(r.id) && proratedSpend(r.spendAmount, r.startDay, r.endDay ?? period.today, period.from, period.to) > 0)
      .map((r) => r.id);
    if (idle.length) {
      const lifetime = (filter: ScopeFilters) => fetchJourneys(db, tenantId, period.timezone, LIFETIME_FROM, period.to, filter);
      const lifeWhole = countBy(await lifetime(wholeFilter));
      const lifeSlice = countBy(await lifetime(f));
      for (const id of idle) {
        const total = lifeWhole.get(id) ?? 0;
        if (total > 0) shareByCampaign.set(id, (lifeSlice.get(id) ?? 0) / total);
      }
    }
  }

  return rows.map((r) => {
    const prorated = proratedSpend(r.spendAmount, r.startDay, r.endDay ?? period.today, period.from, period.to);
    const share = shareByCampaign ? (shareByCampaign.get(r.id) ?? 0) : 1;
    return { id: r.id, name: r.name, source: r.source, spend: prorated * share };
  });
}

interface Scoped {
  period: AnalyticsPeriod;
  scope: ScopeFilters;
  journeys: JourneyFact[];
  revenue: RevenueFact[];
  campaigns: CampaignSpend[];
}

async function loadScope(db: Db, tenantId: string, query: AnalyticsQuery, now: Date = new Date()): Promise<Scoped> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const scope = scopeOf(query);
  const [journeyFacts, revenue] = await Promise.all([
    fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scope),
    fetchRevenue(db, tenantId, period.timezone, period.from, period.to, scope),
  ]);
  const campaigns = await fetchCampaignSpend(db, tenantId, period, scope, journeyFacts);
  return { period, scope, journeys: journeyFacts, revenue, campaigns };
}

export const sumBy = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((s, r) => s + pick(r), 0);

function spendAndRoas(s: Scoped) {
  const spend = sumBy(s.campaigns, (c) => c.spend);
  const attributedRevenue = sumBy(s.revenue.filter((r) => r.campaignId), (r) => r.amount);
  return { spend, attributedRevenue, roas: roasOf(attributedRevenue, spend) };
}

// --------------------------------------------------------------------------
// Endpoints
// --------------------------------------------------------------------------

export async function getLeadsBySource(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<LeadsBySourceResponse> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const scope = scopeOf(query);
  const [current, previous] = await Promise.all([
    fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scope),
    fetchJourneys(db, tenantId, period.timezone, period.previousFrom, period.previousTo, scope, period.previousUntil),
  ]);

  const granularity = leadsGranularity(period.days);
  const buckets = buildBuckets(period.from, period.days, granularity).map((b) => ({ ...b, total: 0, bySource: {} as Partial<Record<SourceChannel, number>>, previousTotal: 0 as number | null }));

  for (const j of current) {
    const i = bucketIndex(j.day, period.from, period.days, granularity);
    if (i < 0) continue;
    buckets[i].total += 1;
    buckets[i].bySource[j.source] = (buckets[i].bySource[j.source] ?? 0) + 1;
  }
  for (const j of previous) {
    const i = bucketIndex(j.day, period.previousFrom, period.days, granularity);
    if (i >= 0) buckets[i].previousTotal = (buckets[i].previousTotal ?? 0) + 1;
  }

  const present = new Set(current.map((j) => j.source));
  return {
    period,
    granularity,
    sources: SOURCE_ORDER.filter((s) => present.has(s)),
    buckets,
    total: current.length,
    previousTotal: previous.length,
  };
}

export async function getAnalyticsSummary(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsSummary> {
  const s = await loadScope(db, tenantId, query, now);
  const [previousJourneys, previousRevenue] = await Promise.all([
    fetchJourneys(db, tenantId, s.period.timezone, s.period.previousFrom, s.period.previousTo, s.scope, s.period.previousUntil),
    fetchRevenue(db, tenantId, s.period.timezone, s.period.previousFrom, s.period.previousTo, s.scope, s.period.previousUntil),
  ]);
  const { spend, attributedRevenue, roas } = spendAndRoas(s);
  const appointments = s.journeys.filter((j) => reached(j.stage, "booked")).length;

  return {
    period: s.period,
    leads: s.journeys.length,
    previousLeads: previousJourneys.length,
    appointments,
    appointmentRate: s.journeys.length > 0 ? appointments / s.journeys.length : null,
    revenue: sumBy(s.revenue, (r) => r.amount),
    previousRevenue: sumBy(previousRevenue, (r) => r.amount),
    spend,
    attributedRevenue,
    roas,
    costPerLead: costPer(spend, s.journeys.length),
    treatmentsCompleted: s.journeys.filter((j) => j.stage === "completed").length,
  };
}

export async function getAnalyticsFunnel(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsFunnel> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const facts = await fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scopeOf(query));
  const total = facts.length;

  const counts = FUNNEL_STAGES.map((s) => (s.key === "enquiry" ? total : facts.filter((j) => reached(j.stage, s.key)).length));
  return {
    period,
    stages: FUNNEL_STAGES.map((s, i) => ({
      key: s.key,
      label: s.label,
      count: counts[i],
      pctOfLeads: total > 0 ? counts[i] / total : null,
      conversionFromPrevious: i === 0 ? null : counts[i - 1] > 0 ? counts[i] / counts[i - 1] : null,
      dropOff: i === 0 ? 0 : counts[i - 1] - counts[i],
    })),
    lost: facts.filter((j) => j.stage === "lost").length,
  };
}

export async function getSourceConversion(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<SourceConversionResponse> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const facts = await fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scopeOf(query));
  const rows = SOURCE_ORDER.map((source) => {
    const mine = facts.filter((j) => j.source === source);
    return {
      source,
      leads: mine.length,
      toAppointment: ratio(mine.filter((j) => reached(j.stage, "booked")).length, mine.length),
      toConsultation: ratio(mine.filter((j) => reached(j.stage, "consulted")).length, mine.length),
      toTreatment: ratio(mine.filter((j) => reached(j.stage, "treatment_advised")).length, mine.length),
    };
  })
    .filter((r) => r.leads > 0)
    .sort((a, b) => b.leads - a.leads);
  return { period, rows };
}

export async function getAnalyticsRevenue(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsRevenue> {
  const s = await loadScope(db, tenantId, query, now);
  const previous = await fetchRevenue(db, tenantId, s.period.timezone, s.period.previousFrom, s.period.previousTo, s.scope, s.period.previousUntil);
  const granularity = revenueGranularity(s.period.days);
  const buckets = buildBuckets(s.period.from, s.period.days, granularity).map((b) => ({ ...b, revenue: 0, events: 0 }));
  for (const r of s.revenue) {
    const i = bucketIndex(r.day, s.period.from, s.period.days, granularity);
    if (i < 0) continue;
    buckets[i].revenue += r.amount;
    buckets[i].events += 1;
  }

  const { spend, attributedRevenue, roas } = spendAndRoas(s);

  const campaignSource = new Map(s.campaigns.map((c) => [c.id, c.source]));
  const sourceRows = new Map<SourceChannel, { spend: number; attributedRevenue: number }>();
  for (const c of s.campaigns) {
    const row = sourceRows.get(c.source) ?? { spend: 0, attributedRevenue: 0 };
    row.spend += c.spend;
    sourceRows.set(c.source, row);
  }
  for (const r of s.revenue) {
    const source = r.campaignId ? campaignSource.get(r.campaignId) : undefined;
    if (!source) continue;
    const row = sourceRows.get(source) ?? { spend: 0, attributedRevenue: 0 };
    row.attributedRevenue += r.amount;
    sourceRows.set(source, row);
  }

  const byServiceMap = new Map<string, number>();
  for (const r of s.revenue) byServiceMap.set(r.service, (byServiceMap.get(r.service) ?? 0) + r.amount);

  return {
    period: s.period,
    granularity,
    buckets,
    total: sumBy(s.revenue, (r) => r.amount),
    events: s.revenue.length,
    previousTotal: sumBy(previous, (r) => r.amount),
    spend,
    attributedRevenue,
    roas,
    bySource: SOURCE_ORDER.filter((src) => sourceRows.has(src))
      .map((source) => {
        const row = sourceRows.get(source)!;
        return { source, spend: row.spend, attributedRevenue: row.attributedRevenue, roas: roasOf(row.attributedRevenue, row.spend) };
      })
      .sort((a, b) => b.attributedRevenue - a.attributedRevenue || b.spend - a.spend),
    byService: [...byServiceMap].map(([service, revenue]) => ({ service, revenue })).sort((a, b) => b.revenue - a.revenue),
    recent: [...s.revenue]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, 10)
      .map((r) => ({ id: r.id, journeyId: r.journeyId, day: r.day, amount: r.amount, type: r.type, service: r.service, source: r.source })),
  };
}

export async function getAnalyticsCampaigns(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsCampaigns> {
  const s = await loadScope(db, tenantId, query, now);
  const rows: AnalyticsCampaignRow[] = s.campaigns.map((c) => {
    const mine = s.journeys.filter((j) => j.campaignId === c.id);
    const revenue = sumBy(s.revenue.filter((r) => r.campaignId === c.id), (r) => r.amount);
    return {
      campaignId: c.id,
      campaignName: c.name,
      source: c.source,
      spend: c.spend,
      leads: mine.length,
      appointments: mine.filter((j) => reached(j.stage, "booked")).length,
      treatments: mine.filter((j) => j.stage === "completed").length,
      revenue,
      roas: roasOf(revenue, c.spend),
      costPerLead: costPer(c.spend, mine.length),
    };
  });
  rows.sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);
  return {
    period: s.period,
    rows,
    unattributed: {
      leads: s.journeys.filter((j) => !j.campaignId).length,
      revenue: sumBy(s.revenue.filter((r) => !r.campaignId), (r) => r.amount),
    },
  };
}

export async function getAnalyticsServices(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsServices> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const scope = scopeOf(query);
  const [facts, revenue] = await Promise.all([
    fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scope),
    fetchRevenue(db, tenantId, period.timezone, period.from, period.to, scope),
  ]);
  const granularity = leadsGranularity(period.days);
  const bucketCount = buildBuckets(period.from, period.days, granularity).length;

  const services = [...new Set([...facts.map((j) => j.service), ...revenue.map((r) => r.service)])];
  const rows = services
    .map((service) => {
      const mine = facts.filter((j) => j.service === service);
      const trend = new Array<number>(bucketCount).fill(0);
      for (const j of mine) {
        const i = bucketIndex(j.day, period.from, period.days, granularity);
        if (i >= 0) trend[i] += 1;
      }
      return {
        service,
        leads: mine.length,
        appointments: mine.filter((j) => reached(j.stage, "booked")).length,
        consultations: mine.filter((j) => reached(j.stage, "consulted")).length,
        treatmentsAdvised: mine.filter((j) => reached(j.stage, "treatment_advised")).length,
        treatmentsCompleted: mine.filter((j) => j.stage === "completed").length,
        revenue: sumBy(revenue.filter((r) => r.service === service), (r) => r.amount),
        trend,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);
  return { period, granularity, rows };
}

const FLOW_OUTCOMES: { id: string; label: string; stages: JourneyStage[] }[] = [
  { id: "outcome:not_progressed", label: "Not progressed", stages: ["enquiry", "contacted"] },
  { id: "outcome:appointment", label: "Appointment stage", stages: ["booked", "attended"] },
  { id: "outcome:consulted", label: "Consulted", stages: ["consulted"] },
  { id: "outcome:treatment", label: "Treatment advised", stages: ["treatment_advised", "scheduled"] },
  { id: "outcome:completed", label: "Treatment completed", stages: ["completed"] },
  { id: "outcome:lost", label: "Lost", stages: ["lost"] },
];

export const SOURCE_LABEL: Record<SourceChannel, string> = {
  meta: "Meta",
  google: "Google",
  website: "Website",
  whatsapp: "WhatsApp",
  phone: "Phone",
  walk_in: "Walk-in",
  referral: "Referral",
  organic: "Organic",
  other: "Other",
};

export async function getAnalyticsFlow(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsFlow> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const facts = await fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scopeOf(query));

  const sourceService = new Map<string, number>();
  const serviceOutcome = new Map<string, number>();
  const sourceOutcome = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const j of facts) {
    const outcome = FLOW_OUTCOMES.find((o) => o.stages.includes(j.stage))!;
    bump(sourceService, `source:${j.source}\u0000service:${j.service}`);
    bump(serviceOutcome, `service:${j.service}\u0000${outcome.id}`);
    bump(sourceOutcome, `source:${j.source}\u0000${outcome.id}`);
  }

  const links: AnalyticsFlowLink[] = [...sourceService, ...serviceOutcome].map(([k, value]) => {
    const [source, target] = k.split("\u0000");
    return { source, target, value };
  });

  const sourceOutcomes: AnalyticsFlowLink[] = [...sourceOutcome].map(([k, value]) => {
    const [source, target] = k.split("\u0000");
    return { source, target, value };
  });

  const nodes: AnalyticsFlowNode[] = [
    ...SOURCE_ORDER.filter((s) => facts.some((j) => j.source === s)).map((s) => ({ id: `source:${s}`, label: SOURCE_LABEL[s], kind: "source" as const })),
    ...[...new Set(facts.map((j) => j.service))]
      .sort((a, b) => facts.filter((j) => j.service === b).length - facts.filter((j) => j.service === a).length || a.localeCompare(b))
      .map((service) => ({ id: `service:${service}`, label: service, kind: "service" as const })),
    ...FLOW_OUTCOMES.filter((o) => facts.some((j) => o.stages.includes(j.stage))).map((o) => ({ id: o.id, label: o.label, kind: "outcome" as const })),
  ];

  return { period, nodes, links, sourceOutcomes, total: facts.length };
}

const FOLLOW_UP_TYPES = ["FOLLOW_UP", "CALLBACK"] as const;

export async function getAnalyticsTeam(db: Db, tenantId: string, query: AnalyticsQuery, now?: Date): Promise<AnalyticsTeam> {
  const period = await resolvePeriod(db, tenantId, query, now);
  const scope = scopeOf(query);
  const facts = await fetchJourneys(db, tenantId, period.timezone, period.from, period.to, scope);

  // Reuse the Command Centre's team roster and its open / overdue snapshot.
  const roster = await getTeamWorkload(db, tenantId, { branchId: scope.branchId });

  const followUps = await db
    .select({ userId: sql<string | null>`coalesce(${tasks.completedBy}, ${tasks.assignedTo})`, c: count() })
    .from(tasks)
    .innerJoin(patients, eq(tasks.patientId, patients.id))
    .leftJoin(journeys, eq(tasks.journeyId, journeys.id))
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.status, "completed"),
        inArray(tasks.type, [...FOLLOW_UP_TYPES]),
        inLocalRange(tasks.completedAt, period.timezone, period.from, period.to),
        scope.branchId ? eq(patients.branchId, scope.branchId) : undefined,
        scope.service ? eq(journeys.journeyType, scope.service) : undefined,
        scope.source ? eq(journeys.source, scope.source) : undefined,
        scope.campaignId
          ? sql`exists (select 1 from campaign_touchpoints ct where ct.journey_id = ${tasks.journeyId} and ct.tenant_id = ${tenantId} and ct.touch_type = 'first_touch' and ct.campaign_id = ${scope.campaignId})`
          : undefined,
      ),
    )
    .groupBy(sql`coalesce(${tasks.completedBy}, ${tasks.assignedTo})`);
  const followUpsBy = new Map(followUps.map((r) => [r.userId, r.c]));

  const ownerIds = [...new Set(facts.map((j) => j.ownerUserId).filter((id): id is string => Boolean(id)))];
  const known = new Set(roster.map((r) => r.userId));
  const extraOwners = ownerIds.filter((id) => !known.has(id));
  const extra = extraOwners.length
    ? await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, extraOwners)))
    : [];

  const people = [
    ...roster.map((r) => ({ userId: r.userId as string | null, name: r.name, role: r.role as AnalyticsTeamRow["role"], openTasks: r.openTasks, overdueTasks: r.overdueTasks })),
    ...extra.map((u) => ({ userId: u.id as string | null, name: u.name, role: u.role as AnalyticsTeamRow["role"], openTasks: 0, overdueTasks: 0 })),
  ];

  const rows: AnalyticsTeamRow[] = people.map((p) => {
    const mine = facts.filter((j) => j.ownerUserId === p.userId);
    const booked = mine.filter((j) => reached(j.stage, "booked")).length;
    return {
      userId: p.userId,
      name: p.name,
      role: p.role,
      assignedJourneys: mine.length,
      appointmentsBooked: booked,
      conversion: ratio(booked, mine.length),
      followUpsCompleted: followUpsBy.get(p.userId) ?? 0,
      openTasks: p.openTasks,
      overdueTasks: p.overdueTasks,
    };
  });

  const unowned = facts.filter((j) => !j.ownerUserId);
  if (unowned.length > 0) {
    const booked = unowned.filter((j) => reached(j.stage, "booked")).length;
    rows.push({ userId: null, name: "Unassigned", role: null, assignedJourneys: unowned.length, appointmentsBooked: booked, conversion: ratio(booked, unowned.length), followUpsCompleted: 0, openTasks: 0, overdueTasks: 0 });
  }

  rows.sort((a, b) => b.assignedJourneys - a.assignedJourneys || a.name.localeCompare(b.name));
  return { period, rows };
}

export async function getAnalyticsFilterOptions(db: Db, tenantId: string): Promise<AnalyticsFilterOptions> {
  const [services, sources, campaigns] = await Promise.all([
    db.selectDistinct({ v: journeys.journeyType }).from(journeys).where(eq(journeys.tenantId, tenantId)),
    db.selectDistinct({ v: journeys.source }).from(journeys).where(eq(journeys.tenantId, tenantId)),
    db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name, source: marketingCampaigns.source }).from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, tenantId)),
  ]);
  const present = new Set(sources.map((s) => s.v));
  return {
    services: services.map((s) => s.v).sort(),
    sources: SOURCE_ORDER.filter((s) => present.has(s)),
    campaigns: campaigns.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

