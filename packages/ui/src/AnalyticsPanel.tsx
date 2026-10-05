import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "./primitives";
import { CHART_INK, fmtPct, pctChange } from "./chartTheme";

/**
 * White analytical surface with one header grammar for every chart: a title,
 * the QUESTION the chart answers as its subtitle, optional actions on the
 * right, then the body. Solid white — chart marks never sit on blurred glass.
 * Heading rows share a fixed height so adjacent panels' plot areas line up.
 */
export function AnalyticsPanel({
  title,
  question,
  actions,
  children,
  className = "",
  bodyClassName = "",
  testId,
  footer,
}: {
  title: string;
  question: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  footer?: ReactNode;
}) {
  return (
    <Card className={`flex min-w-0 flex-col ${className}`} data-testid={testId}>
      <div className="flex min-h-[3.25rem] items-start justify-between gap-3 px-4 pb-1 pt-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold leading-5 tracking-tight text-ink">{title}</h2>
          <p className="line-clamp-2 text-xs leading-4 text-ink-2 sm:truncate" title={question}>
            {question}
          </p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={`min-w-0 flex-1 px-4 pb-4 pt-2 ${bodyClassName}`}>{children}</div>
      {footer && <div className="border-t border-line px-4 py-2 text-[11px] leading-4 text-ink-2">{footer}</div>}
    </Card>
  );
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  /** Optional total shown after the label (e.g. leads in the period). */
  value?: number | string;
}

/**
 * The dependable identity channel. Present for every multi-series chart.
 * When `onItemClick` is given the items are buttons — the keyboard-accessible
 * twin of clicking a mark.
 */
export function ChartLegend({
  items,
  onItemClick,
  activeKey,
  className = "",
}: {
  items: LegendItem[];
  onItemClick?: (key: string) => void;
  activeKey?: string;
  className?: string;
}) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`} aria-label="Legend">
      {items.map((item) => {
        const body = (
          <>
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} aria-hidden="true" />
            <span className={activeKey === item.key ? "font-semibold text-ink" : "text-ink-2"}>{item.label}</span>
            {item.value !== undefined && <span className="tabular-nums text-ink">{item.value}</span>}
          </>
        );
        return (
          <li key={item.key}>
            {onItemClick ? (
              <button
                type="button"
                onClick={() => onItemClick(item.key)}
                aria-pressed={activeKey === item.key}
                className="inline-flex items-center gap-1.5 rounded-chip px-1 py-0.5 text-[11px] leading-4 transition hover:bg-primary-50"
              >
                {body}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-1 py-0.5 text-[11px] leading-4">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface TooltipRow {
  key: string;
  label: string;
  /** Swatch colour; omit for rows that are not a series. */
  color?: string;
  value: string;
  /** e.g. "% of day total". */
  share?: string;
}

/** The one tooltip design: opaque white, hairline border, value leads and the label follows. */
export function ChartTooltipCard({
  title,
  rows,
  footer,
  note,
}: {
  title: string;
  rows: TooltipRow[];
  footer?: { label: string; value: string };
  note?: string;
}) {
  return (
    <div className="min-w-[10.5rem] max-w-[16rem] rounded-control border border-line-strong bg-white px-3 py-2 text-xs shadow-glass" role="status">
      <p className="mb-1 font-semibold text-ink">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            {row.color && <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: row.color }} aria-hidden="true" />}
            <span className="min-w-0 flex-1 truncate text-ink-2">{row.label}</span>
            <span className="font-semibold tabular-nums text-ink">{row.value}</span>
            {row.share && <span className="w-9 text-right tabular-nums text-ink-2">{row.share}</span>}
          </li>
        ))}
      </ul>
      {footer && (
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-1">
          <span className="text-ink-2">{footer.label}</span>
          <span className="font-semibold tabular-nums text-ink">{footer.value}</span>
        </div>
      )}
      {note && <p className="mt-1 text-[11px] leading-4 text-ink-2">{note}</p>}
    </div>
  );
}

/** Honest empty / sparse state. Sits at the chart's own height so the layout does not jump. */
export function ChartEmptyState({ message, hint, height = 200 }: { message: string; hint?: string; height?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-control border border-dashed border-line-strong bg-surface-muted/60 px-4 text-center" style={{ height }} data-testid="chart-empty">
      <p className="text-sm font-medium text-ink-2">{message}</p>
      {hint && <p className="max-w-xs text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

/** Loading placeholder at the chart's final height. */
export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return <div className="animate-pulse rounded-control bg-primary-100/60 motion-reduce:animate-none" style={{ height }} aria-busy="true" aria-label="Loading chart" />;
}

/**
 * Change vs the previous period, stated in words and an icon (never colour
 * alone). No baseline → says so instead of inventing a percentage.
 */
export function TrendIndicator({ current, previous, label, className = "" }: { current: number; previous: number; label: string; className?: string }) {
  const change = pctChange(current, previous);
  if (change === null) {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] leading-4 text-ink-2 ${className}`}>
        <Minus size={11} aria-hidden="true" />
        No prior data
      </span>
    );
  }
  const rounded = Math.round(change * 100);
  const dir = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] leading-4 ${className}`}>
      <Icon size={12} aria-hidden="true" style={{ color: dir === "up" ? "#1c8a80" : CHART_INK.secondary }} />
      <span className="font-medium tabular-nums text-ink">{rounded > 0 ? "+" : ""}{rounded}%</span>
      <span className="text-ink-2">
        <span className="sr-only">{dir} </span>vs {label}
      </span>
    </span>
  );
}

/** Compact numeric block: label, tight figure, optional context line. */
export function MetricSummary({ label, value, sub, testId, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string; className?: string }) {
  return (
    <div className={`min-w-0 px-4 py-3 ${className}`} data-testid={testId}>
      <p className="truncate text-xs font-medium leading-4 text-ink-2">{label}</p>
      <p className="mt-1 text-[22px] font-semibold leading-7 tracking-tight text-ink tabular-nums">{value}</p>
      <div className="mt-0.5 min-h-4 text-[11px] leading-4 text-ink-2">{sub}</div>
    </div>
  );
}

/** Row of MetricSummary cells joined by hairlines in one white surface. */
export function MetricSummaryStrip({ children, columns, testId }: { children: ReactNode; columns: number; testId?: string }) {
  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line shadow-panel sm:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))] [&>*]:bg-surface"
      style={{ "--cols": columns } as React.CSSProperties}
      data-testid={testId}
    >
      {children}
    </div>
  );
}


