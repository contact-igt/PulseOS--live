"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatKey } from "@pulseos/ui";
import { dayDisabled, monthGrid, monthOf, shiftMonth, type DisabledOptions } from "./calendarGrid";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const NAV =
  "inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent max-md:h-10 max-md:w-10";

/**
 * A month of hospital days, PulseOS-styled: Sunday-first, blue selection, soft range band, today ringed, future days
 * greyed out where the domain refuses them. Pure display: the owner decides what a click means.
 */
export function PulseCalendar({
  month,
  onMonthChange,
  from,
  to,
  onPick,
  disabled,
  testIdPrefix,
}: {
  /** Displayed month, `YYYY-MM`. */
  month: string;
  onMonthChange: (month: string) => void;
  /** Selected day (single mode: just `from`) or range ends. */
  from: string | undefined;
  to: string | undefined;
  onPick: (day: string) => void;
  disabled: DisabledOptions;
  testIdPrefix: string;
}) {
  const grid = monthGrid(month);
  const { today, allowFuture } = disabled;
  const nextBlocked = !allowFuture && shiftMonth(month, 1) > monthOf(today);
  const rangeEnd = to ?? from;

  return (
    <div data-testid={`${testIdPrefix}-calendar`} data-month={month}>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" className={NAV} onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Previous month" data-testid={`${testIdPrefix}-prev-month`}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <p className="text-sm font-semibold tracking-tight text-ink" aria-live="polite" data-testid={`${testIdPrefix}-month-title`}>
          {formatKey(`${month}-01`, { month: "long", year: "numeric" })}
        </p>
        <button type="button" className={NAV} onClick={() => onMonthChange(shiftMonth(month, 1))} disabled={nextBlocked} aria-label="Next month" data-testid={`${testIdPrefix}-next-month`}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center" role="grid" aria-label={formatKey(`${month}-01`, { month: "long", year: "numeric" })}>
        {WEEKDAYS.map((d, i) => (
          <span key={i} className="pb-1 text-[11px] font-medium text-ink-2" aria-hidden="true">
            {d}
          </span>
        ))}
        {grid.map((day) => {
          const isOff = dayDisabled(day, disabled);
          const outside = !day.startsWith(month);
          const isEnd = day === from || day === rangeEnd;
          const inBand = !!from && !!rangeEnd && day > from && day < rangeEnd;
          const isToday = day === today;
          const weekday = WEEKDAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()];
          const cls = [
            "h-9 text-xs font-medium tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-primary-500 max-md:h-10",
            isEnd ? "rounded-lg bg-primary-600 text-white shadow-sm" : inBand ? "bg-primary-100 text-primary-800" : "rounded-lg",
            !isEnd && !inBand && !isOff ? (outside ? "text-neutral-400 hover:bg-primary-50" : "text-ink hover:bg-primary-50") : "",
            isOff ? "cursor-not-allowed text-neutral-300" : "",
            isToday && !isEnd ? "font-semibold ring-1 ring-inset ring-primary-300" : "",
          ].join(" ");
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              disabled={isOff}
              onClick={() => onPick(day)}
              className={cls}
              data-day={day}
              data-testid={`${testIdPrefix}-day-${day}`}
              aria-selected={isEnd || inBand}
              aria-current={isToday ? "date" : undefined}
              aria-label={`${weekday}, ${formatKey(day, { day: "numeric", month: "long", year: "numeric" })}${isToday ? " (today)" : ""}`}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
