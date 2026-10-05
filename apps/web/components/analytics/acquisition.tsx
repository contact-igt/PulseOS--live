"use client";

import { useState } from "react";
import Link from "next/link";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsCampaigns, LeadsBySourceResponse, SourceChannel, SourceConversionResponse } from "@pulseos/types";
import {
  CHART_INK,
  ChartEmptyState,
  ChartLegend,
  ChartTooltipCard,
  SOURCE_LABELS,
  Table,
  TableBody,
  TableHead,
  TableShell,
  Tabs,
  Td,
  Th,
  Tr,
  chartSourceKey,
  fmtBucketLabel,
  fmtCountNum,
  fmtDayShort,
  fmtPct,
  fmtRoasX,
  niceCountAxis,
  formatInr,
  formatInrCompact,
  sourceColor,
  splitInProgress,
} from "@pulseos/ui";
import { RankedBars, type BarRow } from "./common";
import { prevLabel } from "./overview";

/** Enquiries over time against the previous period of the same length. */
export function LeadTrend({ data, height = 240 }: { data: LeadsBySourceResponse; height?: number }) {
  if (data.total === 0 && data.previousTotal === 0) return <ChartEmptyState height={height} message="No enquiries in this period or the one before it" />;
  const showPrev = data.previousTotal > 0;
  const prev = prevLabel(data.period.days, data.period.preset);
  const split = splitInProgress(data.buckets, data.buckets.map((b) => b.total), data.period.today);
  const rows = data.buckets.map((b, i) => ({
    label: fmtDayShort(b.key),
    span: fmtBucketLabel(b),
    current: b.total,
    closed: split.closed[i],
    open: split.open[i],
    inProgress: i === split.openIndex,
    previous: b.previousTotal ?? 0,
  }));
  const axis = niceCountAxis(Math.max(...rows.map((r) => Math.max(r.current, r.previous)), 0));
  const unit = data.granularity === "day" ? "day" : "week";

  return (
    <div data-testid="lead-trend">
      <ChartLegend
        className="mb-2"
        items={[
          { key: "current", label: `This period (${fmtCountNum(data.total)})`, color: CHART_INK.accent },
          ...(showPrev ? [{ key: "previous", label: `Previous period (${fmtCountNum(data.previousTotal)})`, color: CHART_INK.context }] : []),
        ]}
      />
      <div role="img" aria-label={`Enquiries per ${unit}: ${data.total} this period, ${data.previousTotal} in the previous period`} style={{ height }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
          <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: CHART_INK.baseline }} tick={{ fontSize: 11, fill: CHART_INK.secondary }} interval="equidistantPreserveStart" minTickGap={14} tickMargin={6} />
            <YAxis width={26} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART_INK.secondary }} domain={[0, axis.max]} ticks={axis.ticks} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: CHART_INK.baseline }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as (typeof rows)[number];
                return (
                  <ChartTooltipCard
                    title={r.span}
                    rows={[
                      { key: "c", label: "This period", color: CHART_INK.accent, value: fmtCountNum(r.current) },
                      ...(showPrev ? [{ key: "p", label: `Same ${unit}, ${prev}`, color: CHART_INK.context, value: fmtCountNum(r.previous) }] : []),
                    ]}
                    note={r.inProgress ? `${unit === "day" ? "Today" : "This week"} is still in progress — counted so far.` : undefined}
                  />
                );
              }}
            />
            {showPrev && <Line type="linear" dataKey="previous" stroke={CHART_INK.context} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />}
            <Line
              type="linear"
              dataKey="closed"
              connectNulls={false}
              stroke={CHART_INK.accent}
              strokeWidth={2}
              dot={rows.length <= 14 ? { r: 3, stroke: "#fff", strokeWidth: 2, fill: CHART_INK.accent } : false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {split.openIndex !== -1 && (
              <Line
                type="linear"
                dataKey="open"
                stroke={CHART_INK.accent}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={(p: { cx?: number; cy?: number; index?: number }) =>
                  p.index === split.openIndex && p.cx != null && p.cy != null ? <circle key="open-dot" cx={p.cx} cy={p.cy} r={3.5} fill="#fff" stroke={CHART_INK.accent} strokeWidth={2} /> : <g key={`no-dot-${p.index}`} />
                }
                activeDot={false}
                legendType="none"
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {split.openIndex !== -1 && (
        <p className="mt-1.5 text-[11px] text-ink-2" data-testid="lead-trend-in-progress">
          Dashed segment: {unit === "day" ? "today" : "the current week"} is still in progress, so its count is not final.
        </p>
      )}
    </div>
  );
}

type ConvMetric = "toAppointment" | "toConsultation" | "toTreatment";
const METRICS: { key: ConvMetric; label: string; noun: string }[] = [
  { key: "toAppointment", label: "Appointment", noun: "booked an appointment" },
  { key: "toConsultation", label: "Consultation", noun: "reached a consultation" },
  { key: "toTreatment", label: "Treatment", noun: "were advised treatment" },
];

/** Conversion by source with the metric selectable. Every row prints rate, numerator and denominator. */
export function SourceConversion({ data, onSourceClick }: { data: SourceConversionResponse; onSourceClick?: (s: SourceChannel) => void }) {
  const [metric, setMetric] = useState<ConvMetric>("toAppointment");
  if (data.rows.length === 0) return <ChartEmptyState height={200} message="No enquiries in this period" />;
  const active = METRICS.find((m) => m.key === metric)!;
  const rows: BarRow[] = data.rows.map((r) => {
    const ratio = r[metric];
    return {
      key: r.source,
      label: SOURCE_LABELS[r.source],
      value: ratio.rate ?? 0,
      valueLabel: fmtPct(ratio.rate),
      sub: `${ratio.numerator} of ${ratio.denominator}`,
      color: sourceColor(chartSourceKey(r.source)),
      onClick: onSourceClick ? () => onSourceClick(r.source) : undefined,
    };
  });
  return (
    <div data-testid="source-conversion">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Tabs items={METRICS.map((m) => ({ key: m.key, label: `→ ${m.label}`, testId: `conv-${m.key}` }))} value={metric} onChange={(k) => setMetric(k as ConvMetric)} ariaLabel="Conversion metric" />
      </div>
      <RankedBars rows={rows} max={1} ariaLabel={`Share of enquiries that ${active.noun}, by source`} />
      <p className="mt-2 text-[11px] leading-4 text-ink-2">Share of each source’s enquiries that {active.noun}; numerator of denominator shown per row.</p>
    </div>
  );
}

type SortKey = "campaignName" | "spend" | "leads" | "appointments" | "treatments" | "revenue" | "roas";

/** Campaign performance, sortable; a row opens the campaign. */
export function CampaignTable({ data, limit, testId = "campaign-table" }: { data: AnalyticsCampaigns; limit?: number; testId?: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "spend", dir: -1 });
  const sorted = [...data.rows].sort((a, b) => {
    const av = a[sort.key] ?? -1;
    const bv = b[sort.key] ?? -1;
    return typeof av === "string" ? sort.dir * av.localeCompare(bv as string) : sort.dir * ((av as number) - (bv as number));
  });
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const columns: { key: SortKey; label: string; align?: "right"; title?: string }[] = [
    { key: "campaignName", label: "Campaign" },
    { key: "spend", label: "Spend", align: "right", title: "Pro-rated across the days each campaign ran inside the period" },
    { key: "leads", label: "Enquiries", align: "right" },
    { key: "appointments", label: "Appointments", align: "right", title: "Enquiries that reached an appointment" },
    { key: "treatments", label: "Treatments", align: "right", title: "Completed treatments" },
    { key: "revenue", label: "Revenue", align: "right" },
    { key: "roas", label: "ROAS", align: "right", title: "Revenue ÷ pro-rated spend" },
  ];
  if (data.rows.length === 0) return <ChartEmptyState height={160} message="No campaigns match these filters" />;
  return (
    <div data-testid={testId}>
      <TableShell className="border-0 shadow-none">
        <Table>
          <TableHead>
            <tr>
              {columns.map((c) => (
                <Th key={c.key} align={c.align} leading={c.key === "campaignName"} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"} title={c.title}>
                  <button
                    type="button"
                    className="relative inline-flex items-center uppercase hover:text-ink"
                    onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: (-s.dir) as 1 | -1 } : { key: c.key, dir: c.key === "campaignName" ? 1 : -1 }))}
                  >
                    {c.label}
                    <span aria-hidden="true" className="absolute -left-3 text-[9px]">
                      {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
                    </span>
                  </button>
                </Th>
              ))}
            </tr>
          </TableHead>
          <TableBody>
            {shown.map((r) => (
              <Tr key={r.campaignId} data-testid={`campaign-row-${r.campaignId}`}>
                <Td leading nowrap={false} className="max-w-[20rem]">
                  <Link href={`/campaigns/${r.campaignId}`} className="flex items-center gap-2 hover:underline">
                    <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: sourceColor(chartSourceKey(r.source)) }} title={SOURCE_LABELS[r.source]} />
                    <span className="truncate text-xs font-medium text-ink">{r.campaignName}</span>
                  </Link>
                </Td>
                <Td align="right">{formatInrCompact(r.spend)}</Td>
                <Td align="right">{fmtCountNum(r.leads)}</Td>
                <Td align="right">{fmtCountNum(r.appointments)}</Td>
                <Td align="right">{fmtCountNum(r.treatments)}</Td>
                <Td align="right" title={r.revenue > 0 ? formatInr(r.revenue) : undefined}>
                  {r.revenue > 0 ? formatInrCompact(r.revenue) : "—"}
                </Td>
                <Td align="right" className="font-semibold">
                  {fmtRoasX(r.roas)}
                </Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      </TableShell>
      <p className="mt-2 text-[11px] leading-4 text-ink-2">
        {limit && data.rows.length > limit ? `Top ${limit} of ${data.rows.length} campaigns by ${columns.find((c) => c.key === sort.key)?.label.toLowerCase()}. ` : ""}
        Not attributed to any campaign: {fmtCountNum(data.unattributed.leads)} enquiries{data.unattributed.revenue > 0 ? `, ${formatInrCompact(data.unattributed.revenue)} revenue` : ""}.
      </p>
    </div>
  );
}
