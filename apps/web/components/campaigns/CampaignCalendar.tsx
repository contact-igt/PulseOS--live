"use client";

import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { Badge, CalendarView, addDays, formatKey, shiftDate, visibleRange } from "@pulseos/ui";
import type { CalendarMode, DayKey } from "@pulseos/ui";
import type { CampaignViewRow } from "@pulseos/types";
import { SOURCE_LABEL, campaignCalendarEvents, isOngoing, runLabel, runStatusLabel, runningDuring } from "./runs";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

/** Inclusive hospital-day period the calendar is showing (the month itself, not its grey spill-over days). */
export function periodOf(mode: CalendarMode, date: DayKey): { from: DayKey; to: DayKey; label: string } {
  if (mode === "day") return { from: date, to: date, label: formatKey(date, { day: "numeric", month: "short", year: "numeric" }) };
  if (mode === "week") {
    const r = visibleRange("week", date);
    const short = (key: DayKey) => formatKey(key, { day: "numeric", month: "short" });
    return { ...r, label: `${short(r.from)} – ${short(r.to)}` };
  }
  const from = `${date.slice(0, 7)}-01`;
  return { from, to: addDays(shiftDate(from, "month", 1), -1), label: formatKey(from, { month: "long", year: "numeric" }) };
}

/**
 * Campaign Calendar. Ended campaigns span their real start..end; an ongoing
 * campaign (no end date) is a point on its start day marked "Ongoing" — its end
 * is never invented. The "Running" list above covers every campaign live in the
 * visible period, including ongoing ones that started earlier.
 */
export function CampaignCalendar({
  rows,
  mode,
  date,
  onDateChange,
  onModeChange,
  onOpen,
}: {
  rows: CampaignViewRow[];
  mode: CalendarMode;
  date: DayKey;
  onDateChange: (date: DayKey) => void;
  onModeChange: (mode: CalendarMode) => void;
  onOpen: (row: CampaignViewRow) => void;
}) {
  const timeZone = useHospitalTimeZone();
  const events = useMemo(() => campaignCalendarEvents(rows, timeZone), [rows, timeZone]);
  const period = periodOf(mode, date);
  const running = useMemo(() => runningDuring(rows, period.from, period.to, timeZone), [rows, period.from, period.to, timeZone]);

  return (
    <div className="min-w-0 space-y-3 p-4">
      <section aria-label={`Campaigns running ${period.label}`} data-testid="campaign-running">
        <h3 className="mb-1.5 text-xs font-semibold text-ink">
          Running {mode === "week" ? period.label : `in ${period.label}`} <span className="font-normal text-ink-2">· {running.length}</span>
        </h3>
        {running.length === 0 ? (
          <p className="text-xs text-ink-2">No campaigns running in this period.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {running.map((r) => (
              <li key={r.campaignId} className="min-w-0 max-w-full">
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  data-testid={`campaign-running-${r.campaignId}`}
                  aria-label={`${r.campaignName}, ${SOURCE_LABEL[r.source] ?? r.source}, runs ${runLabel(r, timeZone)}`}
                  className="flex min-h-11 max-w-full items-center gap-2 rounded-control border border-line bg-white px-2.5 py-1 text-left text-xs transition hover:border-primary-300 hover:bg-primary-50 sm:min-h-8"
                >
                  <span className="min-w-0 truncate font-medium text-ink">{r.campaignName}</span>
                  <span className="shrink-0 tabular-nums text-ink-2">{runLabel(r, timeZone)}</span>
                  {!isOngoing(r) && <Badge tone="neutral">{runStatusLabel(r)}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-[11px] text-ink-2">Ended campaigns span their run; ongoing campaigns (no end date) show on their start day.</p>

      <CalendarView<CampaignViewRow>
        ariaLabel="Campaign calendar"
        events={events}
        mode={mode}
        date={date}
        onDateChange={onDateChange}
        onModeChange={onModeChange}
        timeZone={timeZone}
        agendaSpan="month"
        onEventClick={(e) => e.data && onOpen(e.data)}
        emptyMessage="No campaign starts or runs in this period."
        renderEvent={(e, { layout }) => {
          const ongoing = e.data ? isOngoing(e.data) : false;
          const marker = ongoing ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-primary-700">
              Ongoing <ArrowRight size={10} aria-hidden="true" />
            </span>
          ) : null;
          if (layout === "row") {
            return (
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{e.title}</span>
                {e.subtitle && <span className="truncate text-xs text-ink-2">{e.subtitle}</span>}
              </span>
            );
          }
          return (
            <span className={`flex min-w-0 ${layout === "block" ? "flex-col gap-px" : "items-center gap-1"}`}>
              <span className="min-w-0 truncate font-medium">{e.title}</span>
              {marker}
            </span>
          );
        }}
      />
    </div>
  );
}
