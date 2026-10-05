"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { DATE_PRESETS } from "@pulseos/types";
import { Search } from "lucide-react";
import {
  AppointmentList,
  Button,
  CalendarView,
  ErrorState,
  FilterBar,
  FilterSelect,
  Skeleton,
  Tabs,
  Toolbar,
  ViewSwitcher,
  formatKey,
} from "@pulseos/ui";
import { useQuickCreate } from "../../../components/shell/QuickCreateProvider";
import { useViewState } from "@/lib/useViewState";
import { APPOINTMENT_RANGE_DAYS, APPOINTMENT_VIEWS, DEFAULT_LIST_PERIOD, LIST_TABS, appointmentQuery, matchesSearch, toCalendarEvent } from "@/components/appointments/appointmentViews";
import type { AppointmentView, ListTab } from "@/components/appointments/appointmentViews";
import { useCalendarContext } from "@/components/appointments/hooks";
import { useAppointmentWorkflow } from "@/components/appointments/AppointmentWorkflow";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { periodPatch, readPeriod } from "@/components/filters/periodFilter";
import { DoctorScheduleView } from "@/components/appointments/DoctorScheduleView";
import { InlineNotice } from "@/components/appointments/InlineNotice";
import { renderAppointmentEvent } from "@/components/appointments/AppointmentEventBody";

// The appointments API serves at most APPOINTMENT_RANGE_DAYS at a time, so the 90-day preset is not offered here.
const LIST_PERIOD_PRESETS = DATE_PRESETS.filter((p) => p.key !== "90d");
// Tabs whose rows are a history: they cover a chosen period instead of every appointment ever.
const PERIOD_TABS: readonly ListTab[] = ["no_show", "completed"];

const TAB_LABEL: Record<ListTab, string> = { today: "Today", upcoming: "Upcoming", no_show: "No-shows", completed: "Completed" };

// Text-only segments so all five fit a 390px phone without scrolling.
const VIEW_OPTIONS: { key: AppointmentView; label: string; controls: string }[] = [
  { key: "list", label: "List", controls: "appointments-view-panel" },
  { key: "day", label: "Day", controls: "appointments-view-panel" },
  { key: "week", label: "Week", controls: "appointments-view-panel" },
  { key: "month", label: "Month", controls: "appointments-view-panel" },
  { key: "doctors", label: "Doctors", controls: "appointments-view-panel" },
];

export default function AppointmentsPage() {
  const quickCreate = useQuickCreate();
  const { timeZone, today } = useCalendarContext();
  const { view, date, setView, setDate, setState: setViewState } = useViewState<AppointmentView>({ views: APPOINTMENT_VIEWS, defaultView: "list", timeZone });
  const filters = useUrlFilters();
  const rawTab = filters.get("tab");
  const tab: ListTab = LIST_TABS.find((t) => t === rawTab) ?? "today";
  const params = useSearchParams();
  const periodOptions = { prefix: "p", defaultRange: DEFAULT_LIST_PERIOD, presets: LIST_PERIOD_PRESETS, today } as const;
  const period = useMemo(() => readPeriod(new URLSearchParams(params.toString()), periodOptions), [params, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const branchId = filters.get("branch");
  const doctorId = filters.get("doctor");
  const [search, setSearch] = useState(() => filters.get("q"));
  // The drawer, its reasons and the "What happens next?" completion sheet — shared with Front Desk and the Journey.
  const workflow = useAppointmentWorkflow();
  const { select: setSelected, canManage } = workflow;

  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });

  // One query for every view: same endpoint, same filters; only the day range follows the view + ?date.
  const query = appointmentQuery({ view, tab, date, branchId, doctorId, today, period: { from: period.from, to: period.to } });
  const appointments = useQuery({
    queryKey: ["appointments", query],
    queryFn: () => api.appointmentsInRange(query),
  });

  const rows = useMemo(() => appointments.data ?? [], [appointments.data]);
  const visibleRows = useMemo(() => {
    const byTab =
      view === "list" && tab === "upcoming"
        ? rows.filter((r) => new Date(r.scheduledAt) > new Date() && r.status !== "completed" && r.status !== "cancelled")
        : rows;
    return byTab.filter((r) => matchesSearch(r, search));
  }, [rows, view, tab, search]);
  const events = useMemo(() => visibleRows.map(toCalendarEvent), [visibleRows]);

  const dayLabel = date === today ? "Today" : formatKey(date, { weekday: "short", day: "numeric", month: "short" });
  const tabLabel = (t: ListTab) => (t === "today" ? dayLabel : TAB_LABEL[t]);
  const showPeriod = view === "list" && PERIOD_TABS.includes(tab);
  const periodText = period.from === period.to ? formatKey(period.from, { day: "numeric", month: "short" }) : `${formatKey(period.from, { day: "numeric", month: "short" })} – ${formatKey(period.to, { day: "numeric", month: "short" })}`;

  return (
    <div className="mx-auto max-w-6xl space-y-3" data-testid="appointments-page">
      <Toolbar
        actions={
          canManage && (
            <Button variant="primary" onClick={() => quickCreate.openNewAppointment()} data-testid="new-appointment-button">
              + New Appointment
            </Button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="max-w-full overflow-x-auto">
            <ViewSwitcher ariaLabel="Appointments view" value={view} onChange={(v) => setView(v)} options={VIEW_OPTIONS} />
          </div>
          {view === "list" && (
            <Tabs
              ariaLabel="Appointment list"
              items={LIST_TABS.map((t) => ({ key: t, label: tabLabel(t), testId: `appointments-tab-${t}` }))}
              value={tab}
              onChange={(k) => filters.set({ tab: k === "today" ? undefined : k })}
            />
          )}
          <FilterBar>
            {showPeriod && (
              <PeriodControls
                presets={LIST_PERIOD_PRESETS}
                value={{ range: period.range, from: period.from, to: period.to }}
                today={today}
                maxSpanDays={APPOINTMENT_RANGE_DAYS}
                onChange={(next) => filters.set(periodPatch(next, periodOptions))}
                testIdPrefix="appointments-period"
                label="Period"
              />
            )}
            {(lookups.data?.branches.length ?? 0) > 1 && (
            <FilterSelect value={branchId} onChange={(e) => filters.set({ branch: e.target.value })} aria-label="Branch">
              <option value="">All branches</option>
              {lookups.data?.branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </FilterSelect>
            )}
            {(lookups.data?.doctors.length ?? 0) > 1 && (
            <FilterSelect value={doctorId} onChange={(e) => filters.set({ doctor: e.target.value })} aria-label="Doctor">
              <option value="">All doctors</option>
              {lookups.data?.doctors.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </FilterSelect>
            )}
            <label className="glass-control relative flex h-8 min-w-0 flex-1 items-center rounded-control sm:w-48 sm:flex-none">
              <Search size={14} className="pointer-events-none absolute left-2.5 text-neutral-500" aria-hidden="true" />
              <input
                type="text"
                placeholder="Search patients…"
                aria-label="Search patients"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  filters.set({ q: e.target.value.trim() ? e.target.value : undefined });
                }}
                className="h-full w-full bg-transparent pl-8 pr-2.5 text-xs text-ink outline-none placeholder:text-neutral-500"
              />
            </label>
          </FilterBar>
        </div>
      </Toolbar>

      {workflow.error && <InlineNotice message={workflow.error} onDismiss={workflow.clearError} testId="appointments-action-error" />}

      <div id="appointments-view-panel" role="tabpanel" data-testid={`appointments-view-${view}`} data-from={query.from} data-to={query.to} className="min-w-0">
        {appointments.isLoading ? (
          <Skeleton className="h-64" />
        ) : appointments.isError ? (
          <ErrorState message="Could not load appointments." />
        ) : view === "list" ? (
          <AppointmentList
            title={showPeriod ? `${tabLabel(tab)} · ${periodText}` : tab === "upcoming" ? `${tabLabel(tab)} · next ${APPOINTMENT_RANGE_DAYS} days` : tabLabel(tab)}
            rows={visibleRows}
            onAction={canManage ? workflow.handleAction : undefined}
            onComplete={canManage ? workflow.handleComplete : undefined}
            onRowClick={(row) => setSelected(row)}
            showBranch={(lookups.data?.branches.length ?? 0) > 1}
            showDoctor={(lookups.data?.doctors.length ?? 0) > 1}
            showDate={tab !== "today"}
            emptyMessage="No appointments match these filters."
          />
        ) : view === "doctors" ? (
          <DoctorScheduleView rows={visibleRows} date={date} today={today} timeZone={timeZone} clinicHours={lookups.data?.clinicHours ?? null} onDateChange={setDate} onSelect={setSelected} />
        ) : (
          <CalendarView
            events={events}
            mode={view}
            date={date}
            onDateChange={setDate}
            onOpenDay={(day) => setViewState({ view: "day", date: day })}
            timeZone={timeZone}
            onEventClick={(e) => e.data && setSelected(e.data)}
            renderEvent={renderAppointmentEvent}
            ariaLabel="Appointments calendar"
            emptyMessage="No appointments in this period."
          />
        )}
      </div>

      {workflow.element}
    </div>
  );
}
