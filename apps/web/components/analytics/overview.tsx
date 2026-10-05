"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { AnalyticsFunnel, AnalyticsSummary, LeadsBySourceResponse, SourceChannel } from "@pulseos/types";
import {
  ChartEmptyState,
  ChartTooltipCard,
  CHART_INK,
  MetricSummary,
  MetricSummaryStrip,
  SOURCE_LABELS,
  TrendIndicator,
  chartSourceKey,
  fmtCountNum,
  fmtPct,
  fmtRoasX,
  formatInrCompact,
  sourceColor,
} from "@pulseos/ui";

export const prevLabel = (days: number, preset: string) => (preset === "custom" ? "previous period" : `prev ${days}D`);

/** Row 1: the headline numbers for the period, all from one /analytics/summary response. */
export function AnalyticsKpiStrip({ data }: { data: AnalyticsSummary }) {
  const prev = prevLabel(data.period.days, data.period.preset);
  return (
    <MetricSummaryStrip columns={6} testId="analytics-kpis">
      <MetricSummary
        label="Enquiries"
        value={<span data-testid="kpi-leads">{fmtCountNum(data.leads)}</span>}
        sub={<TrendIndicator current={data.leads} previous={data.previousLeads} label={prev} />}
      />
      <MetricSummary
        label="Enquiry → appointment"
        value={<span data-testid="kpi-appointment-rate">{fmtPct(data.appointmentRate)}</span>}
        sub={`${fmtCountNum(data.appointments)} of ${fmtCountNum(data.leads)} enquiries`}
      />
      <MetricSummary label="Cost per enquiry" value={data.costPerLead === null ? "—" : formatInrCompact(data.costPerLead)} sub="Pro-rated spend ÷ enquiries" />
      <MetricSummary label="Marketing spend" value={formatInrCompact(data.spend)} sub="Pro-rated to this period" />
      <MetricSummary
        label="Revenue"
        value={<span data-testid="kpi-revenue">{formatInrCompact(data.revenue)}</span>}
        sub={<TrendIndicator current={data.revenue} previous={data.previousRevenue} label={prev} />}
      />
      <MetricSummary
        label="ROAS"
        value={<span data-testid="kpi-roas">{fmtRoasX(data.roas)}</span>}
        sub={data.roas === null ? "No campaign spend in scope" : `${formatInrCompact(data.attributedRevenue)} attributed`}
      />
    </MetricSummaryStrip>
  );
}

/** Source mix: one donut (part-to-whole) with the numbers listed beside it. Selecting a source filters the page. */
export function SourceMix({ data, onSourceClick, activeSource }: { data: LeadsBySourceResponse; onSourceClick?: (s: SourceChannel) => void; activeSource?: SourceChannel }) {
  const totals = new Map<SourceChannel, number>();
  for (const b of data.buckets) for (const [s, n] of Object.entries(b.bySource) as [SourceChannel, number][]) totals.set(chartSourceKey(s), (totals.get(chartSourceKey(s)) ?? 0) + n);
  const slices = [...totals].map(([source, value]) => ({ source, value })).sort((a, b) => b.value - a.value);
  if (data.total === 0) return <ChartEmptyState height={200} message="No enquiries in this period" />;
  const paid = (totals.get("meta") ?? 0) + (totals.get("google") ?? 0);

  return (
    <div className="flex h-full flex-col justify-center gap-4" data-testid="source-mix">
      <div className="flex flex-col items-center gap-3 sm:flex-row lg:flex-col xl:flex-row">
      <div className="relative h-[140px] w-[140px] shrink-0" role="img" aria-label={`Source mix of ${data.total} enquiries`}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 140, height: 140 }}>
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="source" innerRadius={44} outerRadius={66} paddingAngle={slices.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false} startAngle={90} endAngle={-270}>
              {slices.map((s) => (
                <Cell key={s.source} fill={sourceColor(s.source)} cursor={onSourceClick ? "pointer" : undefined} onClick={() => onSourceClick?.(s.source)} opacity={activeSource && chartSourceKey(activeSource) !== s.source ? 0.35 : 1} />
              ))}
            </Pie>
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { source: SourceChannel; value: number };
                return <ChartTooltipCard title={SOURCE_LABELS[p.source]} rows={[{ key: p.source, label: "Enquiries", color: sourceColor(p.source), value: fmtCountNum(p.value), share: fmtPct(p.value / data.total) }]} />;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold leading-6 tabular-nums text-ink">{fmtCountNum(data.total)}</span>
          <span className="text-[11px] leading-4 text-ink-2">enquiries</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-0.5">
        {slices.map((s) => {
          const body = (
            <>
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: sourceColor(s.source) }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left text-xs text-ink">{SOURCE_LABELS[s.source]}</span>
              <span className="text-xs font-semibold tabular-nums text-ink">{fmtCountNum(s.value)}</span>
              <span className="w-9 text-right text-xs tabular-nums text-ink-2">{fmtPct(s.value / data.total)}</span>
            </>
          );
          return (
            <li key={s.source}>
              {onSourceClick ? (
                <button type="button" onClick={() => onSourceClick(s.source)} className="flex w-full items-center gap-2 rounded-chip px-1 py-0.5 transition hover:bg-primary-50" data-testid={`mix-${s.source}`}>
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-1 py-0.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      </div>
      <p className="border-t border-line pt-2 text-[11px] leading-4 text-ink-2">
        Paid channels (Meta + Google): <span className="font-semibold tabular-nums text-ink">{fmtCountNum(paid)}</span> of {fmtCountNum(data.total)} enquiries ({fmtPct(paid / data.total)}).
      </p>
    </div>
  );
}

/**
 * Journey funnel on canonical stages. Each journey counts once, at its furthest
 * stage, so the bars only ever narrow. The pale track behind a bar reaches out
 * to the previous stage: the gap is the drop-off, printed beside it.
 */
export function FunnelBars({ data }: { data: AnalyticsFunnel }) {
  const top = data.stages[0]?.count ?? 0;
  if (top === 0) return <ChartEmptyState height={240} message="No enquiries in this period" hint="A funnel needs at least one enquiry." />;
  return (
    <div data-testid="funnel">
      <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_3.5rem] items-center gap-x-2 px-0.5 pb-1 text-[11px] font-medium text-ink-2 sm:grid-cols-[9.5rem_minmax(0,1fr)_3.5rem_3.75rem_3.75rem]" aria-hidden="true">
        <span>Stage</span>
        <span className="hidden sm:block" />
        <span className="text-right">Journeys</span>
        <span className="text-right">% of start</span>
        <span className="text-right">Drop-off</span>
      </div>
      <ul className="divide-y divide-line/60">
        {data.stages.map((s, i) => {
          const prev = i > 0 ? data.stages[i - 1].count : s.count;
          return (
            <li key={s.key} className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_3.5rem] items-center gap-x-2 py-1.5 sm:grid-cols-[9.5rem_minmax(0,1fr)_3.5rem_3.75rem_3.75rem]" data-testid={`funnel-${s.key}`}>
              <span className="truncate text-xs text-ink" title={s.conversionFromPrevious === null ? s.label : `${s.label}: ${fmtPct(s.conversionFromPrevious)} of the previous stage`}>
                {s.label}
              </span>
              <span className="relative hidden h-4 sm:block" aria-hidden="true">
                <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${(prev / top) * 100}%`, backgroundColor: CHART_INK.track }} />
                {s.count > 0 && <span className="absolute inset-y-[2px] left-0 rounded-r-[4px]" style={{ width: `${(s.count / top) * 100}%`, backgroundColor: CHART_INK.accent, minWidth: 3 }} />}
              </span>
              <span className="text-right text-xs font-semibold tabular-nums text-ink">{fmtCountNum(s.count)}</span>
              <span className="text-right text-xs tabular-nums text-ink">{fmtPct(s.pctOfLeads)}</span>
              <span className="text-right text-xs tabular-nums text-ink-2">{i === 0 ? "—" : s.dropOff === 0 ? "0" : `−${fmtCountNum(s.dropOff)}`}</span>
            </li>
          );
        })}
      </ul>
      {data.lost > 0 && <p className="mt-2 text-[11px] leading-4 text-ink-2">{data.lost} lost {data.lost === 1 ? "journey is" : "journeys are"} counted at Enquiry only — the stage they were lost from is not recorded.</p>}
    </div>
  );
}
