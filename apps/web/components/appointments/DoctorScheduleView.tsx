"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, EmptyState, VIEW_MOBILE_BREAKPOINT, clinicHoursOn, formatKey, shiftDate, useContainerWidth } from "@pulseos/ui";
import type { AppointmentRow, ClinicHours } from "@pulseos/types";
import { AppointmentAgendaRow } from "./AppointmentAgendaRow";
import { groupByDoctor } from "./appointmentViews";

/** What the visit is for: the service, then the reason unless it already says so ("Cataract consultation" needs no "Cataract" in front). */
function serviceLine(r: AppointmentRow): string | undefined {
  const service = r.service ?? null;
  const reason = r.reason ?? null;
  if (service && reason) return reason.toLowerCase().includes(service.toLowerCase()) ? reason : `${service} · ${reason}`;
  return service ?? reason ?? r.branchName ?? undefined;
}

const NAV_BTN = "min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/**
 * Doctor Schedule: the selected day's appointments as one column per doctor
 * (desktop), stacking into a per-doctor list below the view breakpoint. Same
 * rows as the List/Day views for that day - only grouped differently.
 */
export function DoctorScheduleView({
  rows,
  date,
  today,
  timeZone,
  clinicHours,
  onDateChange,
  onSelect,
}: {
  rows: AppointmentRow[];
  date: string;
  today: string;
  timeZone: string;
  /** The hospital's own clinic hours (Settings), so the day shows when the clinic is open - never a hardcoded schedule. */
  clinicHours?: ClinicHours | null;
  onDateChange: (date: string) => void;
  onSelect: (row: AppointmentRow) => void;
}) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const stacked = width !== null && width < VIEW_MOBILE_BREAKPOINT;
  const groups = groupByDoctor(rows);
  const open = clinicHoursOn(clinicHours, date);
  const title = formatKey(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <div ref={ref} className="min-w-0 space-y-3" data-layout={stacked ? "stacked" : "columns"} data-testid="doctor-schedule-view">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1">
          <Button variant="secondary" size="sm" aria-label="Previous day" onClick={() => onDateChange(shiftDate(date, "day", -1))} className={NAV_BTN} data-testid="doctor-schedule-prev">
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <Button variant="secondary" size="sm" aria-label="Next day" onClick={() => onDateChange(shiftDate(date, "day", 1))} className={NAV_BTN} data-testid="doctor-schedule-next">
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <Button variant="secondary" size="sm" aria-label="Go to today" onClick={() => onDateChange(today)} className="min-h-11 sm:min-h-8 pointer-coarse:min-h-11">
          Today
        </Button>
        <h2 aria-live="polite" className="min-w-0 flex-1 basis-40 text-sm font-semibold tracking-tight text-ink">
          {title}
          {date === today && <span className="ml-2 text-xs font-medium text-primary-700">Today</span>}
        </h2>
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <span className="sr-only sm:not-sr-only">Choose date</span>
          <input type="date" value={date} onChange={(e) => e.target.value && onDateChange(e.target.value)} aria-label="Choose date" className="min-h-11 rounded-control border border-line-strong bg-white px-2 text-sm text-ink sm:min-h-8" data-testid="doctor-schedule-date" />
        </label>
        <span className="text-xs text-ink-2">
          {rows.length} {rows.length === 1 ? "appointment" : "appointments"} · {groups.length} {groups.length === 1 ? "doctor" : "doctors"}
        </span>
      </div>

      {open && (
        <p className={`text-xs ${open === "closed" ? "font-medium text-warning" : "text-ink-2"}`} data-testid="doctor-schedule-hours">
          {open === "closed" ? "Clinic closed this day" : `Clinic hours ${open[0]}–${open[1]}`}
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <EmptyState message="No appointments on this day." hint="Change the day or clear the filters." />
        </div>
      ) : (
        <div className={stacked ? "space-y-3" : "grid items-start gap-3"} style={stacked ? undefined : { gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))" }}>
          {groups.map((g) => (
            <section
              key={g.doctorId}
              aria-label={`${g.doctorName}, ${g.rows.length} ${g.rows.length === 1 ? "appointment" : "appointments"}`}
              className="min-w-0 overflow-hidden rounded-card border border-line bg-surface"
              data-testid={`doctor-schedule-column-${g.doctorId}`}
            >
              <h3 className="flex items-baseline justify-between gap-2 border-b border-line bg-surface-muted px-3 py-2">
                <span className="truncate text-sm font-semibold text-ink">{g.doctorName}</span>
                <span className="shrink-0 text-xs text-ink-2">{g.rows.length}</span>
              </h3>
              <ul className="space-y-0.5 p-1.5">
                {g.rows.map((r) => (
                  <li key={r.id}>
                    <AppointmentAgendaRow row={r} timeZone={timeZone} context={serviceLine(r)} onSelect={onSelect} testId={`doctor-schedule-item-${r.id}`} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
