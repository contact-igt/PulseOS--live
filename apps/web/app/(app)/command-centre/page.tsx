"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@pulseos/api-client";
import { DATE_PRESETS, resolveDatePreset } from "@pulseos/types";
import {
  AnalyticsPanel,
  AttentionQueue,
  ChartSkeleton,
  DailySourceChart,
  ErrorState,
  ExecutiveStripSection,
  FilterBar,
  FilterSelect,
  JourneyFunnel,
  PatientFlowBoard,
  ServiceLinePanel,
  Skeleton,
  SourcePerformanceTable,
  SpendAtRisk,
  TeamPanel,
  TodayPulse,
  Tabs,
  Toolbar,
  formatKey,
  localDayKey,
} from "@pulseos/ui";
import { OperationsReportView } from "@/components/report/OperationsReportView";
import { PerformanceView } from "@/components/command-centre/PerformanceView";
import { WorkspaceWelcome, shouldShowWorkspaceWelcome } from "@/components/command-centre/WorkspaceWelcome";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { withFrom } from "@/components/shell/BackLink";
import { useCapability } from "@/lib/useEdition";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { parseFilters } from "@/components/analytics/filters";

/**
 * Command Centre composition (top to bottom):
 *  1. Hospital performance (the selected period, whole hospital): revenue anchor, spend, ROAS, volume.
 *  2. Today: a quiet operational strip — always today, follows branch + service.
 *  3. Primary analytics: the journey funnel (period) + a right stack (Spend At
 *     Risk — live, patient flow — today).
 *  4. Where the revenue comes from: service lines + campaigns (period).
 *  5. What needs a person: attention queue + team (live) / doctor load (period).
 *
 * One period (the shared Analytics presets, hospital timezone, kept in the URL
 * with branch + service) drives every period widget. Live snapshots say "now"
 * or "today" and never pretend to follow it.
 */
export default function CommandCentrePage() {
  const url = useUrlFilters();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  // A hospital that does not run a revenue workflow lands on Performance (funnel, drop-offs, source, team); the rest open on Overview.
  const revenueTracking = useCapability("REVENUE_TRACKING");
  const requested = url.get("cc");
  const tab: "overview" | "performance" | "report" = requested === "report" ? "report" : requested === "performance" ? "performance" : requested === "overview" ? "overview" : revenueTracking ? "overview" : "performance";
  // A brand-new hospital has nothing to chart yet: show how PulseOS works and what to do first instead of a wall of zeros.
  const setup = useQuery({ queryKey: ["dashboard", "setup-status"], queryFn: api.setupStatus, staleTime: 30_000 });
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Tabs
        variant="underline"
        ariaLabel="Command Centre sections"
        value={tab}
        onChange={(k) => url.set({ cc: k })}
        items={[
          { key: "overview", label: "Overview", testId: "cc-tab-overview" },
          { key: "performance", label: "Performance", testId: "cc-tab-performance" },
          { key: "report", label: "Operations report", testId: "cc-tab-report" },
        ]}
      />
      {tab === "report" ? (
        session.data && <OperationsReportView role={session.data.user.role} />
      ) : shouldShowWorkspaceWelcome(setup.data) ? (
        <WorkspaceWelcome status={setup.data} hospitalName={session.data?.user.tenantName} role={session.data?.user.role} />
      ) : tab === "performance" ? (
        <PerformanceView />
      ) : (
        <CommandCentreOverview />
      )}
    </div>
  );
}

function CommandCentreOverview() {
  const router = useRouter();
  const params = useSearchParams();
  const url = useUrlFilters();
  const tz = useHospitalTimeZone();
  const f = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);
  const branchId = f.branchId ?? "";
  const journeyType = f.service ?? "";
  const setBranchId = (v: string) => url.set({ branch: v || undefined });
  const setJourneyType = (v: string) => url.set({ service: v || undefined });
  const todayKey = localDayKey(new Date(), tz);

  // Spend, ROAS and source-performance panels exist only in the growth edition; a Beta V1 tenant neither shows nor requests them.
  const growth = useCapability("SPEND_ATTRIBUTION");
  const analyticsLink = useCapability("MARKETING_ANALYTICS");
  const revenue = useCapability("REVENUE_TRACKING");

  // The period is always sent: an absent range would mean "all time" to the API.
  const period = { range: f.range, from: f.from, to: f.to };
  const scope = { branchId: branchId || undefined, journeyType: journeyType || undefined };
  const filters = { ...scope, ...period };
  const resolved = f.range === "custom" && f.from && f.to ? { from: f.from, to: f.to } : resolveDatePreset(f.range === "custom" ? "30d" : f.range, todayKey);
  const presetLabel = DATE_PRESETS.find((p) => p.key === f.range)?.label ?? "Last 14 days";
  const day = (k: string) => formatKey(k, { day: "numeric", month: "short" });
  // Say only what this edition shows: a Beta V1 tenant has no spend, ROAS or campaign panels to mention.
  const scopeNote = growth
    ? "The period drives hospital performance, the funnel, enquiries by source, service lines, campaigns and doctor load; Today, flow, spend at risk, attention and team are live. Branch and service narrow everything except hospital performance and campaigns."
    : "The period drives the funnel, enquiries by source, service lines and doctor load; Today, flow, attention and team are live. Branch and service narrow everything.";
  const periodLabel = resolved.from === resolved.to ? `${presetLabel} · ${day(resolved.from)}` : `${presetLabel} · ${day(resolved.from)} – ${day(resolved.to)}`;

  const branches = useQuery({ queryKey: ["branches"], queryFn: api.branches });
  const journeyTypes = useQuery({ queryKey: ["journey-types"], queryFn: api.journeyTypes });

  const executive = useQuery({ queryKey: ["dashboard", "executive", period], queryFn: () => api.executive(period), enabled: growth });
  const today = useQuery({ queryKey: ["dashboard", "today", scope], queryFn: () => api.today(scope) });
  const journeyHealth = useQuery({ queryKey: ["dashboard", "journey-health", filters], queryFn: () => api.journeyHealth(filters) });
  const patientFlow = useQuery({ queryKey: ["dashboard", "patient-flow", scope], queryFn: () => api.patientFlow(scope) });
  const attention = useQuery({ queryKey: ["dashboard", "attention", scope], queryFn: () => api.attention(scope) });
  const spendAtRisk = useQuery({ queryKey: ["dashboard", "spend-at-risk-by-reason", scope], queryFn: () => api.spendAtRiskByReason(scope), enabled: growth });
  const sourcePerformance = useQuery({ queryKey: ["dashboard", "source-performance", period], queryFn: () => api.sourcePerformance(period), enabled: growth });
  const serviceMix = useQuery({ queryKey: ["dashboard", "service-mix", { branchId: scope.branchId, ...period }], queryFn: () => api.serviceMix({ branchId: scope.branchId, ...period }) });
  const team = useQuery({ queryKey: ["dashboard", "team", scope], queryFn: () => api.team(scope) });
  const branchDoctor = useQuery({ queryKey: ["dashboard", "branch-doctor", { branchId: scope.branchId, ...period }], queryFn: () => api.branchDoctor({ branchId: scope.branchId, ...period }) });

  const dailyLeads = useQuery({
    queryKey: ["analytics", "leads", { ...period, branchId: scope.branchId, service: scope.journeyType }],
    queryFn: () => api.analyticsLeads({ ...period, branchId: scope.branchId, service: scope.journeyType }),
  });

  const doctors = branchDoctor.data?.filter((r) => r.kind === "doctor");

  return (
    <div className="mx-auto max-w-7xl space-y-4 lg:space-y-5" data-testid="command-centre">
      <Toolbar
        actions={
          <FilterBar data-testid="filter-bar" className="w-full sm:w-auto">
            <PeriodControls
              presets={DATE_PRESETS}
              maxSpanDays={366}
              value={period}
              today={todayKey}
              onChange={(next) => url.set({ range: next.range === "30d" ? undefined : next.range, from: next.range === "custom" ? next.from : undefined, to: next.range === "custom" ? next.to : undefined })}
              testIdPrefix="cc"
              label="Period"
            />
            {(branches.data?.length ?? 0) > 1 && (
            <FilterSelect value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Branch" data-testid="filter-branch" className="max-md:[&_select]:h-11">
              <option value="">All branches</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </FilterSelect>
            )}
            <FilterSelect value={journeyType} onChange={(e) => setJourneyType(e.target.value)} aria-label="Service" data-testid="filter-service" className="max-md:[&_select]:h-11">
              <option value="">All services</option>
              {journeyTypes.data?.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </FilterSelect>
          </FilterBar>
        }
      >
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-ink">Hospital performance</h2>
          <p className="text-xs text-ink-2" data-testid="cc-period-caption">
            {periodLabel} · whole hospital
            <span className="hidden lg:inline">. {scopeNote}</span>
          </p>
        </div>
      </Toolbar>

      <section aria-label="Hospital performance" className="space-y-2.5">
        {growth && executive.isLoading && <Skeleton className="h-[76px]" />}
        {growth && executive.isError && <ErrorState message="Could not load hospital performance." />}
        {growth && executive.data && (
          <ExecutiveStripSection
            data={executive.data}
            onSpendAtRiskClick={() => document.getElementById("spend-at-risk-panel")?.scrollIntoView({ behavior: "smooth", block: "center" })}
          />
        )}
        {today.isLoading && <Skeleton className="h-12" />}
        {today.isError && <ErrorState message="Could not load today's summary." />}
        {today.data && <TodayPulse data={today.data} onStatClick={(key) => router.push(`/patients?filter=${String(key)}`)} />}
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] xl:gap-5">
        {journeyHealth.isLoading ? (
          <Skeleton className="h-80" />
        ) : journeyHealth.isError ? (
          <ErrorState message="Could not load journey performance." />
        ) : (
          journeyHealth.data && (
            <JourneyFunnel
              stages={[
                { key: "enquiry", label: "Enquiries", count: journeyHealth.data.totalJourneys },
                ...journeyHealth.data.segments.map((s) => ({ key: s.key, label: s.label, count: s.count })),
              ]}
              onStageClick={(key) => router.push(key === "enquiry" ? "/journeys" : `/journeys?stage=${key}`)}
            />
          )
        )}
        <div className="flex min-w-0 flex-col gap-4 xl:gap-5">
          {!growth ? null : spendAtRisk.isLoading ? (
            <Skeleton className="h-64" />
          ) : spendAtRisk.isError ? (
            <ErrorState message="Could not load spend at risk." />
          ) : (
            spendAtRisk.data && (
              <SpendAtRisk
                data={spendAtRisk.data}
                marketingSpend={executive.data?.marketingSpend}
                onReasonClick={(reason) => router.push(`/patients?filter=${reason}`)}
              />
            )
          )}
          {patientFlow.isLoading ? (
            <Skeleton className="h-28" />
          ) : patientFlow.isError ? (
            <ErrorState message="Could not load patient flow." />
          ) : (
            patientFlow.data && <PatientFlowBoard data={patientFlow.data} onBucketClick={(bucket) => router.push(`/appointments?flow=${bucket}`)} compact />
          )}
        </div>
      </div>

      <AnalyticsPanel
        title="Enquiries by source"
        question={`${presetLabel} — which sources brought patients in each day?`}
        testId="cc-daily-source"
        actions={
          analyticsLink ? (
            <Link href="/analytics" className="text-xs font-medium text-primary-700 hover:underline" data-testid="view-analytics-link">
              View Analytics →
            </Link>
          ) : null
        }
      >
        {dailyLeads.isLoading ? (
          <ChartSkeleton height={150} />
        ) : dailyLeads.isError ? (
          <ErrorState message="Could not load enquiries by source." />
        ) : (
          dailyLeads.data && <DailySourceChart data={dailyLeads.data} height={150} compact />
        )}
      </AnalyticsPanel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] xl:gap-5">
        {serviceMix.isLoading ? (
          <Skeleton className="h-72" />
        ) : serviceMix.isError ? (
          <ErrorState message="Could not load service lines." />
        ) : (
          serviceMix.data && <ServiceLinePanel rows={serviceMix.data} selected={journeyType} onSelect={setJourneyType} showRevenue={revenue} />
        )}
        {!growth ? null : sourcePerformance.isLoading ? (
          <Skeleton className="h-72" />
        ) : sourcePerformance.isError ? (
          <ErrorState message="Could not load source performance." />
        ) : (
          sourcePerformance.data && (
            <SourcePerformanceTable rows={sourcePerformance.data} onRowClick={(row) => router.push(`/journeys?campaignId=${row.campaignId ?? ""}`)} compact />
          )
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] xl:gap-5">
        {attention.isLoading ? (
          <Skeleton className="h-64" />
        ) : attention.isError ? (
          <ErrorState message="Could not load attention queue." />
        ) : (
          attention.data && (
            <AttentionQueue
              items={attention.data}
              // `item.id` is the TASK id; the journey (or, failing that, the
              // patient) is what the row actually opens.
              onItemClick={(item) =>
                router.push(withFrom(item.journeyId ? `/journeys/${item.journeyId}` : `/patients/${item.patientId}`, "command-centre"))
              }
            />
          )
        )}
        {team.isLoading || branchDoctor.isLoading ? (
          <Skeleton className="h-64" />
        ) : team.isError || branchDoctor.isError ? (
          <ErrorState message="Could not load team workload." />
        ) : (
          team.data && doctors && <TeamPanel team={team.data} doctors={doctors} />
        )}
      </div>
    </div>
  );
}
