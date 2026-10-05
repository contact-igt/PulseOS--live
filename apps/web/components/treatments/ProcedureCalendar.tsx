"use client";

import { useMemo } from "react";
import { CalendarClock } from "lucide-react";
import { CalendarView } from "@pulseos/ui";
import type { CalendarMode, DayKey } from "@pulseos/ui";
import type { TreatmentRow, TreatmentStatus } from "@pulseos/types";
import { scheduledProcedures } from "./pipeline";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

/** Procedure Calendar: ONLY Scheduled treatments with a planned date, bucketed by the hospital day. */
export function ProcedureCalendar({
  rows,
  stateFilter,
  mode,
  date,
  onDateChange,
  onModeChange,
  onOpen,
}: {
  rows: TreatmentRow[];
  stateFilter: TreatmentStatus | "";
  mode: CalendarMode;
  date: DayKey;
  onDateChange: (date: DayKey) => void;
  onModeChange: (mode: CalendarMode) => void;
  onOpen: (row: TreatmentRow) => void;
}) {
  const timeZone = useHospitalTimeZone();
  const { events, undated } = useMemo(() => scheduledProcedures(rows), [rows]);
  const excludedByState = stateFilter !== "" && stateFilter !== "SCHEDULED";

  return (
    <div className="min-w-0 space-y-3">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-2" data-testid="treatment-calendar-scope">
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock size={13} aria-hidden="true" className="shrink-0" />
          Only Scheduled treatments with a planned date appear here.
        </span>
        {undated > 0 && (
          <span className="font-medium text-ink">
            {undated} scheduled treatment{undated === 1 ? " has" : "s have"} no planned date yet.
          </span>
        )}
        {excludedByState && <span className="font-medium text-ink">The State filter excludes Scheduled, so nothing can show.</span>}
      </p>
      <CalendarView<TreatmentRow>
        ariaLabel="Procedure calendar"
        events={events}
        mode={mode}
        date={date}
        onDateChange={onDateChange}
        onModeChange={onModeChange}
        timeZone={timeZone}
        agendaSpan="month"
        onEventClick={(e) => e.data && onOpen(e.data)}
        emptyMessage="No scheduled procedures in this period."
      />
    </div>
  );
}
