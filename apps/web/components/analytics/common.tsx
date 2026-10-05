"use client";

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ChartSkeleton, ErrorState } from "@pulseos/ui";
import { CHART_INK } from "@pulseos/ui";

/**
 * Query boundary for one panel. First load shows a skeleton at the chart's
 * final height; a refetch (a filter changed) keeps the previous render at
 * reduced opacity — no skeleton flash, no layout jump.
 */
export function Async<T>({ query, height = 220, error, fill = false, children }: { query: UseQueryResult<T>; height?: number; error: string; /** Stretch to the panel body (for content that centres itself vertically). */ fill?: boolean; children: (data: T) => ReactNode }) {
  if (query.isError && !query.data) return <ErrorState message={error} />;
  if (!query.data) return <ChartSkeleton height={height} />;
  return (
    <div className={`${fill ? "flex-1 " : ""}${query.isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}`} aria-busy={query.isFetching}>
      {children(query.data)}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  /** Numeric length of the bar (0 renders no bar, never a fake sliver). */
  value: number;
  /** Text at the bar tip / right column, e.g. "77%". */
  valueLabel: string;
  /** Muted context after the value, e.g. "27 of 35". */
  sub?: string;
  color?: string;
  /** Draws a light track behind the bar out to this value (used to show what was lost since the previous stage). */
  trackValue?: number;
  onClick?: () => void;
}

/**
 * Ranked horizontal bars in HTML/CSS: label column, aligned bars, value + context
 * column. Every row prints its value (and denominator), so the bars are a visual
 * twin of the numbers rather than the only way to read them.
 */
export function RankedBars({
  rows,
  max,
  marker,
  labelWidth = "w-28 sm:w-36",
  testId,
  ariaLabel,
}: {
  rows: BarRow[];
  max?: number;
  /** Optional reference line, e.g. break-even ROAS of 1×. */
  marker?: { value: number; label: string };
  labelWidth?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const domain = Math.max(max ?? 0, ...rows.map((r) => Math.max(r.value, r.trackValue ?? 0)), marker?.value ?? 0, 1e-9);
  const pct = (v: number) => `${Math.min((v / domain) * 100, 100)}%`;
  return (
    <ul className="space-y-1" data-testid={testId} aria-label={ariaLabel}>
      {rows.map((row) => {
        const inner = (
          <>
            <span className={`${labelWidth} shrink-0 truncate text-left text-xs text-ink`} title={row.label}>
              {row.label}
            </span>
            <span className="relative h-4 min-w-0 flex-1">
              {row.trackValue !== undefined && <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: pct(row.trackValue), backgroundColor: CHART_INK.track }} aria-hidden="true" />}
              {row.value > 0 && (
                <span className="absolute inset-y-[2px] left-0 rounded-r-[4px]" style={{ width: pct(row.value), backgroundColor: row.color ?? CHART_INK.accent, minWidth: 3 }} aria-hidden="true" />
              )}
              {marker && <span className="absolute inset-y-[-2px] w-px bg-neutral-400" style={{ left: pct(marker.value) }} aria-hidden="true" title={marker.label} />}
            </span>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-ink sm:w-32">
              <span className="font-semibold">{row.valueLabel}</span>
              {row.sub && <span className="ml-1.5 text-ink-2">{row.sub}</span>}
            </span>
          </>
        );
        return (
          <li key={row.key}>
            {row.onClick ? (
              <button type="button" onClick={row.onClick} className="flex w-full items-center gap-2 rounded-chip py-0.5 text-left transition hover:bg-primary-50" data-testid={`bar-${row.key}`}>
                {inner}
              </button>
            ) : (
              <div className="flex w-full items-center gap-2 py-0.5" data-testid={`bar-${row.key}`}>
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Small-caps column header used by the analytics tables. */
export const TH = "px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2";
