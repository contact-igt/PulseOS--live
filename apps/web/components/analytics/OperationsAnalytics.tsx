"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@pulseos/api-client";
import { hasPermission, type OperationsReport, type ReportQuery, type Role } from "@pulseos/types";
import { AnalyticsPanel, CHART_INK, Card, ChartEmptyState, ChartLegend, ChartSkeleton, ErrorState, Tabs, fmtCountNum, fmtDayShort, fmtPct, localDayKey, niceCountAxis } from "@pulseos/ui";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { ReportFilterBar } from "@/components/report/ReportFilterBar";
import { ANALYTICS_CONFIG, periodLabel, readReportFilters, reportFilterPatch, resetReportPatch } from "@/components/report/reportFilters";
import { RankedBars } from "./common";
import { SortableTable, type SortColumn } from "./SortableTable";
import { attendanceRate, consultationRate, drillDay, followUpCompletionRate, noShowRate } from "./opsMath";

// The Analytics workspace (Beta V1 operational analytics): ONE filter state — the URL — drives ONE request, so every
// KPI, chart and table below is computed from the same rows and always agrees. No spend, no ROAS, no revenue here.

const SERIES = [
  { key: "enquiries", label: "New leads", color: CHART_INK.accent },
  { key: "appointmentsScheduled", label: "Appointments", color: "#72b5f2" },
  { key: "attended", label: "Checked in", color: "#4170cb" },
  { key: "consultationsCompleted", label: "Completed", color: "#2158a7" },
] as const;

interface Kpi {
  key: string;
  label: string;
  value: string;
  sub?: string;
  hint: string;
  attention?: boolean;
}

function kpisOf(r: OperationsReport): Kpi[] {
  const k = r.kpis;
  const n = fmtCountNum;
  return [
    { key: "enquiries", label: "Enquiries", value: n(k.newEnquiries), sub: k.uncontacted > 0 ? `${n(k.uncontacted)} not contacted · by enquiry date` : "all contacted · by enquiry date", hint: "Journeys created in the period", attention: k.uncontacted > 0 },
    { key: "follow-ups", label: "Follow-ups", value: n(k.followUpsDue), sub: `still open and due · ${n(k.followUpsCompleted)} done · ${n(k.followUpsOverdue)} overdue now`, hint: "Open follow-ups due in the period. Done = completed in the period; overdue = already past due right now", attention: k.followUpsOverdue > 0 },
    { key: "appointments", label: "Appointments", value: n(k.appointmentsScheduled), sub: `${n(k.appointmentsBooked)} booked in period (by booking date)`, hint: "Visits scheduled in the period. Booked = appointments created in the period, whenever the visit is" },
    { key: "checked-in", label: "Checked In", value: n(k.appointmentsAttended), sub: `${fmtPct(attendanceRate(k))} of expected visits`, hint: "Patients who arrived (checked in or later). Expected = scheduled − cancelled" },
    { key: "consultations", label: "Consultations Completed", value: n(k.consultationsCompleted), sub: `${fmtPct(consultationRate(k))} of checked in`, hint: "Visits in the period whose consultation was completed" },
    { key: "no-shows", label: "No-shows", value: n(k.appointmentsNoShow), sub: `${fmtPct(noShowRate(k))} of expected visits`, hint: "Visits in the period marked no-show. Expected = scheduled − cancelled", attention: k.appointmentsNoShow > 0 },
    { key: "surgeries-scheduled", label: "Surgeries Scheduled", value: n(k.proceduresScheduled), sub: "planned date in period", hint: "Procedures with a planned date in the period (scheduled or done)" },
    { key: "procedures-completed", label: "Procedures Completed", value: n(k.proceduresCompleted), sub: "by completion date", hint: "Procedures completed in the period, by the time completion was recorded (never by payment date)" },
  ];
}

function KpiStrip({ r }: { r: OperationsReport }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="analytics-kpis">
      {kpisOf(r).map((m) => (
        <Card key={m.key} className="px-3.5 py-3" title={m.hint} data-testid={`analytics-kpi-${m.key}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{m.label}</p>
          <p className={`mt-0.5 text-2xl font-semibold leading-8 tabular-nums ${m.attention ? "text-warning-700" : "text-ink"}`} data-testid={`analytics-kpi-${m.key}-value`}>
            {m.value}
            {m.attention && <span className="sr-only"> (needs attention)</span>}
          </p>
          {m.sub && <p className="mt-0.5 text-[11px] leading-4 text-ink-2">{m.sub}</p>}
        </Card>
      ))}
    </div>
  );
}

function DailyChart({ r, onDay }: { r: OperationsReport; onDay: (day: string) => void }) {
  const totals = Object.fromEntries(SERIES.map((s) => [s.key, r.daily.reduce((sum, d) => sum + d[s.key], 0)]));
  if (SERIES.every((s) => totals[s.key] === 0)) return <ChartEmptyState height={240} message="Nothing happened in this period" hint="Widen the date range or clear a filter." />;
  const rows = r.daily.map((d) => ({ ...d, label: d.day === r.period.today ? "Today" : fmtDayShort(d.day) }));
  const axis = niceCountAxis(Math.max(...r.daily.map((d) => Math.max(d.enquiries, d.appointmentsScheduled, d.attended)), 0));
  const summary = `Day by day, ${r.daily.length} days: ${totals.enquiries} new leads, ${totals.appointmentsScheduled} appointments, ${totals.attended} checked in, ${totals.consultationsCompleted} completed.`;
  return (
    <div data-testid="analytics-daily-chart">
      <ChartLegend items={SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color, value: totals[s.key] }))} className="mb-2" />
      <div role="img" aria-label={summary} style={{ height: 240 }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 240 }}>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={rows.length > 14 ? "16%" : "26%"} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: CHART_INK.baseline }} tick={{ fontSize: 11, fill: CHART_INK.secondary }} interval="preserveStartEnd" minTickGap={16} tickMargin={6} />
            <YAxis width={26} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART_INK.secondary }} domain={[0, axis.max]} ticks={axis.ticks} />
            <Tooltip cursor={{ fill: CHART_INK.track }} contentStyle={{ fontSize: 12, borderRadius: 10, borderColor: CHART_INK.grid }} labelFormatter={(_l, p) => (p?.[0]?.payload ? fmtDayShort((p[0].payload as { day: string }).day) : "")} />
            {SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} isAnimationActive={false} cursor="pointer" onClick={(d: unknown) => { const day = (d as { payload?: { day?: string } })?.payload?.day; if (day) onDay(day); }} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] text-ink-2">Select a bar, or use the table, to look at one day.</p>
    </div>
  );
}

type DayRow = OperationsReport["daily"][number];

function DailyTable({ r, onDay }: { r: OperationsReport; onDay: (day: string) => void }) {
  const dayText = (d: DayRow) => (d.day === r.period.today ? "Today" : fmtDayShort(d.day));
  const columns: SortColumn<DayRow>[] = [
    { key: "day", label: "Date", get: (d) => d.day, render: dayText, align: "left", rowHeader: true },
    { key: "enquiries", label: "New leads", get: (d) => d.enquiries },
    { key: "followUpsDue", label: "Follow-ups due", get: (d) => d.followUpsDue },
    { key: "appointmentsScheduled", label: "Appointments", get: (d) => d.appointmentsScheduled },
    { key: "attended", label: "Checked in", get: (d) => d.attended },
    { key: "consultationsCompleted", label: "Completed", get: (d) => d.consultationsCompleted },
    { key: "noShow", label: "No-shows", get: (d) => d.noShow, cellClass: (d) => (d.noShow > 0 ? "text-warning-700 font-semibold" : "") },
  ];
  return (
    <SortableTable
      caption={`Day by day for ${periodLabel(r.period.from, r.period.to)}`}
      rows={r.daily}
      columns={columns}
      rowKey={(d) => d.day}
      rowTestId={(d) => `analytics-day-${d.day}`}
      defaultSort={{ key: "day", dir: "desc" }}
      onRowClick={r.daily.length > 1 ? (d) => onDay(d.day) : undefined}
      rowLabel={(d) => `Show only ${dayText(d)}`}
      testId="analytics-daily-table"
      maxHeightClass="max-h-96"
      minWidthClass="min-w-[36rem]"
    />
  );
}

const rate = (n: number, d: number) => (d > 0 ? n / d : null);

function ServiceTable({ r, activeService, onService }: { r: OperationsReport; activeService?: string; onService: (s: string) => void }) {
  type Row = OperationsReport["byService"][number];
  const columns: SortColumn<Row>[] = [
    { key: "service", label: "Service", get: (s) => s.service, align: "left", rowHeader: true },
    { key: "enquiries", label: "Enquiries", get: (s) => s.enquiries },
    { key: "booked", label: "Booked", get: (s) => s.booked },
    { key: "attended", label: "Checked in", get: (s) => s.attended },
    { key: "converted", label: "Converted", get: (s) => s.converted },
    { key: "conv", label: "Conv.", get: (s) => rate(s.converted, s.enquiries), render: (s) => fmtPct(rate(s.converted, s.enquiries)) },
  ];
  if (r.byService.length === 0) return <ChartEmptyState height={140} message="No enquiries in this period" />;
  return (
    <SortableTable
      caption="Service performance"
      rows={r.byService}
      columns={columns}
      rowKey={(s) => s.service}
      defaultSort={{ key: "enquiries", dir: "desc" }}
      onRowClick={(s) => onService(s.service)}
      rowLabel={(s) => (activeService === s.service ? `Clear the ${s.service} filter` : `Filter to ${s.service}`)}
      testId="analytics-by-service"
      minWidthClass="min-w-[28rem]"
    />
  );
}

function TeamTable({ r, onOwner }: { r: OperationsReport; onOwner: (id: string) => void }) {
  type Row = OperationsReport["byOwner"][number];
  const columns: SortColumn<Row>[] = [
    { key: "name", label: "Team member", get: (o) => o.name, align: "left", rowHeader: true, cellClass: (o) => (o.userId ? "" : "text-ink-2") },
    { key: "enquiries", label: "Enquiries", get: (o) => o.enquiries },
    { key: "uncontacted", label: "Not contacted", get: (o) => o.uncontacted },
    { key: "followUpsDue", label: "Follow-ups due", get: (o) => o.followUpsDue },
    { key: "followUpsOverdue", label: "Overdue now", get: (o) => o.followUpsOverdue, cellClass: (o) => (o.followUpsOverdue > 0 ? "text-warning-700 font-semibold" : "") },
    { key: "followUpsCompleted", label: "Follow-ups done", get: (o) => o.followUpsCompleted },
  ];
  if (r.byOwner.length === 0) return <ChartEmptyState height={140} message="No enquiries or follow-ups in this period" />;
  return (
    <SortableTable
      caption="Team workload"
      rows={r.byOwner}
      columns={columns}
      rowKey={(o) => o.userId ?? "unassigned"}
      defaultSort={{ key: "followUpsOverdue", dir: "desc" }}
      onRowClick={(o) => o.userId && onOwner(o.userId)}
      rowLabel={(o) => `Filter to ${o.name}`}
      isDrillable={(o) => !!o.userId}
      testId="analytics-by-owner"
      minWidthClass="min-w-[32rem]"
    />
  );
}

export function OperationsAnalytics({ role }: { role: Role }) {
  const timeZone = useHospitalTimeZone();
  const today = localDayKey(new Date(), timeZone);
  const url = useUrlFilters();
  const q = readReportFilters(url.get, today, ANALYTICS_CONFIG);
  const [dailyView, setDailyView] = useState<"chart" | "table">("chart");

  const options = useQuery({ queryKey: ["reports", "filter-options"], queryFn: api.reportFilterOptions, staleTime: 5 * 60_000 });
  const report = useQuery({ queryKey: ["reports", "operations", q], queryFn: () => api.operationsReport(q), placeholderData: (prev) => prev });

  const onChange = (patch: Partial<ReportQuery>) => url.set(reportFilterPatch(patch, ANALYTICS_CONFIG));
  const onReset = () => url.set(resetReportPatch(ANALYTICS_CONFIG));
  // Drilling is just changing the one filter state; selecting the same mark again clears it.
  const toggle = <K extends "service" | "sourceId" | "ownerId">(key: K, value: string | undefined) => onChange({ [key]: q[key] === value ? "" : (value ?? "") } as Partial<ReportQuery>);
  const period = report.data?.period;
  const data = report.data;
  const sourceRows = useMemo(() => data?.bySource ?? [], [data]);

  return (
    <div className="space-y-4" data-testid="operations-analytics">
      <ReportFilterBar q={q} today={today} options={options.data} canExport={hasPermission(role, "EXPORT_REPORTS")} defaultRange={ANALYTICS_CONFIG.defaultRange} onChange={onChange} onReset={onReset} />
      <p className="text-xs text-ink-2" data-testid="analytics-period">
        {period ? periodLabel(period.from, period.to) : "…"} · hospital time ({timeZone}). Enquiries follow the date the journey was created, visits follow the visit date, procedures follow their recorded completion date.
      </p>

      {(q.branchId || q.doctorId) && (
        <p className="text-xs text-ink-2" data-testid="analytics-scope-note">
          {q.branchId && "Branch: enquiries and follow-ups follow the patient's branch; visits and surgeries follow where they happen. "}
          {q.doctorId && "Doctor: narrows visits and surgeries only — enquiries, follow-ups and sources show the whole hospital."}
        </p>
      )}

      {report.isError && !data ? (
        <ErrorState message="Could not load analytics." />
      ) : !data ? (
        <div className="space-y-3">
          <ChartSkeleton height={96} />
          <ChartSkeleton height={260} />
        </div>
      ) : (
        <div className={`space-y-4 ${report.isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}`} aria-busy={report.isFetching}>
          <KpiStrip r={data} />
          {data.kpis.proceduresCompletedUndated > 0 && (
            <p className="text-xs text-ink-2" data-testid="analytics-undated-note">
              {fmtCountNum(data.kpis.proceduresCompletedUndated)} completed procedure{data.kpis.proceduresCompletedUndated === 1 ? " has" : "s have"} no completion date recorded, so {data.kpis.proceduresCompletedUndated === 1 ? "it is" : "they are"} not counted in any period.
            </p>
          )}

          <AnalyticsPanel
            title="Day by day"
            question="How many leads came in, and how many patients were seen, each day?"
            testId="analytics-daily"
            actions={<Tabs ariaLabel="Day by day view" value={dailyView} onChange={(k) => setDailyView(k as "chart" | "table")} items={[{ key: "chart", label: "Chart", testId: "analytics-daily-chart-tab" }, { key: "table", label: "Table", testId: "analytics-daily-table-tab" }]} />}
          >
            {dailyView === "chart" ? <DailyChart r={data} onDay={(d) => onChange(drillDay(d))} /> : <DailyTable r={data} onDay={(d) => onChange(drillDay(d))} />}
          </AnalyticsPanel>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <AnalyticsPanel title="Patient flow" question="Of the period's enquiries, how many reached each step?" testId="analytics-funnel">
              {data.kpis.newEnquiries === 0 ? (
                <ChartEmptyState height={160} message="No enquiries in this period" />
              ) : (
                <RankedBars
                  testId="analytics-pipeline"
                  ariaLabel="Patient flow"
                  labelWidth="w-32 sm:w-44"
                  rows={data.pipeline.map((s, i) => ({
                    key: s.key,
                    label: s.label,
                    value: s.count,
                    valueLabel: fmtCountNum(s.count),
                    sub: i === 0 ? undefined : fmtPct(rate(s.count, data.pipeline[0]!.count)),
                    trackValue: i === 0 ? undefined : data.pipeline[i - 1]!.count,
                  }))}
                />
              )}
              <p className="mt-2 text-[11px] text-ink-2">Percentages are of all enquiries in the period; the pale bar is the step before.</p>
            </AnalyticsPanel>
            <AnalyticsPanel title="Lead sources" question="Where did the period's enquiries come from?" testId="analytics-sources" footer="Select a source to filter everything on this page to it.">
              {sourceRows.length === 0 ? (
                <ChartEmptyState height={160} message="No enquiries in this period" />
              ) : (
                <RankedBars
                  testId="analytics-source-bars"
                  ariaLabel="Enquiries by source"
                  rows={sourceRows.map((s) => ({
                    key: s.sourceId ?? s.bucket,
                    label: q.sourceId && s.sourceId === q.sourceId ? `${s.label} ✓` : s.label,
                    value: s.enquiries,
                    valueLabel: fmtCountNum(s.enquiries),
                    sub: `${s.booked} booked`,
                    onClick: s.sourceId ? () => toggle("sourceId", s.sourceId!) : undefined,
                  }))}
                />
              )}
            </AnalyticsPanel>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <AnalyticsPanel title="Service performance" question="Which services bring enquiries, and how far do they get?" testId="analytics-services" footer="Select a service to filter everything on this page to it.">
              <ServiceTable r={data} activeService={q.service} onService={(s) => toggle("service", s)} />
            </AnalyticsPanel>
            <AnalyticsPanel title="Team workload" question="Who owns the enquiries, and whose follow-ups are due or overdue?" testId="analytics-team" footer="Select a team member to filter everything on this page to them.">
              <TeamTable r={data} onOwner={(id) => toggle("ownerId", id)} />
            </AnalyticsPanel>
          </div>
          <p className="text-[11px] text-ink-2">Follow-up completion in this period: {fmtPct(followUpCompletionRate(data.kpis))} (completed ÷ completed + still due).</p>
        </div>
      )}
    </div>
  );
}
