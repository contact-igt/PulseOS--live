"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@pulseos/api-client";
import { hasPermission, type OperationsReport, type ReportQuery, type Role } from "@pulseos/types";
import { AnalyticsPanel, CHART_INK, Card, ChartEmptyState, ChartLegend, ChartSkeleton, ErrorState, Tabs, fmtCountNum, fmtDayShort, fmtPct, localDayKey, niceCountAxis } from "@pulseos/ui";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { Async, RankedBars, TH } from "@/components/analytics/common";
import { ReportFilterBar } from "./ReportFilterBar";
import { DEFAULT_REPORT_RANGE, periodLabel, readReportFilters, reportFilterPatch, resetReportPatch } from "./reportFilters";

const TD = "px-2.5 py-1.5 text-xs tabular-nums text-ink";


// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

interface Metric {
  key: string;
  label: string;
  value: string;
  hint: string;
  attention?: boolean;
}

function KpiGroups({ r }: { r: OperationsReport }) {
  const k = r.kpis;
  const n = fmtCountNum;
  const groups: { title: string; metrics: Metric[] }[] = [
    {
      title: "Enquiries",
      metrics: [
        { key: "new", label: "New", value: n(k.newEnquiries), hint: "Journeys created in the period" },
        { key: "uncontacted", label: "Not contacted", value: n(k.uncontacted), hint: "New enquiries nobody has contacted yet", attention: k.uncontacted > 0 },
        { key: "noresponse", label: "No response", value: n(k.noResponse), hint: "Latest outcome is No answer and the enquiry went no further" },
      ],
    },
    {
      title: "Follow-ups",
      metrics: [
        { key: "due", label: "Due", value: n(k.followUpsDue), hint: "Open follow-ups due in the period" },
        { key: "overdue", label: "Overdue now", value: n(k.followUpsOverdue), hint: "Open follow-ups already past due (not limited to the period)", attention: k.followUpsOverdue > 0 },
        { key: "done", label: "Completed", value: n(k.followUpsCompleted), hint: "Completed in the period" },
      ],
    },
    {
      title: "Appointments",
      metrics: [
        { key: "booked", label: "Booked", value: n(k.appointmentsBooked), hint: "Appointments created in the period, whenever the visit is" },
        { key: "attended", label: "Visits attended", value: `${n(k.appointmentsAttended)}/${n(k.appointmentsScheduled)}`, hint: "Visits in the period the patient attended, of all visits scheduled in it" },
        { key: "noshow", label: "No-show", value: n(k.appointmentsNoShow), hint: "Visits in the period marked no-show", attention: k.appointmentsNoShow > 0 },
        { key: "cancelled", label: "Cancelled", value: n(k.appointmentsCancelled), hint: "Visits in the period that were cancelled" },
      ],
    },
    {
      title: "Conversion",
      metrics: [
        { key: "procedures", label: "Procedures planned", value: n(k.proceduresScheduled), hint: "Procedures with a planned date in the period (scheduled or done)" },
        { key: "procedures-done", label: "Completed", value: n(k.proceduresCompleted), hint: "Procedures completed in the period, by the time completion was recorded (never by payment date)" },
        { key: "converted", label: "Enquiries converted", value: `${n(k.converted)} · ${fmtPct(k.conversionRate)}`, hint: "New enquiries of the period whose treatment is completed, and their share of all new enquiries" },
      ],
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="report-kpis">
      {groups.map((g) => (
        <Card key={g.title} className="px-3.5 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{g.title}</h3>
          <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
            {g.metrics.map((m) => (
              <div key={m.key} className="min-w-[4.5rem]" title={m.hint} data-testid={`report-kpi-${m.key}`}>
                <dt className="text-[11px] text-ink-2">{m.label}</dt>
                <dd className={`text-lg font-semibold leading-6 tabular-nums ${m.attention ? "text-warning-700" : "text-ink"}`}>
                  {m.value}
                  {m.attention && <span className="sr-only"> (needs attention)</span>}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day by day
// ---------------------------------------------------------------------------

const SERIES = [
  { key: "enquiries", label: "Enquiries", color: CHART_INK.accent },
  { key: "appointmentsScheduled", label: "Appointments", color: "#72b5f2" },
  { key: "attended", label: "Visited", color: "#2158a7" },
] as const;

function DailyChart({ r }: { r: OperationsReport }) {
  const totals = Object.fromEntries(SERIES.map((s) => [s.key, r.daily.reduce((sum, d) => sum + d[s.key], 0)]));
  if (SERIES.every((s) => totals[s.key] === 0)) return <ChartEmptyState height={220} message="Nothing happened in this period" hint="Widen the period or clear a filter." />;
  const rows = r.daily.map((d) => ({ ...d, label: d.day === r.period.today ? "Today" : fmtDayShort(d.day) }));
  const axis = niceCountAxis(Math.max(...r.daily.map((d) => Math.max(d.enquiries, d.appointmentsScheduled)), 0));
  const summary = `Day by day, ${r.daily.length} days: ${totals.enquiries} enquiries, ${totals.appointmentsScheduled} appointments scheduled, ${totals.attended} attended.`;
  return (
    <div data-testid="report-daily-chart">
      <ChartLegend items={SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color, value: totals[s.key] }))} className="mb-2" />
      <div role="img" aria-label={summary} style={{ height: 220 }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 220 }}>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={rows.length > 14 ? "18%" : "28%"} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: CHART_INK.baseline }} tick={{ fontSize: 11, fill: CHART_INK.secondary }} interval="preserveStartEnd" minTickGap={16} tickMargin={6} />
            <YAxis width={26} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART_INK.secondary }} domain={[0, axis.max]} ticks={axis.ticks} />
            <Tooltip cursor={{ fill: CHART_INK.track }} contentStyle={{ fontSize: 12, borderRadius: 10, borderColor: CHART_INK.grid }} labelFormatter={(_l, p) => (p?.[0]?.payload ? fmtDayShort((p[0].payload as { day: string }).day) : "")} />
            {SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DailyTable({ r }: { r: OperationsReport }) {
  const cols = [
    ["enquiries", "Enquiries"], ["appointmentsScheduled", "Appts"], ["attended", "Visited"], ["noShow", "No-show"], ["cancelled", "Cancelled"], ["followUpsDue", "F/U due"], ["followUpsCompleted", "F/U done"],
  ] as const;
  return (
    <div className="max-h-80 overflow-auto rounded-control border border-line" data-testid="report-daily-table">
      <table className="w-full min-w-[34rem] border-collapse">
        <caption className="sr-only">Day by day for {periodLabel(r.period.from, r.period.to)}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-line">
            <th scope="col" className={`${TH} text-left`}>Date</th>
            {cols.map(([k, l]) => <th key={k} scope="col" className={`${TH} text-right`}>{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...r.daily].reverse().map((d) => (
            <tr key={d.day} className="border-b border-line/60 last:border-0">
              <th scope="row" className={`${TD} text-left font-medium`}>{d.day === r.period.today ? "Today" : fmtDayShort(d.day)}</th>
              {cols.map(([k]) => <td key={k} className={`${TD} text-right ${d[k] === 0 ? "text-ink-2" : ""}`}>{d[k]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

function SourceTable({ r }: { r: OperationsReport }) {
  if (r.bySource.length === 0) return <ChartEmptyState height={140} message="No enquiries in this period" />;
  return (
    <div className="overflow-x-auto" data-testid="report-by-source">
      <table className="w-full min-w-[30rem] border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={`${TH} text-left`}>Source</th>
            {["Enquiries", "Contacted", "Booked", "Visited", "Converted", "Conv."].map((h) => <th key={h} scope="col" className={`${TH} text-right`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.bySource.map((s) => (
            <tr key={s.sourceId ?? s.bucket} className="border-b border-line/60 last:border-0">
              <th scope="row" className={`${TD} max-w-[12rem] truncate text-left font-medium`} title={s.label}>{s.label}</th>
              {[s.enquiries, s.contacted, s.booked, s.attended, s.converted].map((v, i) => <td key={i} className={`${TD} text-right`}>{v}</td>)}
              <td className={`${TD} text-right font-semibold`}>{fmtPct(s.conversionRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamTable({ r }: { r: OperationsReport }) {
  if (r.byOwner.length === 0) return <ChartEmptyState height={140} message="No enquiries or follow-ups in this period" />;
  return (
    <div className="overflow-x-auto" data-testid="report-by-owner">
      <table className="w-full min-w-[30rem] border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={`${TH} text-left`}>Team member</th>
            {["Enquiries", "Not contacted", "F/U due", "Overdue now", "F/U done"].map((h) => <th key={h} scope="col" className={`${TH} text-right`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.byOwner.map((o) => (
            <tr key={o.userId ?? "unassigned"} className="border-b border-line/60 last:border-0">
              <th scope="row" className={`${TD} max-w-[12rem] truncate text-left font-medium ${o.userId ? "" : "text-ink-2"}`} title={o.name}>{o.name}</th>
              <td className={`${TD} text-right`}>{o.enquiries}</td>
              <td className={`${TD} text-right`}>{o.uncontacted}</td>
              <td className={`${TD} text-right`}>{o.followUpsDue}</td>
              <td className={`${TD} text-right ${o.followUpsOverdue > 0 ? "font-semibold text-warning-700" : ""}`}>{o.followUpsOverdue}</td>
              <td className={`${TD} text-right`}>{o.followUpsCompleted}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function OperationsReportView({ role }: { role: Role }) {
  const timeZone = useHospitalTimeZone();
  const today = localDayKey(new Date(), timeZone);
  const url = useUrlFilters();
  const q = readReportFilters(url.get, today);
  const [dailyView, setDailyView] = useState<"chart" | "table">("chart");

  const options = useQuery({ queryKey: ["reports", "filter-options"], queryFn: api.reportFilterOptions, staleTime: 5 * 60_000 });
  const report = useQuery({ queryKey: ["reports", "operations", q], queryFn: () => api.operationsReport(q), placeholderData: (prev) => prev });

  const onChange = (patch: Partial<ReportQuery>) => url.set(reportFilterPatch(patch));
  const onReset = () => url.set(resetReportPatch());
  const period = report.data?.period;

  return (
    <div className="space-y-4" data-testid="operations-report">
      <ReportFilterBar q={q} today={today} options={options.data} canExport={hasPermission(role, "EXPORT_REPORTS")} defaultRange={DEFAULT_REPORT_RANGE} onChange={onChange} onReset={onReset} />
      <p className="text-xs text-ink-2" data-testid="report-period">
        {period ? periodLabel(period.from, period.to) : "…"} · hospital time ({timeZone}). Enquiry figures follow journeys created in the period; appointments follow the visit date.
      </p>

      {report.isError && !report.data ? (
        <ErrorState message="Could not load the operations report." />
      ) : !report.data ? (
        <div className="space-y-3">
          <ChartSkeleton height={96} />
          <ChartSkeleton height={260} />
        </div>
      ) : (
        <div className={`space-y-4 ${report.isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}`} aria-busy={report.isFetching}>
          <KpiGroups r={report.data} />
          {report.data.kpis.proceduresCompletedUndated > 0 && (
            <p className="text-xs text-ink-2" data-testid="report-undated-note">
              {fmtCountNum(report.data.kpis.proceduresCompletedUndated)} completed procedure{report.data.kpis.proceduresCompletedUndated === 1 ? " has" : "s have"} no completion date recorded (completed before it was kept), so {report.data.kpis.proceduresCompletedUndated === 1 ? "it is" : "they are"} not counted in any period.
            </p>
          )}

          <AnalyticsPanel
            title="Day by day"
            question="How many enquiries came in, and how many patients were seen, each day?"
            testId="report-daily"
            actions={<Tabs ariaLabel="Day by day view" value={dailyView} onChange={(k) => setDailyView(k as "chart" | "table")} items={[{ key: "chart", label: "Chart", testId: "report-daily-chart-tab" }, { key: "table", label: "Table", testId: "report-daily-table-tab" }]} />}
          >
            {dailyView === "chart" ? <DailyChart r={report.data} /> : <DailyTable r={report.data} />}
          </AnalyticsPanel>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <AnalyticsPanel title="Enquiry funnel" question="Of the period's enquiries, how far did each get?" testId="report-funnel">
              <Async query={report} height={180} error="Could not load the funnel.">
                {(r) =>
                  r.kpis.newEnquiries === 0 ? (
                    <ChartEmptyState height={160} message="No enquiries in this period" />
                  ) : (
                    <RankedBars
                      ariaLabel="Enquiry funnel"
                      labelWidth="w-32 sm:w-40"
                      rows={r.funnel.map((s, i) => ({
                        key: s.key,
                        label: s.label,
                        value: s.count,
                        valueLabel: fmtCountNum(s.count),
                        sub: i === 0 ? undefined : fmtPct(r.funnel[0]!.count ? s.count / r.funnel[0]!.count : null),
                        trackValue: i === 0 ? undefined : r.funnel[i - 1]!.count,
                      }))}
                    />
                  )
                }
              </Async>
            </AnalyticsPanel>
            <AnalyticsPanel title="By service" question="Which services brought enquiries, and how many converted?" testId="report-by-service">
              {report.data.byService.length === 0 ? (
                <ChartEmptyState height={160} message="No enquiries in this period" />
              ) : (
                <RankedBars
                  ariaLabel="Enquiries by service"
                  rows={report.data.byService.map((s) => ({ key: s.service, label: s.service, value: s.enquiries, valueLabel: fmtCountNum(s.enquiries), sub: `${s.attended} seen · ${s.converted} conv.` }))}
                />
              )}
            </AnalyticsPanel>
          </div>

          <AnalyticsPanel title="Sources" question="Where did the period's enquiries come from, and how far did each source's patients get?" testId="report-sources">
            <SourceTable r={report.data} />
          </AnalyticsPanel>
          <AnalyticsPanel title="Team workload" question="Who owns the enquiries, and whose follow-ups are due or overdue?" testId="report-team">
            <TeamTable r={report.data} />
          </AnalyticsPanel>
        </div>
      )}
    </div>
  );
}
