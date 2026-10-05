"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, formatKey } from "@pulseos/ui";
import { PulseDatePicker } from "./PulseDatePicker";

const STEP =
  "inline-flex h-8 w-8 items-center justify-center rounded-control border border-line-strong bg-white text-ink-2 transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-2 focus-visible:outline-primary-500 max-md:h-11 max-md:w-11";

/** "Today", "Yesterday", "Tomorrow" or the weekday — always with the date, so the selected day is never ambiguous. */
export function dayLabel(day: string, today: string): string {
  const date = formatKey(day, { weekday: "short", day: "numeric", month: "short" });
  if (day === today) return `Today · ${date}`;
  if (day === addDays(today, -1)) return `Yesterday · ${date}`;
  if (day === addDays(today, 1)) return `Tomorrow · ${date}`;
  return date;
}

/**
 * Compact day navigation for the operational "today" screens (Front Desk, Doctor Home): previous day, a calendar to jump
 * to any date, next day, and a way back to today. The day is a hospital calendar day.
 */
export function DayNavigator({ date, today, onChange, testIdPrefix }: { date: string; today: string; onChange: (day: string) => void; testIdPrefix: string }) {
  const label = dayLabel(date, today);
  return (
    <div className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label="Day" data-testid={`${testIdPrefix}-day-nav`} data-date={date}>
      <button type="button" className={STEP} onClick={() => onChange(addDays(date, -1))} aria-label="Previous day" data-testid={`${testIdPrefix}-prev-day`}>
        <ChevronLeft size={15} aria-hidden="true" />
      </button>
      <PulseDatePicker
        value={date}
        today={today}
        onChange={onChange}
        testIdPrefix={`${testIdPrefix}-date`}
        triggerLabel={`Choose a date. Showing ${label}`}
        triggerClassName="glass-control inline-flex h-8 min-w-0 items-center gap-2 rounded-control px-2.5 text-xs font-medium text-ink outline-none transition hover:border-primary-300 focus-visible:border-primary-500 data-[state=open]:border-primary-500 max-md:h-11 max-md:text-sm"
        trigger={
          <>
            <CalendarDays size={14} className="shrink-0 text-primary-600" aria-hidden="true" />
            <span className="truncate tabular-nums" data-testid={`${testIdPrefix}-day-label`}>{label}</span>
          </>
        }
      />
      <button type="button" className={STEP} onClick={() => onChange(addDays(date, 1))} aria-label="Next day" data-testid={`${testIdPrefix}-next-day`}>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      {date !== today && (
        <button
          type="button"
          onClick={() => onChange(today)}
          className="inline-flex h-8 items-center rounded-control px-2.5 text-xs font-semibold text-primary-700 transition hover:bg-primary-50 max-md:h-11"
          data-testid={`${testIdPrefix}-back-to-today`}
        >
          Back to today
        </button>
      )}
    </div>
  );
}
