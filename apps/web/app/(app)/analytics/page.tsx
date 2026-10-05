"use client";

import { Suspense, useCallback, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@pulseos/api-client";
import { hasPermission, type AnalyticsPeriod, type SourceChannel } from "@pulseos/types";
import { AnalyticsPanel, DailySourceChart, ChartSkeleton, Tabs, fmtDayShort } from "@pulseos/ui";
import { OperationsAnalytics } from "@/components/analytics/OperationsAnalytics";
import { useCapability } from "@/lib/useEdition";
import { replaceUrlParams } from "@/lib/urlParams";
import { AnalyticsFilterBar } from "@/components/analytics/AnalyticsFilterBar";
import { ANALYTICS_TABS, DEFAULT_FILTERS, parseFilters, toApiQuery, toSearch, type AnalyticsFilters, type AnalyticsTab } from "@/components/analytics/filters";
import { Async } from "@/components/analytics/common";
import { AnalyticsKpiStrip, FunnelBars, SourceMix } from "@/components/analytics/overview";
import { CampaignTable, LeadTrend, SourceConversion } from "@/components/analytics/acquisition";
import { JourneyOutcomes, ServiceLines } from "@/components/analytics/journey";
import { AdsCampaignTable, AdsKpis, AdsSpendChart, AdsUnavailable, ProviderStrip } from "@/components/analytics/ads";
import { RevenueByService, RevenueEvents, RevenueTrend, RoasBySource, TeamAnalytics } from "@/components/analytics/revenue";

const CHART_H = 250;

function periodCaption(p: AnalyticsPeriod) {
  const range = p.from === p.to ? fmtDayShort(p.from) : `${fmtDayShort(p.from)} – ${fmtDayShort(p.to)}`;
  return `${range} · ${p.days} ${p.days === 1 ? "day" : "days"} · ${p.timezone.replace("_", " ")} · compared with ${fmtDayShort(p.previousFrom)} – ${fmtDayShort(p.previousTo)}${p.previousUntil ? " (to the same time of day, as today is still in progress)" : ""}`;
}

/** Marketing & revenue analytics (Beta V2 growth edition): campaigns, spend, ROAS, revenue. Unchanged. */
function MarketingAnalytics() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);
  const query = useMemo(() => toApiQuery(filters), [filters]);

  // One filter state (the URL) drives every request below.
  const update = useCallback(
    (patch: Partial<AnalyticsFilters>) => {
      const next = { ...filters, ...patch };
      // A campaign belongs to one source: changing the source drops a campaign that no longer fits.
      if (patch.source !== undefined && patch.campaignId === undefined && filters.campaignId) next.campaignId = undefined;
      const qs = toSearch(next);
      // `section=marketing` keeps this page on the Marketing area while its own filters change.
      router.push(`${pathname}?${qs ? `${qs}&` : ""}section=marketing`, { scroll: false });
    },
    [filters, pathname, router],
  );
  const reset = useCallback(() => update({ ...DEFAULT_FILTERS, tab: filters.tab, from: undefined, to: undefined, branchId: undefined, service: undefined, source: undefined, campaignId: undefined }), [filters.tab, update]);

  const tab = filters.tab;
  const opts = { placeholderData: keepPreviousData, staleTime: 30_000 } as const;

  const branches = useQuery({ queryKey: ["branches"], queryFn: api.branches, staleTime: 300_000 });
  const options = useQuery({ queryKey: ["analytics", "options"], queryFn: api.analyticsFilterOptions, staleTime: 300_000 });

  const summary = useQuery({ queryKey: ["analytics", "summary", query], queryFn: () => api.analyticsSummary(query), ...opts });
  const leads = useQuery({ queryKey: ["analytics", "leads", query], queryFn: () => api.analyticsLeads(query), enabled: tab === "overview" || tab === "acquisition", ...opts });
  const funnel = useQuery({ queryKey: ["analytics", "funnel", query], queryFn: () => api.analyticsFunnel(query), enabled: tab === "overview", ...opts });
  const revenue = useQuery({ queryKey: ["analytics", "revenue", query], queryFn: () => api.analyticsRevenue(query), enabled: tab === "overview" || tab === "revenue", ...opts });
  const campaigns = useQuery({ queryKey: ["analytics", "campaigns", query], queryFn: () => api.analyticsCampaigns(query), enabled: tab === "overview" || tab === "acquisition", ...opts });
  const conversion = useQuery({ queryKey: ["analytics", "source-conversion", query], queryFn: () => api.analyticsSourceConversion(query), enabled: tab === "acquisition", ...opts });
  const flow = useQuery({ queryKey: ["analytics", "flow", query], queryFn: () => api.analyticsFlow(query), enabled: tab === "journey", ...opts });
  const services = useQuery({ queryKey: ["analytics", "services", query], queryFn: () => api.analyticsServices(query), enabled: tab === "journey", ...opts });
  const adsData = useQuery({ queryKey: ["analytics", "ads", query], queryFn: () => api.analyticsAds(query), enabled: tab === "ads", ...opts });
  const team = useQuery({ queryKey: ["analytics", "team", query], queryFn: () => api.analyticsTeam(query), enabled: tab === "team", ...opts });

  // Clicking a mark that is already the filter clears it.
  const toggleSource = (s: SourceChannel) => update({ source: filters.source === s || (filters.source === "organic" && s === "other") ? undefined : s });
  const toggleService = (service: string) => update({ service: filters.service === service ? undefined : service });

  return (
    <div className="space-y-4 lg:space-y-5" data-testid="marketing-analytics">
      <div className="space-y-3">
        <Tabs
          variant="underline"
          ariaLabel="Analytics sections"
          value={tab}
          items={ANALYTICS_TABS.map((t) => ({ key: t.key, label: t.label, testId: `analytics-tab-${t.key}` }))}
          onChange={(key) => update({ tab: key as AnalyticsTab })}
        />
        <AnalyticsFilterBar filters={filters} options={options.data} branches={branches.data} onChange={update} onReset={reset} />
        <p className="min-h-4 px-0.5 text-[11px] leading-4 text-ink-2" data-testid="analytics-period">
          {summary.data ? periodCaption(summary.data.period) : "Loading period…"}
        </p>
      </div>

      {tab === "overview" && (
        <>
          <Async query={summary} height={78} error="Could not load the summary.">
            {(d) => <AnalyticsKpiStrip data={d} />}
          </Async>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:gap-5">
            <AnalyticsPanel title="Enquiries by source" question="Which sources are bringing patients in, day by day?" testId="panel-daily-source">
              <Async query={leads} height={CHART_H + 24} error="Could not load enquiries by source.">
                {(d) => <DailySourceChart data={d} height={CHART_H} onSourceClick={toggleSource} activeSource={filters.source} />}
              </Async>
            </AnalyticsPanel>
            <AnalyticsPanel title="Source mix" question="What share of enquiries does each source bring?" testId="panel-source-mix" bodyClassName="flex flex-col">
              <Async query={leads} height={200} error="Could not load the source mix." fill>
                {(d) => <SourceMix data={d} onSourceClick={toggleSource} activeSource={filters.source} />}
              </Async>
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-5">
            <AnalyticsPanel title="Journey funnel" question="Where do enquiries drop off between stages?" testId="panel-funnel">
              <Async query={funnel} height={280} error="Could not load the funnel.">
                {(d) => <FunnelBars data={d} />}
              </Async>
            </AnalyticsPanel>
            <AnalyticsPanel title="Revenue" question="How much revenue was recorded, and when?" testId="panel-revenue">
              <Async query={revenue} height={CHART_H + 24} error="Could not load revenue.">
                {(d) => <RevenueTrend data={d} height={CHART_H} />}
              </Async>
            </AnalyticsPanel>
          </div>

          <AnalyticsPanel title="Campaign performance" question="Which campaigns turn spend into appointments and revenue?" testId="panel-campaigns">
            <Async query={campaigns} height={220} error="Could not load campaigns.">
              {(d) => <CampaignTable data={d} limit={5} />}
            </Async>
          </AnalyticsPanel>
        </>
      )}

      {tab === "acquisition" && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] xl:gap-5">
            <AnalyticsPanel title="Enquiry trend" question="Are enquiries rising or falling against the previous period?" testId="panel-lead-trend">
              <Async query={leads} height={CHART_H + 24} error="Could not load the enquiry trend.">
                {(d) => <LeadTrend data={d} height={CHART_H} />}
              </Async>
            </AnalyticsPanel>
            <AnalyticsPanel title="Source conversion" question="Which sources turn enquiries into patients who progress?" testId="panel-source-conversion">
              <Async query={conversion} height={CHART_H} error="Could not load source conversion.">
                {(d) => <SourceConversion data={d} onSourceClick={toggleSource} />}
              </Async>
            </AnalyticsPanel>
          </div>
          <AnalyticsPanel title="Campaign performance" question="Which campaigns turn spend into appointments and revenue?" testId="panel-campaigns">
            <Async query={campaigns} height={260} error="Could not load campaigns.">
              {(d) => <CampaignTable data={d} />}
            </Async>
          </AnalyticsPanel>
        </>
      )}

      {tab === "journey" && (
        <>
          <AnalyticsPanel title="Journey outcomes" question="How far do journeys from each source and service line get?" testId="panel-flow">
            <Async query={flow} height={300} error="Could not load journey outcomes.">
              {(d) => <JourneyOutcomes data={d} />}
            </Async>
          </AnalyticsPanel>
          <AnalyticsPanel title="Service lines" question="Which service lines bring volume, progress and revenue?" testId="panel-services" footer="Select a row to filter every panel to that service line.">
            <Async query={services} height={260} error="Could not load service lines.">
              {(d) => <ServiceLines data={d} onServiceClick={toggleService} activeService={filters.service} />}
            </Async>
          </AnalyticsPanel>
        </>
      )}

      {tab === "revenue" && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] xl:gap-5">
            <AnalyticsPanel title="Revenue" question="How much revenue was recorded, and when?" testId="panel-revenue">
              <Async query={revenue} height={CHART_H + 24} error="Could not load revenue.">
                {(d) => <RevenueTrend data={d} height={CHART_H + 96} />}
              </Async>
            </AnalyticsPanel>
            <div className="flex min-w-0 flex-col gap-4 xl:gap-5">
              <AnalyticsPanel title="Return on ad spend" question="Which sources earn back their spend?" testId="panel-roas">
                <Async query={revenue} height={140} error="Could not load ROAS.">
                  {(d) => <RoasBySource data={d} />}
                </Async>
              </AnalyticsPanel>
              <AnalyticsPanel title="Revenue by service line" question="Which service lines earn the revenue?" testId="panel-revenue-service" className="flex-1">
                <Async query={revenue} height={140} error="Could not load revenue by service.">
                  {(d) => <RevenueByService data={d} onServiceClick={toggleService} />}
                </Async>
              </AnalyticsPanel>
            </div>
          </div>
          <AnalyticsPanel title="Payments" question="Which payments make up this revenue?" testId="panel-payments">
            <Async query={revenue} height={200} error="Could not load payments.">
              {(d) => <RevenueEvents data={d} />}
            </Async>
          </AnalyticsPanel>
        </>
      )}

      {tab === "ads" && (
        <div className="space-y-4" data-testid="ads-tab">
          <Async query={adsData} height={90} error="Could not load ad accounts.">
            {(d) => (
              <div className="space-y-4">
                <ProviderStrip data={d} />
                {d.unavailable ? (
                  <AdsUnavailable reason={d.unavailable} />
                ) : (
                  <>
                    <AdsKpis data={d} />
                    <AnalyticsPanel title="Ad spend" question="How much did the ad accounts spend each day?" testId="panel-ads-spend">
                      <AdsSpendChart data={d} />
                    </AnalyticsPanel>
                    <AnalyticsPanel title="Ad campaigns" question="Which ad campaigns cost what, and which ones can PulseOS tie to real patients?" testId="panel-ads-campaigns">
                      <AdsCampaignTable data={d} />
                    </AnalyticsPanel>
                  </>
                )}
              </div>
            )}
          </Async>
        </div>
      )}

      {tab === "team" && (
        <AnalyticsPanel title="Team workload and follow-through" question="How are journeys spread across team members, and who is converting them?" testId="panel-team">
          <Async query={team} height={260} error="Could not load team analytics.">
            {(d) => <TeamAnalytics data={d} />}
          </Async>
        </AnalyticsPanel>
      )}
    </div>
  );
}

function AnalyticsHome() {
  const params = useSearchParams();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const hasMarketing = useCapability("MARKETING_ANALYTICS");
  const role = session.data?.user.role;
  // Marketing & revenue analytics need the growth edition AND the marketing + revenue permissions; V1 hospitals see Operations only.
  const canMarketing = hasMarketing && !!role && hasPermission(role, "VIEW_MARKETING") && hasPermission(role, "VIEW_REVENUE");
  const section = params.get("section") === "marketing" && canMarketing ? "marketing" : "operations";

  if (!role) return <div className="mx-auto max-w-7xl"><ChartSkeleton height={320} /></div>;
  return (
    <div className="mx-auto max-w-7xl space-y-4 lg:space-y-5" data-testid="analytics-page">
      {canMarketing && (
        <Tabs
          variant="underline"
          ariaLabel="Analytics areas"
          value={section}
          items={[{ key: "operations", label: "Operations", testId: "analytics-area-operations" }, { key: "marketing", label: "Marketing & revenue", testId: "analytics-area-marketing" }]}
          onChange={(k) => (k === "marketing" ? void replaceUrlParams({ section: "marketing" }) : void replaceUrlParams({ section: undefined }))}
        />
      )}
      {section === "operations" ? <OperationsAnalytics role={role} /> : <MarketingAnalytics />}
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl"><ChartSkeleton height={320} /></div>}>
      <AnalyticsHome />
    </Suspense>
  );
}
