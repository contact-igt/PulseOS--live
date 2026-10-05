"use client";

import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, GanttChart, Table2 } from "lucide-react";
import { api } from "@pulseos/api-client";
import { Card, ConnectorModeBadge, EmptyState, ErrorState, FilterBar, FilterSelect, MetricStrip, Panel, Skeleton, SpendAtRisk, Table, TableBody, TableHead, Td, Th, Tr, ViewSwitcher, formatInr, formatMoneyOrDash, formatRoas, localDayKey } from "@pulseos/ui";
import { DATE_PRESETS, resolveDatePreset } from "@pulseos/types";
import type { CampaignFilters, CampaignViewRow, SourceChannel } from "@pulseos/types";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { periodPatch, readPeriodChoice } from "@/components/filters/periodFilter";
import { withFrom } from "@/components/shell/BackLink";
import { useViewState } from "@/lib/useViewState";
import { replaceUrlParams } from "@/lib/urlParams";
import { CampaignCalendar } from "@/components/campaigns/CampaignCalendar";
import { CampaignTimeline } from "@/components/campaigns/CampaignTimeline";
import { CAMPAIGN_VIEWS, SOURCE_LABEL, SOURCE_OPTIONS, campaignFilterPatch, readCampaignFilters } from "@/components/campaigns/runs";
import type { CampaignView } from "@/components/campaigns/runs";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

// Two selects per row on a phone, the date range on its own row; natural widths from sm up.
const FILTER_CLASS = "basis-[calc(50%-0.25rem)]! sm:basis-auto!";

const VIEW_OPTIONS: { key: CampaignView; label: string; icon: ReactNode }[] = [
  { key: "table", label: "Table", icon: <Table2 size={14} /> },
  { key: "calendar", label: "Calendar", icon: <CalendarDays size={14} /> },
  { key: "timeline", label: "Timeline", icon: <GanttChart size={14} /> },
];
const PANEL_TITLE: Record<CampaignView, string> = { table: "Campaign / Source Performance", calendar: "Campaign Calendar", timeline: "Campaign Timeline" };

export default function CampaignsPage() {
  const timeZone = useHospitalTimeZone();
  const router = useRouter();
  const params = useSearchParams();
  // View, date and every filter live in the URL (refresh / back / shared link restore them).
  const { view, date, setView, setDate, calendarMode, setCalendarMode } = useViewState<CampaignView>({ views: CAMPAIGN_VIEWS, defaultView: "table", defaultRange: "month", timeZone });
  const urlFilters = useMemo(() => readCampaignFilters(new URLSearchParams(params.toString())), [params]);
  // The date range is a PulseOS period (shared presets, hospital days, in the URL as prange/pfrom/pto). An older shared
  // link with plain dateFrom/dateTo still works and shows as a custom range.
  const today = localDayKey(new Date(), timeZone);
  const period = useMemo(() => readPeriodChoice(new URLSearchParams(params.toString()), { prefix: "p", presets: DATE_PRESETS }), [params]);
  const span =
    period.range === "custom" && period.from && period.to ? { from: period.from, to: period.to }
    : period.range ? resolveDatePreset(period.range as Parameters<typeof resolveDatePreset>[0], today)
    : urlFilters.dateFrom && urlFilters.dateTo ? { from: urlFilters.dateFrom, to: urlFilters.dateTo }
    : null;
  const filters = useMemo<CampaignFilters>(() => ({ ...urlFilters, dateFrom: span?.from, dateTo: span?.to }), [urlFilters, span?.from, span?.to]);
  const setFilters = useCallback(
    (update: (f: CampaignFilters) => CampaignFilters) => {
      const next = update(urlFilters);
      const cleared: Partial<CampaignFilters> = { branchId: undefined, specialtyKey: undefined, source: undefined, dateFrom: undefined, dateTo: undefined };
      replaceUrlParams(campaignFilterPatch({ ...cleared, ...next }));
    },
    [urlFilters],
  );
  const openCampaign = useCallback((row: CampaignViewRow) => router.push(withFrom(`/campaigns/${row.campaignId}`, "campaigns")), [router]);

  const specialties = useQuery({ queryKey: ["specialties"], queryFn: () => api.specialties() });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });
  const efficiency = useQuery({ queryKey: ["marketing-efficiency", filters], queryFn: () => api.marketingEfficiency(filters) });
  // ONE query feeds the Table, Calendar and Timeline: a view is a presentation, never a different dataset.
  const performance = useQuery({ queryKey: ["campaign-view-rows", filters], queryFn: () => api.campaignViewRows(filters) });
  const spendAtRisk = useQuery({ queryKey: ["campaign-spend-at-risk"], queryFn: api.campaignSpendAtRisk });

  return (
    <div className="mx-auto max-w-7xl space-y-5" data-testid="campaigns-page">
      <FilterBar data-testid="campaigns-filter-bar">
        {(lookups.data?.branches.length ?? 0) > 1 && (
        <FilterSelect className={FILTER_CLASS} value={filters.branchId ?? ""} onChange={(e) => setFilters((f) => ({ ...f, branchId: e.target.value || undefined }))} aria-label="Branch">
          <option value="">All branches</option>
          {lookups.data?.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </FilterSelect>
        )}
        <FilterSelect
          className={FILTER_CLASS}
          value={filters.specialtyKey ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, specialtyKey: e.target.value || undefined }))}
          aria-label="Specialty"
          data-testid="campaigns-specialty-filter"
        >
          <option value="">All specialties</option>
          {specialties.data?.map((s) => (
            <option key={s.key} value={s.key}>
              {s.displayName}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect className={FILTER_CLASS} value={filters.source ?? ""} onChange={(e) => setFilters((f) => ({ ...f, source: (e.target.value as SourceChannel) || undefined }))} aria-label="Source" data-testid="campaigns-source-filter">
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </FilterSelect>
        <PeriodControls
          presets={DATE_PRESETS}
          value={{ range: period.range ?? (span ? "custom" : undefined), from: span?.from, to: span?.to }}
          today={today}
          noneLabel="Any date"
          maxSpanDays={366}
          label="Campaign period"
          testIdPrefix="campaigns"
          onChange={(next) => void replaceUrlParams({ ...periodPatch(next, { prefix: "p", defaultRange: "" }), dateFrom: undefined, dateTo: undefined })}
        />
        {(filters.branchId || filters.specialtyKey || filters.source || span) && (
          <button type="button" onClick={() => { setFilters(() => ({})); void replaceUrlParams(periodPatch({ range: undefined, from: undefined, to: undefined }, { prefix: "p", defaultRange: "" })); }} className="text-xs font-medium text-primary-700 hover:underline">
            Clear filters
          </button>
        )}
      </FilterBar>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">Marketing Efficiency</h2>
        {efficiency.isLoading && <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
        {efficiency.isError && <ErrorState message="Could not load marketing efficiency." />}
        {efficiency.data && (
          <div className="space-y-2">
            {/* Primary: the numbers that answer "is this spend working" at a glance. */}
            <MetricStrip
              testId="marketing-efficiency-strip"
              cells={[
                { key: "spend", label: "Marketing Spend", value: formatInr(efficiency.data.spend) },
                { key: "leads", label: "Leads", value: efficiency.data.leads },
                { key: "appointments", label: "Appointments", value: efficiency.data.appointments },
                { key: "treatments", label: "Treatments", value: efficiency.data.treatments },
                { key: "revenue", label: "Attributed Revenue", value: formatInr(efficiency.data.revenue) },
                { key: "roas", label: "ROAS", value: formatRoas(efficiency.data.roas) },
              ]}
            />
            {/* Secondary: derived cost/volume detail — same data, deliberately smaller and quieter than the primary row. */}
            <Card tone="info" className="grid grid-cols-2 gap-2 px-4 py-2.5 sm:grid-cols-4" data-testid="marketing-efficiency-secondary">
              {[
                { key: "consultations", label: "Consultations", value: efficiency.data.consultations },
                { key: "cpl", label: "Cost / Lead", value: formatMoneyOrDash(efficiency.data.cpl) },
                { key: "cpa", label: "Cost / Appointment", value: formatMoneyOrDash(efficiency.data.costPerAppointment) },
                { key: "cpt", label: "Cost / Treatment", value: formatMoneyOrDash(efficiency.data.costPerTreatment) },
              ].map((cell) => (
                <div key={cell.key} data-testid={`metric-${cell.key}`}>
                  <span className="block text-sm font-semibold tabular-nums text-ink">{cell.value}</span>
                  <span className="block text-[11px] text-ink-2">{cell.label}</span>
                </div>
              ))}
            </Card>
          </div>
        )}
      </section>

      {/* Stacked, not side-by-side — the performance table has 13 real
          columns (min-w 860px) and was getting squeezed into a ~750px
          column next to Spend At Risk, clipping the last few columns with
          no visible scroll affordance. Full width removes the need to
          scroll at all on any desktop viewport this product targets. */}
      <div className="space-y-5">
        <Panel padded={false}>
          {/* Own header (not Panel's title/action) so the view switcher wraps under the title on a phone instead of squeezing it. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="min-w-0 text-sm font-semibold tracking-tight text-ink">{PANEL_TITLE[view]}</h2>
              {performance.data && <span className="text-xs text-ink-2">{performance.data.length} campaigns</span>}
            </div>
            <ViewSwitcher<CampaignView> ariaLabel="Campaigns view" value={view} onChange={setView} options={VIEW_OPTIONS} />
          </div>
          {performance.isLoading && <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
          {performance.isError && <ErrorState message="Could not load campaign performance." />}
          {performance.data && performance.data.length === 0 && <EmptyState message="No campaigns match these filters." />}
          {view === "calendar" && performance.data && performance.data.length > 0 && (
            <CampaignCalendar rows={performance.data} mode={calendarMode} date={date} onDateChange={setDate} onModeChange={setCalendarMode} onOpen={openCampaign} />
          )}
          {view === "timeline" && performance.data && performance.data.length > 0 && (
            <CampaignTimeline rows={performance.data} date={date} onDateChange={setDate} onOpen={openCampaign} />
          )}
          {view === "table" && performance.data && performance.data.length > 0 && (
            <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHead>
                <tr>
                  <Th leading>Campaign</Th>
                  <Th>Source</Th>
                  <Th align="right">Spend</Th>
                  <Th align="right">Leads</Th>
                  <Th align="right">Appts</Th>
                  <Th align="right">Consults</Th>
                  <Th align="right">Tx Advised</Th>
                  <Th align="right">Tx Completed</Th>
                  <Th align="right">Revenue</Th>
                  <Th align="right">CPL</Th>
                  <Th align="right">Cost/Appt</Th>
                  <Th align="right">Cost/Tx</Th>
                  <Th align="right">ROAS</Th>
                </tr>
              </TableHead>
              <TableBody>
                {performance.data.map((row) => (
                  <Tr key={row.campaignId ?? row.campaignName} data-testid={`campaign-row-${row.campaignId ?? row.campaignName}`}>
                    <Td leading nowrap={false} className="text-ink">
                      <span className="flex items-center gap-1.5">
                        {row.campaignId ? (
                          <Link href={withFrom(`/campaigns/${row.campaignId}`, "campaigns")} className="font-medium text-primary-700 hover:underline">
                            {row.campaignName}
                          </Link>
                        ) : (
                          row.campaignName
                        )}
                        <ConnectorModeBadge mode={row.connectorMode} />
                      </span>
                      {row.specialtyLabel && <span className="block text-[11px] text-neutral-400">{row.specialtyLabel}</span>}
                    </Td>
                    <Td className="text-ink-2">{SOURCE_LABEL[row.source as SourceChannel] ?? row.source}</Td>
                    <Td align="right">{formatInr(row.spend)}</Td>
                    <Td align="right">{row.leads}</Td>
                    <Td align="right">{row.appointments}</Td>
                    <Td align="right">{row.consultations}</Td>
                    <Td align="right">{row.treatmentAdvised}</Td>
                    <Td align="right">{row.treatmentCompleted}</Td>
                    <Td align="right">{formatInr(row.revenue)}</Td>
                    <Td align="right">{formatMoneyOrDash(row.cpl)}</Td>
                    <Td align="right">{formatMoneyOrDash(row.costPerAppointment)}</Td>
                    <Td align="right">{formatMoneyOrDash(row.costPerTreatment)}</Td>
                    <Td align="right" className="font-medium">{formatRoas(row.roas)}</Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </Panel>

        {spendAtRisk.isLoading ? <Skeleton className="h-64" /> : spendAtRisk.isError ? <ErrorState message="Could not load spend at risk." /> : spendAtRisk.data && <SpendAtRisk data={spendAtRisk.data} />}
      </div>
    </div>
  );
}
