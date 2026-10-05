"use client";

import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsRevenue, AnalyticsTeam, SourceChannel } from "@pulseos/types";
import {
  Badge,
  CHART_INK,
  ChartEmptyState,
  ChartTooltipCard,
  SOURCE_LABELS,
  Table,
  TableBody,
  TableHead,
  TableShell,
  Td,
  Th,
  Tr,
  chartSourceKey,
  fmtBucketLabel,
  fmtCountNum,
  fmtDayShort,
  fmtInrAxis,
  niceMoneyAxis,
  fmtPct,
  fmtRoasX,
  formatInr,
  formatInrCompact,
  sourceColor,
} from "@pulseos/ui";
import { RankedBars, type BarRow } from "./common";

/** Revenue per day (short ranges) or per 7-day block, in ₹ — full value in the tooltip. */
export function RevenueTrend({ data, height = 240 }: { data: AnalyticsRevenue; height?: number }) {
  if (data.total === 0) {
    return <ChartEmptyState height={height} message="No revenue recorded in this period" hint="Revenue appears when a payment is recorded against a journey." />;
  }
  const rows = data.buckets.map((b) => ({ label: fmtDayShort(b.key), span: fmtBucketLabel(b), revenue: b.revenue, events: b.events, partial: b.partial }));
  const unit = data.granularity === "day" ? "day" : "7-day block";
  const axis = niceMoneyAxis(Math.max(...rows.map((r) => r.revenue), 0));
  return (
    <div data-testid="revenue-trend">
      <p className="mb-2 text-[11px] leading-4 text-ink-2">
        Per {unit} · {fmtCountNum(data.events)} {data.events === 1 ? "payment" : "payments"} · {formatInr(data.total)} in total
      </p>
      <div role="img" aria-label={`Revenue per ${unit}: ${formatInr(data.total)} from ${data.events} payments`} style={{ height }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="30%" accessibilityLayer>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: CHART_INK.baseline }} tick={{ fontSize: 11, fill: CHART_INK.secondary }} interval="equidistantPreserveStart" minTickGap={14} tickMargin={6} />
            <YAxis width={44} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART_INK.secondary }} tickFormatter={fmtInrAxis} domain={[0, axis.max]} ticks={axis.ticks} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: "rgba(37,132,178,0.07)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as (typeof rows)[number];
                return <ChartTooltipCard title={r.span} rows={[{ key: "r", label: `${r.events} ${r.events === 1 ? "payment" : "payments"}`, color: CHART_INK.accent, value: formatInr(r.revenue) }]} note={r.partial ? "Partial block: the period ends inside it." : undefined} />;
              }}
            />
            <Bar dataKey="revenue" fill={CHART_INK.accent} maxBarSize={28} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** ROAS by source: bar = ROAS, the 1× line is break-even. Spend and revenue are printed so the ratio can be checked. */
export function RoasBySource({ data }: { data: AnalyticsRevenue }) {
  if (data.bySource.length === 0) return <ChartEmptyState height={160} message="No campaign spend in scope" hint="ROAS needs campaign spend in the selected period." />;
  const rows: BarRow[] = data.bySource.map((s) => ({
    key: s.source,
    label: SOURCE_LABELS[s.source as SourceChannel],
    value: s.roas ?? 0,
    valueLabel: fmtRoasX(s.roas),
    sub: `${formatInrCompact(s.attributedRevenue)} / ${formatInrCompact(s.spend)}`,
    color: sourceColor(chartSourceKey(s.source)),
  }));
  return (
    <div data-testid="roas-by-source">
      <RankedBars rows={rows} marker={{ value: 1, label: "Break-even (1×)" }} labelWidth="w-20 sm:w-24" ariaLabel="ROAS by source" />
      <p className="mt-2 text-[11px] leading-4 text-ink-2">
        Attributed revenue ÷ spend, shown beside each bar. The vertical line is break-even (1×). Spend is pro-rated across each campaign’s run inside the period.
      </p>
    </div>
  );
}

const TYPE_LABEL = { consultation_fee: "Consultation fee", treatment_payment: "Treatment payment", other: "Other" } as const;

/** The payments behind the revenue chart — the table twin. */
export function RevenueEvents({ data }: { data: AnalyticsRevenue }) {
  if (data.recent.length === 0) return <ChartEmptyState height={120} message="No payments in this period" />;
  return (
    <div data-testid="revenue-events">
      <TableShell className="border-0 shadow-none">
        <Table>
          <TableHead>
            <tr>
              <Th leading>Date</Th>
              <Th>Service line</Th>
              <Th>Source</Th>
              <Th>Type</Th>
              <Th align="right">Amount</Th>
            </tr>
          </TableHead>
          <TableBody>
            {data.recent.map((e) => (
              <Tr key={e.id}>
                <Td leading>
                  <Link href={`/journeys/${e.journeyId}`} className="hover:underline">
                    {fmtDayShort(e.day)}
                  </Link>
                </Td>
                <Td nowrap={false}>{e.service}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: sourceColor(chartSourceKey(e.source)) }} aria-hidden="true" />
                    {SOURCE_LABELS[e.source]}
                  </span>
                </Td>
                <Td>
                  <Badge tone="neutral">{TYPE_LABEL[e.type]}</Badge>
                </Td>
                <Td align="right" className="font-semibold">
                  {formatInr(e.amount)}
                </Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      </TableShell>
      <p className="mt-2 text-[11px] leading-4 text-ink-2">
        {data.events > data.recent.length ? `Latest ${data.recent.length} of ${data.events} payments.` : `All ${data.events} ${data.events === 1 ? "payment" : "payments"}.`}
      </p>
    </div>
  );
}

/** Revenue by service line as ranked bars. */
export function RevenueByService({ data, onServiceClick }: { data: AnalyticsRevenue; onServiceClick?: (s: string) => void }) {
  if (data.byService.length === 0) return <ChartEmptyState height={140} message="No revenue by service in this period" />;
  return (
    <RankedBars
      testId="revenue-by-service"
      labelWidth="w-32 sm:w-40"
      rows={data.byService.map((s) => ({
        key: s.service,
        label: s.service,
        value: s.revenue,
        valueLabel: formatInrCompact(s.revenue),
        sub: fmtPct(data.total > 0 ? s.revenue / data.total : null),
        onClick: onServiceClick ? () => onServiceClick(s.service) : undefined,
      }))}
      ariaLabel="Revenue by service line"
    />
  );
}

/** Team: ranked bars of assigned journeys, then the full table. Operational, no leaderboard chrome. */
export function TeamAnalytics({ data }: { data: AnalyticsTeam }) {
  const rows = data.rows;
  if (rows.length === 0 || rows.every((r) => r.assignedJourneys === 0 && r.followUpsCompleted === 0 && r.openTasks === 0)) {
    return <ChartEmptyState height={160} message="No owned journeys in this period" />;
  }
  return (
    <div className="space-y-4" data-testid="team-analytics">
      <RankedBars
        ariaLabel="Journeys assigned per team member"
        labelWidth="w-32 sm:w-40"
        rows={rows.map((r) => ({
          key: r.userId ?? "unassigned",
          label: r.name,
          value: r.assignedJourneys,
          valueLabel: fmtCountNum(r.assignedJourneys),
          sub: r.assignedJourneys > 0 ? `${fmtPct(r.conversion.rate)} → appt` : undefined,
          color: r.userId ? CHART_INK.accent : "#98adc3",
        }))}
      />
      <TableShell className="shadow-none">
        <Table>
          <TableHead>
            <tr>
              <Th leading>Team Member</Th>
              <Th align="right">Assigned</Th>
              <Th align="right" title="Assigned journeys that reached an appointment">Appointments</Th>
              <Th align="right">Conversion</Th>
              <Th align="right" title="Follow-up and callback tasks completed in the period">Follow-ups done</Th>
              <Th align="right" title="Snapshot now, not period-bound">Open tasks</Th>
              <Th align="right" title="Snapshot now, not period-bound">Overdue</Th>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <Tr key={r.userId ?? "unassigned"}>
                <Td leading nowrap={false}>
                  <span className="text-xs font-medium text-ink">{r.name}</span>
                  {r.role && <span className="ml-2 text-[11px] text-ink-2">{r.role === "PATIENT_COORDINATOR" ? "Coordinator" : r.role === "FRONT_DESK" ? "Front desk" : r.role}</span>}
                </Td>
                <Td align="right">{fmtCountNum(r.assignedJourneys)}</Td>
                <Td align="right">{fmtCountNum(r.appointmentsBooked)}</Td>
                <Td align="right" title={`${r.conversion.numerator} of ${r.conversion.denominator}`}>
                  {fmtPct(r.conversion.rate)}
                  <span className="ml-1 text-ink-2">
                    ({r.conversion.numerator}/{r.conversion.denominator})
                  </span>
                </Td>
                <Td align="right">{r.userId ? fmtCountNum(r.followUpsCompleted) : "—"}</Td>
                <Td align="right">{r.userId ? fmtCountNum(r.openTasks) : "—"}</Td>
                <Td align="right">{r.userId ? (r.overdueTasks > 0 ? <Badge tone="warning">{r.overdueTasks} overdue</Badge> : "0") : "—"}</Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      </TableShell>
      <p className="text-[11px] leading-4 text-ink-2">Assigned and appointments count journeys created in the period. Open tasks and overdue are a live snapshot.</p>
    </div>
  );
}
