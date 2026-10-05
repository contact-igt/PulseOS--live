"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsPeriod, LeadsBySourceResponse, SourceChannel } from "@pulseos/types";
import { ChartEmptyState, ChartLegend, ChartTooltipCard } from "./AnalyticsPanel";
import { CHART_INK, SOURCE_LABELS, chartSourceKey, fmtBucketLabel, fmtCountNum, fmtDayShort, fmtPct, niceCountAxis, sourceColor } from "./chartTheme";
import { inProgressIndex } from "./trend";

type Row = { key: string; label: string; total: number; span: string; inProgress: boolean } & Record<string, number | string | boolean>;

/**
 * Stacked bars: enquiries per day (or per 7-day block for long ranges) split by
 * source. Answers "which sources are bringing patients in, and when?". Colour
 * follows the source (fixed slot), the legend doubles as the keyboard route to
 * the click-to-filter action, and the tooltip shows count and share of the
 * bucket total. `organic` folds into `other` so the palette never needs a 9th
 * hue.
 */
export function DailySourceChart({
  data,
  height = 240,
  onSourceClick,
  activeSource,
  compact = false,
  testId = "daily-source-chart",
}: {
  /** `period.today` marks the still-running bucket; omit it for a fully past range. */
  data: Pick<LeadsBySourceResponse, "buckets" | "sources" | "granularity" | "total"> & { period?: Pick<AnalyticsPeriod, "today"> };
  height?: number;
  onSourceClick?: (source: SourceChannel) => void;
  activeSource?: SourceChannel;
  /** Command Centre variant: fewer ticks. */
  compact?: boolean;
  testId?: string;
}) {
  const openIndex = inProgressIndex(data.buckets, data.period?.today);
  const running = data.granularity === "day" ? "Today" : "This week";
  const { rows, series, totals } = useMemo(() => {
    const keys = [...new Set(data.sources.map(chartSourceKey))];
    const totals = new Map<SourceChannel, number>();
    const rows: Row[] = data.buckets.map((b, i) => {
      const row: Row = {
        key: b.key,
        label: i === openIndex ? running : fmtDayShort(b.key),
        span: fmtBucketLabel(b),
        total: b.total,
        inProgress: i === openIndex,
      };
      for (const k of keys) row[k] = 0;
      for (const [src, n] of Object.entries(b.bySource) as [SourceChannel, number][]) {
        const k = chartSourceKey(src);
        row[k] = (row[k] as number) + n;
        totals.set(k, (totals.get(k) ?? 0) + n);
      }
      return row;
    });
    return { rows, series: keys, totals };
  }, [data, openIndex, running]);

  if (data.total === 0) {
    return <ChartEmptyState height={height} message="No enquiries in this period" hint="Widen the date range or clear a filter to see enquiries by source." />;
  }

  const legend = series.map((s) => ({ key: s, label: SOURCE_LABELS[s], color: sourceColor(s), value: totals.get(s) ?? 0 }));
  const axis = niceCountAxis(Math.max(...rows.map((r) => r.total), 0));
  const nonZero = rows.filter((r) => r.total > 0).length;
  const summary = `Enquiries by source, ${rows.length} ${data.granularity === "day" ? "days" : "weeks"}: ${data.total} in total across ${nonZero} active ${data.granularity === "day" ? "days" : "weeks"}.` + (openIndex !== -1 ? ` ${running} is still in progress.` : "");

  return (
    <div data-testid={testId}>
      <ChartLegend items={legend} onItemClick={onSourceClick ? (k) => onSourceClick(k as SourceChannel) : undefined} activeKey={activeSource ? chartSourceKey(activeSource) : undefined} className="mb-2" />
      <div role="img" aria-label={summary} style={{ height }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={rows.length > 14 ? "22%" : "34%"} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: CHART_INK.baseline }}
              tick={{ fontSize: 11, fill: CHART_INK.secondary }}
              interval={openIndex !== -1 ? "preserveEnd" : "equidistantPreserveStart"}
              minTickGap={compact ? 28 : 14}
              tickMargin={6}
            />
            <YAxis
              width={26}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: CHART_INK.secondary }}
              domain={[0, axis.max]}
              ticks={axis.ticks}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: "rgba(37,132,178,0.07)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Row;
                const items = [...series].reverse().filter((s) => (row[s] as number) > 0);
                return (
                  <ChartTooltipCard
                    title={row.span}
                    rows={items.map((s) => ({
                      key: s,
                      label: SOURCE_LABELS[s],
                      color: sourceColor(s),
                      value: fmtCountNum(row[s] as number),
                      share: fmtPct(row.total > 0 ? (row[s] as number) / row.total : null),
                    }))}
                    footer={{ label: "Total", value: fmtCountNum(row.total) }}
                    note={row.inProgress ? `${running} is still in progress — counted so far.` : undefined}
                  />
                );
              }}
            />
            {series.map((s, i) => (
              <Bar
                key={s}
                dataKey={s}
                stackId="leads"
                fill={sourceColor(s)}
                stroke={CHART_INK.surface}
                strokeWidth={1.5}
                maxBarSize={24}
                isAnimationActive={false}
                cursor={onSourceClick ? "pointer" : undefined}
                onClick={onSourceClick ? () => onSourceClick(s) : undefined}
                radius={i === series.length - 1 ? [3, 3, 0, 0] : 0}
                name={SOURCE_LABELS[s]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
