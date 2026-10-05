"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge, EmptyState } from "../primitives";
import type { Tone } from "../status";
import { useContainerWidth, VIEW_MOBILE_BREAKPOINT } from "./useContainerWidth";
import { BAR_TONE } from "./tones";
import { diffDays, formatKey, ganttBar, ganttPxPerDay, ganttTicks, localDayKey, nowInZone } from "./dates";
import type { DateInput, DayKey } from "./dates";

export interface GanttItem<T = unknown> {
  id: string;
  label: string;
  sublabel?: string;
  start: DateInput;
  /** Omit (or null) for an open-ended item: it renders as "Ongoing" and fades to the right edge. An end date is never invented. */
  end?: DateInput | null;
  tone?: Tone;
  /** Human status label, shown as text (not colour-only). */
  status?: string;
  ariaLabel?: string;
  data?: T;
}

export interface GanttTimelineProps<T = unknown> {
  items: GanttItem<T>[];
  /** Inclusive visible range, `yyyy-mm-dd` in `timeZone`. */
  rangeStart: DayKey;
  rangeEnd: DayKey;
  /** REQUIRED tenant/hospital IANA zone (e.g. "Asia/Kolkata"). Bar edges and the today marker use the local calendar in this zone. */
  timeZone: string;
  onItemClick?: (item: GanttItem<T>) => void;
  /** Custom content for the sticky label cell. */
  renderLabel?: (item: GanttItem<T>) => ReactNode;
  /** Sticky label column width in px on the desktop layout. Default 208. */
  labelWidth?: number;
  now?: Date;
  emptyMessage?: string;
  ariaLabel?: string;
  /** Called with the shifted range when the built-in prev/next range buttons are used (omit to hide them). */
  onRangeShift?: (dir: 1 | -1) => void;
  className?: string;
}

const ROW_H = 44;

function describe<T>(item: GanttItem<T>, timeZone: string): { range: string; label: string; open: boolean } {
  const fmtDay = (d: DateInput) => formatKey(localDayKey(d, timeZone), { day: "numeric", month: "short", year: "numeric" });
  const hasEnd = item.end != null && new Date(item.end).getTime() > new Date(item.start).getTime();
  const range = hasEnd ? `${fmtDay(item.start)} – ${fmtDay(item.end as DateInput)}` : `${fmtDay(item.start)} – Ongoing`;
  const label = item.ariaLabel ?? [item.label, range, item.status].filter(Boolean).join(", ");
  return { range, label, open: !hasEnd };
}

export function GanttTimeline<T = unknown>({
  items,
  rangeStart,
  rangeEnd,
  timeZone,
  onItemClick,
  renderLabel,
  labelWidth = 208,
  now: nowProp,
  emptyMessage = "Nothing to show in this range.",
  ariaLabel = "Timeline",
  onRangeShift,
  className = "",
}: GanttTimelineProps<T>) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const compact = width !== null && width < VIEW_MOBILE_BREAKPOINT;

  const { ticks, unit, totalDays } = useMemo(() => ganttTicks(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const rows = useMemo(
    () => items.map((item) => ({ item, bar: ganttBar(item.start, item.end, rangeStart, rangeEnd, timeZone), ...describe(item, timeZone) })),
    [items, rangeStart, rangeEnd, timeZone],
  );
  const visible = rows.filter((r) => r.bar.visible);
  const hidden = rows.length - visible.length;

  const today = nowInZone(nowProp ?? new Date(), timeZone);
  const todayIdx = diffDays(rangeStart, today.key);
  const todayPct = todayIdx >= 0 && todayIdx < totalDays ? ((todayIdx + today.minutes / 1440) / totalDays) * 100 : null;

  const scaleW = Math.max(totalDays * ganttPxPerDay(totalDays), 320);
  const rangeLabel = `${formatKey(rangeStart, { day: "numeric", month: "short", year: "numeric" })} – ${formatKey(rangeEnd, { day: "numeric", month: "short", year: "numeric" })}`;

  const header = (
    <div className="flex items-center gap-2 text-xs text-ink-2">
      {onRangeShift && (
        <span className="inline-flex gap-1">
          <button type="button" aria-label="Earlier" onClick={() => onRangeShift(-1)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-line-strong bg-white hover:bg-primary-50 sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11">
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Later" onClick={() => onRangeShift(1)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-line-strong bg-white hover:bg-primary-50 sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11">
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </span>
      )}
      <span aria-live="polite" className="font-medium text-ink">{rangeLabel}</span>
      {hidden > 0 && <span>{hidden} outside this range</span>}
    </div>
  );

  let body: ReactNode;
  if (visible.length === 0) {
    body = (
      <div className="rounded-card border border-line bg-surface">
        <EmptyState message={emptyMessage} />
      </div>
    );
  } else if (compact) {
    // Small screens: a compact timeline list, not a squeezed desktop grid.
    body = (
      <ul className="space-y-2" data-testid="gantt-list">
        {visible.map(({ item, bar, range, label, open }) => (
          <li key={item.id}>
            <button
              type="button"
              aria-label={label}
              onClick={() => onItemClick?.(item)}
              data-testid={`gantt-item-${item.id}`}
              className="block min-h-11 w-full rounded-card border border-line bg-surface p-3 text-left transition hover:bg-primary-50"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{item.label}</span>
                  {item.sublabel && <span className="block truncate text-xs text-ink-2">{item.sublabel}</span>}
                </span>
                {item.status && <Badge tone={item.tone && item.tone !== "primary" ? item.tone : "neutral"}>{item.status}</Badge>}
              </span>
              <span className="mt-1 block text-xs tabular-nums text-ink-2">
                {range}
                {open && <span className="sr-only"> (open-ended)</span>}
              </span>
              <span aria-hidden="true" className="relative mt-2 block h-1.5 rounded-full bg-neutral-100">
                <span
                  className={`absolute inset-y-0 rounded-full ${BAR_TONE[item.tone ?? "primary"]}`}
                  style={{ left: `${bar.leftPct}%`, width: `${Math.max(bar.widthPct, 1.5)}%`, ...(open ? { maskImage: "linear-gradient(to right, #000 40%, transparent)", WebkitMaskImage: "linear-gradient(to right, #000 40%, transparent)" } : {}) }}
                />
                {todayPct !== null && <span className="absolute -inset-y-0.5 w-0.5 rounded bg-primary-800" style={{ left: `${todayPct}%` }} />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="gantt-grid">
        <div className="overflow-x-auto">
          <div className="relative" style={{ width: labelWidth + scaleW, minWidth: "100%" }}>
            {/* header */}
            <div className="sticky top-0 z-30 flex border-b border-line bg-surface-muted" style={{ height: 40 }}>
              <div className="sticky left-0 z-40 flex shrink-0 items-end border-r border-line bg-surface-muted px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-2" style={{ width: labelWidth }}>
                Item
              </div>
              <div className="relative flex-1" style={{ minWidth: scaleW }}>
                {ticks.map((t) => (
                  <div key={t.key} className="absolute inset-y-0 border-l border-line pl-1 pt-1 text-[11px] leading-4 text-ink-2" style={{ left: `${t.leftPct}%` }}>
                    {unit === "day" ? (
                      <>
                        <span className="font-medium text-ink">{formatKey(t.key, { day: "numeric" })}</span> {formatKey(t.key, { weekday: "short" })}
                        {t.key.endsWith("-01") || t.key === rangeStart ? <span className="block text-[10px]">{formatKey(t.key, { month: "short" })}</span> : null}
                      </>
                    ) : unit === "week" ? (
                      formatKey(t.key, { day: "numeric", month: "short" })
                    ) : (
                      formatKey(t.key, { month: "short", year: t.key.slice(5, 7) === "01" ? "numeric" : undefined })
                    )}
                  </div>
                ))}
                {todayPct !== null && (
                  <span className="absolute bottom-0 -translate-x-1/2 rounded-t bg-primary-600 px-1.5 text-[10px] font-semibold leading-4 text-white" style={{ left: `${todayPct}%` }}>
                    Today
                  </span>
                )}
              </div>
            </div>

            {/* rows */}
            <div role="list" aria-label={ariaLabel} className="relative">
              {visible.map(({ item, bar, label, range, open }) => (
                <div key={item.id} role="listitem" className="flex border-b border-line last:border-b-0" style={{ height: ROW_H }}>
                  <div
                    className="sticky left-0 z-20 flex shrink-0 cursor-default flex-col justify-center border-r border-line bg-surface px-3"
                    style={{ width: labelWidth }}
                    onClick={() => onItemClick?.(item)}
                  >
                    {renderLabel ? (
                      renderLabel(item)
                    ) : (
                      <>
                        <span className="truncate text-sm font-medium text-ink">{item.label}</span>
                        {(item.sublabel || item.status) && <span className="truncate text-[11px] text-ink-2">{[item.sublabel, item.status].filter(Boolean).join(" · ")}</span>}
                      </>
                    )}
                  </div>
                  <div className="relative flex-1" style={{ minWidth: scaleW }}>
                    {ticks.map((t) => (
                      <span key={t.key} aria-hidden="true" className="absolute inset-y-0 border-l border-line/60" style={{ left: `${t.leftPct}%` }} />
                    ))}
                    <button
                      type="button"
                      aria-label={label}
                      title={`${item.label}: ${range}`}
                      onClick={() => onItemClick?.(item)}
                      data-testid={`gantt-item-${item.id}`}
                      data-open-ended={open ? "true" : "false"}
                      className="group absolute top-2 flex items-center overflow-hidden rounded-chip text-left"
                      style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%`, minWidth: 28, height: ROW_H - 16 }}
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute inset-0 rounded-chip opacity-90 transition group-hover:opacity-100 ${BAR_TONE[item.tone ?? "primary"]}`}
                        style={open ? { maskImage: "linear-gradient(to right, #000 35%, transparent)", WebkitMaskImage: "linear-gradient(to right, #000 35%, transparent)" } : undefined}
                      />
                      {bar.clippedStart && <ChevronLeft size={12} aria-hidden="true" className="relative z-10 ml-0.5 shrink-0 text-white" />}
                      <span className={`relative z-10 truncate px-1.5 text-[11px] font-medium ${open ? "text-ink" : "text-white"}`}>
                        {open ? "Ongoing" : item.label}
                      </span>
                    </button>
                  </div>
                </div>
              ))}
              {todayPct !== null && (
                <div aria-hidden="true" data-testid="gantt-today" className="pointer-events-none absolute inset-y-0 z-10" style={{ left: labelWidth, right: 0 }}>
                  <span className="absolute inset-y-0 w-px bg-primary-600" style={{ left: `${todayPct}%` }} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} role="region" aria-label={ariaLabel} data-testid="gantt-timeline" data-mobile-fallback={compact ? "true" : "false"} className={`min-w-0 space-y-2 ${className}`}>
      {header}
      {body}
    </div>
  );
}
