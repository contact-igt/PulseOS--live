"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Ban, ChevronLeft, ChevronRight, CircleCheck } from "lucide-react";
import { Badge, Button, EmptyState } from "../primitives";
import type { Tone } from "../status";
import { ViewSwitcher } from "./ViewSwitcher";
import { useContainerWidth, VIEW_MOBILE_BREAKPOINT } from "./useContainerWidth";
import { CHIP_TONE } from "./tones";
import {
  addDays,
  assignLanes,
  diffDays,
  eventDayKeys,
  formatDayLong,
  formatDayShort,
  formatKey,
  formatSpanTitle,
  formatTime,
  monthGrid,
  nowInZone,
  segmentForDay,
  shiftDate,
  startOfMonth,
  toInterval,
  visibleRange,
  weekDays,
  daysInMonth,
} from "./dates";
import type { CalendarSpan, DateInput, DayKey, WeekStart } from "./dates";

export type CalendarMode = "day" | "week" | "month" | "agenda";

export interface CalendarEvent<T = unknown> {
  id: string;
  start: DateInput;
  end?: DateInput | null;
  title: string;
  subtitle?: string;
  /** Human status label (e.g. "Confirmed"). Shown as text and included in the accessible label. */
  status?: string;
  /** cancelled / completed get an icon (and strike-through for cancelled) so state is never colour-only. */
  state?: "default" | "completed" | "cancelled";
  tone?: Tone;
  /** Overrides the generated "time, title, status" accessible label. */
  ariaLabel?: string;
  /** Your original record, handed back untouched through `onEventClick`. */
  data?: T;
}

export type EventLayout = "block" | "pill" | "row";

export interface CalendarViewProps<T = unknown> {
  events: CalendarEvent<T>[];
  mode: CalendarMode;
  /** Selected day, `yyyy-mm-dd` in `timeZone`. */
  date: DayKey;
  onDateChange: (date: DayKey) => void;
  onModeChange?: (mode: CalendarMode) => void;
  /** "Open this day" (week header, "+k more"). Default: onDateChange(day) then onModeChange("day"). */
  onOpenDay?: (date: DayKey) => void;
  /** REQUIRED tenant/hospital IANA zone (e.g. "Asia/Kolkata"). Events are bucketed by the local day in this zone, never UTC. */
  timeZone: string;
  weekStartsOn?: WeekStart;
  onEventClick?: (event: CalendarEvent<T>) => void;
  /** Replace the inside of an event button (the button, label and click handling stay ours). */
  renderEvent?: (event: CalendarEvent<T>, ctx: { layout: EventLayout; timeLabel: string }) => ReactNode;
  /** Minimum visible hour range for day/week; widened automatically if events fall outside it. Default 8-20. */
  hours?: { start: number; end: number };
  /** Events shown per month cell before "+k more". Default 3. */
  maxMonthEvents?: number;
  /** Span an explicit `mode="agenda"` lists. Default "week". */
  agendaSpan?: CalendarSpan;
  /** "agenda" (default): below `VIEW_MOBILE_BREAKPOINT` (640px of container width) day/week/month render as an Agenda list. "off" disables it. */
  mobileFallback?: "agenda" | "off";
  /** Inject the clock (tests, deterministic screenshots). Defaults to the real time, refreshed each minute. */
  now?: Date;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
}

const HOUR_PX = 56;
const MIN_BLOCK_MIN = 30;

const MODE_OPTIONS_WIDE = [
  { key: "day" as const, label: "Day" },
  { key: "week" as const, label: "Week" },
  { key: "month" as const, label: "Month" },
  { key: "agenda" as const, label: "Agenda" },
];
const MODE_OPTIONS_NARROW = MODE_OPTIONS_WIDE.slice(0, 3);

function useNow(nowProp?: Date): Date {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    if (nowProp) return;
    const id = setInterval(() => setTick(new Date()), 60_000);
    return () => clearInterval(id);
  }, [nowProp]);
  return nowProp ?? tick;
}

function hourLabel(h: number): string {
  const hh = h % 24;
  const suffix = hh >= 12 ? "pm" : "am";
  return `${hh % 12 === 0 ? 12 : hh % 12} ${suffix}`;
}

interface Prepared<T> {
  event: CalendarEvent<T>;
  startMs: number;
  timeLabel: string;
  label: string;
}

/** Shared accessible label: "10:30 am to 11:00 am, Title, Confirmed". */
function buildLabels<T>(event: CalendarEvent<T>, timeZone: string) {
  const iv = toInterval(event.start, event.end);
  const timeLabel = iv.hasEnd ? `${formatTime(event.start, timeZone)} – ${formatTime(event.end as DateInput, timeZone)}` : formatTime(event.start, timeZone);
  const spoken = iv.hasEnd ? `${formatTime(event.start, timeZone)} to ${formatTime(event.end as DateInput, timeZone)}` : formatTime(event.start, timeZone);
  const stateWord = event.state === "cancelled" ? "Cancelled" : event.state === "completed" ? "Completed" : "";
  const statusText = event.status ?? "";
  const extra = stateWord && !statusText.toLowerCase().includes(stateWord.toLowerCase()) ? stateWord : "";
  const label = event.ariaLabel ?? [spoken, event.title, statusText, extra].filter(Boolean).join(", ");
  return { timeLabel, label, startMs: iv.startMs };
}

function StateIcon({ state, size = 12 }: { state?: CalendarEvent["state"]; size?: number }) {
  if (state === "cancelled") return <Ban size={size} aria-hidden="true" className="shrink-0 text-neutral-500" />;
  if (state === "completed") return <CircleCheck size={size} aria-hidden="true" className="shrink-0 text-accent-700" />;
  return null;
}

function EventButton<T>({
  p,
  layout,
  style,
  onClick,
  renderEvent,
  compact = false,
}: {
  p: Prepared<T>;
  layout: EventLayout;
  style?: CSSProperties;
  onClick?: (e: CalendarEvent<T>) => void;
  renderEvent?: CalendarViewProps<T>["renderEvent"];
  compact?: boolean;
}) {
  const { event } = p;
  const cancelled = event.state === "cancelled";
  const base = `${CHIP_TONE[event.tone ?? "primary"]} border-l-[3px] text-left text-ink transition focus-visible:z-20`;
  const dim = cancelled ? "opacity-80" : "";
  const title = `${event.title}${event.status ? ` (${event.status})` : ""}`;

  const defaultBody =
    layout === "row" ? (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <StateIcon state={event.state} size={14} />
          <span className={`min-w-0 truncate text-sm font-medium ${cancelled ? "line-through" : ""}`}>{event.title}</span>
        </span>
        {event.subtitle && <span className="truncate text-xs text-ink-2">{event.subtitle}</span>}
      </span>
    ) : layout === "pill" ? (
      <span className="flex min-w-0 items-center gap-1">
        <StateIcon state={event.state} size={11} />
        <span className="shrink-0 tabular-nums text-ink-2">{formatTimeShort(p.timeLabel)}</span>
        <span className={`min-w-0 truncate font-medium ${cancelled ? "line-through" : ""}`}>{event.title}</span>
      </span>
    ) : compact ? (
      // A short block (~26px for 30 minutes) fits one line only: time, title and
      // status inline — status stays as text, never colour alone.
      <span className="flex min-w-0 items-center gap-1">
        <StateIcon state={event.state} />
        <span className="shrink-0 tabular-nums text-ink-2">{formatTimeShort(p.timeLabel)}</span>
        <span className={`min-w-0 truncate font-medium ${cancelled ? "line-through" : ""}`}>{event.title}</span>
        {event.status && <span className="ml-auto shrink-0 text-[10px] font-medium text-ink-2">{event.status}</span>}
      </span>
    ) : (
      <span className="flex min-w-0 flex-col gap-px">
        <span className="flex min-w-0 items-center gap-1">
          <StateIcon state={event.state} />
          <span className="truncate tabular-nums text-ink-2">{p.timeLabel}</span>
        </span>
        <span className={`truncate font-medium ${cancelled ? "line-through" : ""}`}>{event.title}</span>
        {event.subtitle && <span className="truncate text-ink-2">{event.subtitle}</span>}
        {event.status && <span className="truncate text-[10px] font-medium uppercase tracking-wide text-ink-2">{event.status}</span>}
      </span>
    );

  const body = renderEvent ? renderEvent(event, { layout, timeLabel: p.timeLabel }) : defaultBody;

  if (layout === "row") {
    return (
      <button
        type="button"
        aria-label={p.label}
        onClick={() => onClick?.(event)}
        data-testid={`calendar-event-${event.id}`}
        className={`flex w-full min-h-11 items-center gap-3 rounded-control border border-line px-3 py-2 ${base} ${dim}`}
      >
        <span className="w-24 shrink-0 text-xs font-medium tabular-nums text-ink-2">{p.timeLabel}</span>
        {body}
        {event.status && <Badge tone={event.tone === "danger" || event.tone === "warning" || event.tone === "success" ? event.tone : "neutral"}>{event.status}</Badge>}
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={p.label}
      title={title}
      onClick={() => onClick?.(event)}
      style={style}
      data-testid={`calendar-event-${event.id}`}
      className={`block w-full overflow-hidden rounded-chip ${layout === "pill" ? "px-1.5 py-0.5 text-[11px] leading-4" : "px-1.5 py-1 text-[11px] leading-[14px]"} ${base} ${dim}`}
    >
      {body}
    </button>
  );
}

/** "10:30 am - 11:00 am" -> "10:30 am"; leaves single times alone. */
function formatTimeShort(label: string): string {
  return label.split(" – ")[0].replace(" am", "a").replace(" pm", "p");
}

export function CalendarView<T = unknown>({
  events,
  mode,
  date,
  onDateChange,
  onModeChange,
  onOpenDay,
  timeZone,
  weekStartsOn = 1,
  onEventClick,
  renderEvent,
  hours = { start: 8, end: 20 },
  maxMonthEvents = 3,
  agendaSpan = "week",
  mobileFallback = "agenda",
  now: nowProp,
  emptyMessage = "Nothing scheduled in this period.",
  ariaLabel = "Calendar",
  className = "",
}: CalendarViewProps<T>) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const now = useNow(nowProp);
  const today = nowInZone(now, timeZone);

  const narrow = mobileFallback === "agenda" && width !== null && width < VIEW_MOBILE_BREAKPOINT;
  const fellBack = narrow && mode !== "agenda";
  const effective: CalendarMode = fellBack ? "agenda" : mode;
  const span: CalendarSpan = mode === "agenda" ? agendaSpan : mode;

  const prepared = useMemo(() => {
    const byDay = new Map<DayKey, Prepared<T>[]>();
    for (const event of events) {
      const labels = buildLabels(event, timeZone);
      const p: Prepared<T> = { event, ...labels };
      for (const key of eventDayKeys(event.start, event.end, timeZone)) {
        const list = byDay.get(key);
        if (list) list.push(p);
        else byDay.set(key, [p]);
      }
    }
    for (const list of byDay.values()) list.sort((a, b) => a.startMs - b.startMs || a.event.id.localeCompare(b.event.id));
    return byDay;
  }, [events, timeZone]);

  const openDay = (key: DayKey) => {
    if (onOpenDay) return onOpenDay(key);
    onDateChange(key);
    onModeChange?.("day");
  };

  const dir = (d: 1 | -1) => onDateChange(shiftDate(date, span, d));
  const spanWord = span;
  const title = formatSpanTitle(span, date, weekStartsOn);

  return (
    <div
      ref={ref}
      role="region"
      aria-label={ariaLabel}
      data-testid="calendar-view"
      data-mode={effective}
      data-mobile-fallback={fellBack ? "true" : "false"}
      className={`min-w-0 space-y-3 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1">
          <Button variant="secondary" size="sm" aria-label={`Previous ${spanWord}`} onClick={() => dir(-1)} className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11" data-testid="calendar-prev">
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <Button variant="secondary" size="sm" aria-label={`Next ${spanWord}`} onClick={() => dir(1)} className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11" data-testid="calendar-next">
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <Button variant="secondary" size="sm" aria-label="Go to today" onClick={() => onDateChange(today.key)} className="min-h-11 sm:min-h-8 pointer-coarse:min-h-11" data-testid="calendar-today">
          Today
        </Button>
        <h2 aria-live="polite" className="min-w-0 flex-1 basis-40 text-sm font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {onModeChange && (
          <ViewSwitcher
            ariaLabel="Calendar range"
            value={narrow ? (span as "day" | "week" | "month") : mode}
            onChange={(k) => onModeChange(k)}
            options={narrow ? MODE_OPTIONS_NARROW : MODE_OPTIONS_WIDE}
          />
        )}
      </div>

      {effective === "agenda" ? (
        <AgendaList span={span} date={date} weekStartsOn={weekStartsOn} prepared={prepared} today={today.key} onEventClick={onEventClick} renderEvent={renderEvent} emptyMessage={emptyMessage} />
      ) : effective === "month" ? (
        <MonthGrid
          date={date}
          weekStartsOn={weekStartsOn}
          prepared={prepared}
          today={today.key}
          maxEvents={maxMonthEvents}
          onDateChange={onDateChange}
          openDay={openDay}
          onEventClick={onEventClick}
          renderEvent={renderEvent}
        />
      ) : (
        <TimeGrid
          days={effective === "day" ? [date] : weekDays(date, weekStartsOn)}
          date={date}
          prepared={prepared}
          timeZone={timeZone}
          today={today}
          hours={hours}
          onDateChange={onDateChange}
          openDay={openDay}
          onEventClick={onEventClick}
          renderEvent={renderEvent}
          emptyMessage={emptyMessage}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day / Week time grid
// ---------------------------------------------------------------------------
function TimeGrid<T>({
  days,
  date,
  prepared,
  timeZone,
  today,
  hours,
  onDateChange,
  openDay,
  onEventClick,
  renderEvent,
  emptyMessage,
}: {
  days: DayKey[];
  date: DayKey;
  prepared: Map<DayKey, Prepared<T>[]>;
  timeZone: string;
  today: { key: DayKey; minutes: number };
  hours: { start: number; end: number };
  onDateChange: (d: DayKey) => void;
  openDay: (d: DayKey) => void;
  onEventClick?: (e: CalendarEvent<T>) => void;
  renderEvent?: CalendarViewProps<T>["renderEvent"];
  emptyMessage: string;
}) {
  const isWeek = days.length > 1;

  const columns = days.map((key) => {
    const items = (prepared.get(key) ?? []).flatMap((p) => {
      const seg = segmentForDay(p.event.start, p.event.end, key, timeZone, MIN_BLOCK_MIN);
      return seg ? [{ p, startMin: seg.startMin, endMin: Math.max(seg.endMin, seg.startMin + MIN_BLOCK_MIN) }] : [];
    });
    return { key, items, lanes: assignLanes(items.map((i) => ({ id: i.p.event.id, startMin: i.startMin, endMin: i.endMin }))) };
  });

  // Never drop an event that falls outside the nominal hours: widen the grid instead.
  let startH = hours.start;
  let endH = hours.end;
  for (const c of columns) {
    for (const i of c.items) {
      startH = Math.min(startH, Math.floor(i.startMin / 60));
      endH = Math.max(endH, Math.ceil(i.endMin / 60));
    }
  }
  startH = Math.max(0, startH);
  endH = Math.min(24, Math.max(endH, startH + 1));
  const totalPx = (endH - startH) * HOUR_PX;
  const hourMarks = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const gridCols = `3.25rem repeat(${days.length}, minmax(0, 1fr))`;
  const total = columns.reduce((n, c) => n + c.items.length, 0);
  const nowTop = ((today.minutes - startH * 60) / 60) * HOUR_PX;
  const nowVisible = nowTop >= 0 && nowTop <= totalPx;

  // An early event widens the grid upward; still open on the working day, not on
  // hours of empty night. The early event stays reachable by scrolling up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const workdayOffset = Math.max(0, hours.start - startH) * HOUR_PX;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = workdayOffset;
  }, [workdayOffset, date]);

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div ref={scrollRef} className="max-h-[calc(100vh-15rem)] min-h-[22rem] overflow-y-auto" data-testid="calendar-scroll">
        <div className="sticky top-0 z-30 grid border-b border-line bg-surface" style={{ gridTemplateColumns: gridCols }}>
          <div />
          {days.map((key) => {
            const isToday = key === today.key;
            const selected = key === date;
            const inner = (
              <>
                <span className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{formatKey(key, { weekday: "short" })}</span>
                <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm font-semibold tabular-nums ${isToday ? "bg-primary-600 text-white" : "text-ink"}`}>
                  {formatKey(key, { day: "numeric" })}
                </span>
                {isToday && <span className="sr-only">(today)</span>}
              </>
            );
            return isWeek ? (
              <button
                key={key}
                type="button"
                aria-label={`${formatDayLong(key)}${isToday ? ", today" : ""}. Open day view`}
                aria-current={isToday ? "date" : undefined}
                onClick={() => openDay(key)}
                data-testid={`calendar-day-${key}`}
                className={`flex min-h-11 flex-col items-center gap-0.5 border-l border-line py-1.5 transition hover:bg-primary-50 ${selected ? "bg-primary-50" : ""}`}
              >
                {inner}
              </button>
            ) : (
              <div key={key} aria-current={isToday ? "date" : undefined} className="flex flex-col items-center gap-0.5 border-l border-line py-1.5">
                {inner}
              </div>
            );
          })}
        </div>

        <div className="relative grid" style={{ gridTemplateColumns: gridCols, height: totalPx }}>
          <div className="relative" aria-hidden="true">
            {hourMarks.map((h, i) => (
              <span key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-ink-2" style={{ top: i * HOUR_PX, display: i === 0 ? "none" : undefined }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {columns.map((col) => {
            const isToday = col.key === today.key;
            const selected = col.key === date;
            return (
              <div
                key={col.key}
                role="group"
                aria-label={`${formatDayLong(col.key)}, ${col.items.length} ${col.items.length === 1 ? "event" : "events"}`}
                className={`relative border-l border-line ${selected && isWeek ? "bg-primary-50/50" : ""}`}
              >
                {hourMarks.map((h, i) => (
                  <div key={h} aria-hidden="true" className="absolute inset-x-0 border-t border-line/70" style={{ top: i * HOUR_PX }} />
                ))}
                {col.items.map(({ p, startMin, endMin }) => {
                  const lane = col.lanes.get(p.event.id) ?? { lane: 0, lanes: 1 };
                  const top = ((startMin - startH * 60) / 60) * HOUR_PX;
                  const height = ((endMin - startMin) / 60) * HOUR_PX;
                  return (
                    <div
                      key={p.event.id}
                      className="absolute px-px"
                      style={{ top: top + 1, height: Math.max(height - 2, 20), left: `${(lane.lane / lane.lanes) * 100}%`, width: `${100 / lane.lanes}%` }}
                    >
                      <EventButton p={p} layout="block" compact={height < 44 || lane.lanes > 2} onClick={onEventClick} renderEvent={renderEvent} style={{ height: "100%" }} />
                    </div>
                  );
                })}
                {isToday && nowVisible && (
                  <div aria-hidden="true" data-testid="calendar-now-line" className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
                    <span className="-ml-1 h-2 w-2 rounded-full bg-primary-600" />
                    <span className="h-px flex-1 bg-primary-600" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {total === 0 && <div className="border-t border-line"><EmptyState message={emptyMessage} /></div>}
      {isWeek && today.key >= days[0] && today.key <= days[days.length - 1] && <span className="sr-only">Today is {formatDayLong(today.key)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------
function MonthGrid<T>({
  date,
  weekStartsOn,
  prepared,
  today,
  maxEvents,
  onDateChange,
  openDay,
  onEventClick,
  renderEvent,
}: {
  date: DayKey;
  weekStartsOn: WeekStart;
  prepared: Map<DayKey, Prepared<T>[]>;
  today: DayKey;
  maxEvents: number;
  onDateChange: (d: DayKey) => void;
  openDay: (d: DayKey) => void;
  onEventClick?: (e: CalendarEvent<T>) => void;
  renderEvent?: CalendarViewProps<T>["renderEvent"];
}) {
  const grid = monthGrid(date, weekStartsOn);
  const header = grid[0].map((c) => c.key);
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="grid grid-cols-7 border-b border-line bg-surface-muted">
        {header.map((k) => (
          <div key={k} className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-ink-2">
            {formatKey(k, { weekday: "short" })}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {grid.flat().map((cell, idx) => {
          const list = prepared.get(cell.key) ?? [];
          const shown = list.slice(0, maxEvents);
          const more = list.length - shown.length;
          const isToday = cell.key === today;
          const selected = cell.key === date;
          return (
            <div
              key={cell.key}
              role="group"
              aria-label={`${formatDayLong(cell.key)}${isToday ? ", today" : ""}, ${list.length} ${list.length === 1 ? "event" : "events"}`}
              data-testid={`calendar-cell-${cell.key}`}
              className={`flex min-h-28 min-w-0 flex-col gap-1 border-line p-1 ${idx % 7 !== 0 ? "border-l" : ""} ${idx >= 7 ? "border-t" : ""} ${
                selected ? "bg-primary-50 ring-1 ring-inset ring-primary-300" : cell.inMonth ? "bg-surface" : "bg-surface-muted"
              }`}
            >
              <button
                type="button"
                aria-label={`Select ${formatDayLong(cell.key)}${isToday ? " (today)" : ""}`}
                aria-current={isToday ? "date" : undefined}
                aria-pressed={selected}
                onClick={() => onDateChange(cell.key)}
                className={`inline-flex h-6 min-w-6 self-start items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums transition ${
                  isToday ? "bg-primary-600 text-white" : cell.inMonth ? "text-ink hover:bg-primary-100" : "text-neutral-400 hover:bg-primary-100"
                }`}
              >
                {formatKey(cell.key, { day: "numeric" })}
              </button>
              {shown.map((p) => (
                <EventButton key={p.event.id} p={p} layout="pill" onClick={onEventClick} renderEvent={renderEvent} />
              ))}
              {more > 0 && (
                <button
                  type="button"
                  onClick={() => openDay(cell.key)}
                  aria-label={`${more} more ${more === 1 ? "event" : "events"} on ${formatDayLong(cell.key)}. Open day`}
                  data-testid={`calendar-more-${cell.key}`}
                  className="self-start rounded-chip px-1.5 py-0.5 text-[11px] font-medium text-primary-700 hover:bg-primary-100"
                >
                  +{more} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agenda (also the small-screen fallback)
// ---------------------------------------------------------------------------
function AgendaList<T>({
  span,
  date,
  weekStartsOn,
  prepared,
  today,
  onEventClick,
  renderEvent,
  emptyMessage,
}: {
  span: CalendarSpan;
  date: DayKey;
  weekStartsOn: WeekStart;
  prepared: Map<DayKey, Prepared<T>[]>;
  today: DayKey;
  onEventClick?: (e: CalendarEvent<T>) => void;
  renderEvent?: CalendarViewProps<T>["renderEvent"];
  emptyMessage: string;
}) {
  // Agenda lists only the days of the period itself (the month view's grey
  // spill-over days are not part of "September").
  const range = span === "month" ? { from: startOfMonth(date), to: addDays(startOfMonth(date), daysInMonth(date) - 1) } : visibleRange(span, date, weekStartsOn);
  const dayCount = diffDays(range.from, range.to) + 1;
  const days = Array.from({ length: dayCount }, (_, i) => addDays(range.from, i)).filter((k) => (prepared.get(k)?.length ?? 0) > 0 || (span === "day"));
  const total = days.reduce((n, k) => n + (prepared.get(k)?.length ?? 0), 0);

  if (total === 0) {
    return (
      <div className="rounded-card border border-line bg-surface" data-testid="calendar-agenda">
        <EmptyState message={emptyMessage} />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="calendar-agenda">
      {days.map((key) => {
        const list = prepared.get(key) ?? [];
        const isToday = key === today;
        return (
          <section key={key} aria-label={`${formatDayLong(key)}, ${list.length} ${list.length === 1 ? "event" : "events"}`} className="overflow-hidden rounded-card border border-line bg-surface">
            <h3 className={`flex items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold ${key === date ? "bg-primary-50 text-primary-800" : "bg-surface-muted text-ink"}`}>
              {formatDayShort(key)}
              {isToday && <Badge tone="primary">Today</Badge>}
            </h3>
            {list.length === 0 ? (
              <p className="px-3 py-3 text-sm text-ink-2">{emptyMessage}</p>
            ) : (
              <ul className="space-y-1.5 p-2">
                {list.map((p) => (
                  <li key={p.event.id}>
                    <EventButton p={p} layout="row" onClick={onEventClick} renderEvent={renderEvent} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
