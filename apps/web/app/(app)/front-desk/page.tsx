"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { ListOrdered, Search, Users } from "lucide-react";
import { AppointmentList, Button, ErrorState, MetricStrip, PatientFlowBoard, Skeleton, Toolbar, ViewSwitcher, formatKey } from "@pulseos/ui";
import { useQuickCreate } from "../../../components/shell/QuickCreateProvider";
import type { AppointmentRow, PatientFlowCount } from "@pulseos/types";
import { useViewState } from "@/lib/useViewState";
import { matchesSearch } from "@/components/appointments/appointmentViews";
import { useCalendarContext } from "@/components/appointments/hooks";
import { useAppointmentWorkflow } from "@/components/appointments/AppointmentWorkflow";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { InlineNotice } from "@/components/appointments/InlineNotice";
import { TodayFlow } from "@/components/appointments/TodayFlow";
import { DayNavigator } from "@/components/filters/DayNavigator";

const FRONT_DESK_VIEWS = ["queue", "flow"] as const;
type FrontDeskView = (typeof FRONT_DESK_VIEWS)[number];
const VIEW_OPTIONS = [
  { key: "queue" as const, label: "Queue", icon: <Users size={14} />, controls: "front-desk-view-panel" },
  { key: "flow" as const, label: "Today flow", icon: <ListOrdered size={14} />, controls: "front-desk-view-panel" },
];

const FLOW_LABEL: Record<PatientFlowCount["bucket"], string> = {
  confirmed: "Confirmed",
  checked_in: "Checked in",
  waiting: "Waiting",
  with_doctor: "With doctor",
  completed: "Completed",
};

function flowBucket(a: AppointmentRow): PatientFlowCount["bucket"] | null {
  if (a.status === "scheduled" || a.status === "confirmed" || a.status === "requested") return "confirmed";
  if (a.status === "checked_in" || a.status === "waiting" || a.status === "with_doctor" || a.status === "completed") return a.status;
  return null;
}

function buildFlow(today: AppointmentRow[]): PatientFlowCount[] {
  const buckets: Record<PatientFlowCount["bucket"], number> = { confirmed: 0, checked_in: 0, waiting: 0, with_doctor: 0, completed: 0 };
  for (const a of today) {
    if (a.status === "scheduled" || a.status === "confirmed" || a.status === "requested") buckets.confirmed++;
    else if (a.status === "checked_in") buckets.checked_in++;
    else if (a.status === "waiting") buckets.waiting++;
    else if (a.status === "with_doctor") buckets.with_doctor++;
    else if (a.status === "completed") buckets.completed++;
  }
  return (Object.keys(buckets) as PatientFlowCount["bucket"][]).map((bucket) => ({ bucket, count: buckets[bucket] }));
}

export default function FrontDeskPage() {
  const quickCreate = useQuickCreate();
  const { timeZone, today: todayKey } = useCalendarContext();
  const { view, setView, date, setState: setViewState } = useViewState<FrontDeskView>({ views: FRONT_DESK_VIEWS, defaultView: "queue", timeZone });
  // Today first; staff can step to another hospital day (yesterday's no-shows, tomorrow's bookings) and always see which day it is.
  const isToday = date === todayKey;
  const urlFilters = useUrlFilters();
  const [search, setSearch] = useState(() => urlFilters.get("q"));
  // One drawer + completion sheet for every appointment on this page (and the same ones the Appointments page and Journey use).
  const workflow = useAppointmentWorkflow();
  const { select: setSelected, handleAction, handleComplete } = workflow;
  // Clicking a Patient Flow stage narrows the Today list to that stage (kept in the URL as ?stage=).
  type FlowBucket = PatientFlowCount["bucket"];
  const rawStage = urlFilters.get("stage");
  const flowFilter: FlowBucket | null = rawStage in FLOW_LABEL ? (rawStage as FlowBucket) : null;
  const setFlowFilter = (update: (cur: FlowBucket | null) => FlowBucket | null) => urlFilters.set({ stage: update(flowFilter) ?? undefined });

  const dashboard = useQuery({ queryKey: ["front-desk", date], queryFn: () => api.frontDesk({ date }) });

  const today = useMemo(() => dashboard.data?.today ?? [], [dashboard.data]);
  const filteredToday = useMemo(() => {
    const byStage = flowFilter ? today.filter((a) => flowBucket(a) === flowFilter) : today;
    return byStage.filter((a) => matchesSearch(a, search));
  }, [today, search, flowFilter]);
  // The Today flow is the same "today" rows as the queue, narrowed only by the (URL) search.
  const flowRows = useMemo(() => today.filter((a) => matchesSearch(a, search)), [today, search]);

  const kpis = useMemo(
    () => [
      { label: "Upcoming", value: today.filter((a) => a.status === "confirmed" || a.status === "scheduled" || a.status === "requested").length },
      { label: "Checked in", value: today.filter((a) => a.status === "checked_in").length },
      { label: "Waiting", value: today.filter((a) => a.status === "waiting").length },
      { label: "With doctor", value: today.filter((a) => a.status === "with_doctor").length },
      { label: "Completed", value: today.filter((a) => a.status === "completed").length },
      { label: "No-shows", value: today.filter((a) => a.status === "no_show").length },
      { label: "Needs attention", value: today.filter((a) => a.atRisk).length },
    ],
    [today],
  );

  if (dashboard.isLoading) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-7">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return <ErrorState message="Could not load the front desk view." />;
  }

  const queueCount = dashboard.data.waitingQueue.length;

  return (
    <div className="mx-auto max-w-7xl space-y-4" data-testid="front-desk-page">
      <Toolbar
        actions={
          <>
            <Button variant="secondary" onClick={() => quickCreate.openAddLead({ source: "walk_in" })} data-testid="front-desk-add-lead-button">
              + Add Lead
            </Button>
            <Button variant="primary" onClick={() => quickCreate.openNewAppointment()}>
              + New Appointment
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ViewSwitcher ariaLabel="Front desk view" value={view} onChange={(v) => setView(v)} options={VIEW_OPTIONS} />
          <DayNavigator date={date} today={todayKey} onChange={(d) => setViewState({ date: d === todayKey ? undefined : d })} testIdPrefix="front-desk" />
          <label className="glass-control relative flex h-8 w-full min-w-0 max-w-xs flex-1 items-center rounded-control">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-neutral-500" aria-hidden="true" />
            <input
              type="text"
              placeholder={isToday ? "Search today's patients…" : "Search patients…"}
              aria-label={isToday ? "Search today's patients" : "Search patients"}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                urlFilters.set({ q: e.target.value.trim() ? e.target.value : undefined });
              }}
              className="h-full w-full bg-transparent pl-8 pr-2.5 text-xs text-ink outline-none placeholder:text-neutral-500"
              data-testid="front-desk-search"
            />
          </label>
        </div>
      </Toolbar>

      {workflow.error && <InlineNotice message={workflow.error} onDismiss={workflow.clearError} testId="front-desk-action-error" />}

      <MetricStrip
        testId="front-desk-kpi-strip"
        anchorKey={queueCount > 0 ? "Waiting" : undefined}
        cells={kpis.map((k) => ({ key: k.label, label: k.label, value: k.value }))}
      />

      {/* Queue: two columns from xl. Below xl the wrappers dissolve (`contents`) and the panels stack in operational order: Waiting Queue first. */}
      {view === "flow" ? (
        <div id="front-desk-view-panel" role="tabpanel">
          <TodayFlow
            rows={flowRows}
            timeZone={timeZone}
            dayLabel={formatKey(todayKey, { weekday: "short", day: "numeric", month: "short" })}
            onSelect={setSelected}
            filtered={!!search.trim()}
          />
        </div>
      ) : (
        <div id="front-desk-view-panel" role="tabpanel" className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] xl:items-start">
          <div className="contents xl:block xl:space-y-4">
            <div className="order-2 min-w-0 xl:order-none">
              <PatientFlowBoard data={buildFlow(today)} onBucketClick={(b) => setFlowFilter((cur) => (cur === b ? null : b))} />
            </div>
            <div className="order-4 min-w-0 xl:order-none">
              <AppointmentList
                title="Pending Confirmation"
                rows={dashboard.data.pendingConfirmations}
                onAction={handleAction}
                onRowClick={(row) => setSelected(row)}
                showDoctor={false}
                emptyMessage="Nothing pending confirmation."
              />
            </div>
            <div className="order-5 min-w-0 xl:order-none">
              <AppointmentList
                title="No-show Recovery"
                rows={dashboard.data.noShows}
                onAction={handleAction}
                onRowClick={(row) => setSelected(row)}
                showDoctor={false}
                emptyMessage="No no-shows today."
              />
            </div>
          </div>

          <div className="contents xl:block xl:space-y-4">
            <div className="order-1 min-w-0 xl:order-none">
              <AppointmentList
                title="Waiting Queue"
                rows={dashboard.data.waitingQueue}
                onAction={handleAction}
                onComplete={handleComplete}
                onRowClick={(row) => setSelected(row)}
                showWait
                emptyMessage="No one waiting."
              />
            </div>
            {(dashboard.data.atRisk ?? []).length > 0 && (
              <div className="order-1 min-w-0 xl:order-none" data-testid="front-desk-at-risk">
                <AppointmentList
                  title="Needs attention"
                  subtitle="Appointments with an open Appointment Risk follow-up"
                  rows={dashboard.data.atRisk ?? []}
                  onAction={handleAction}
                  onComplete={handleComplete}
                  onRowClick={(row) => setSelected(row)}
                  showDoctor={false}
                  emptyMessage="Nothing needs attention."
                />
              </div>
            )}
            <div className="order-3 min-w-0 xl:order-none" data-testid="front-desk-today">
              <AppointmentList
                title={flowFilter ? `Today · ${FLOW_LABEL[flowFilter]}` : "Today's Appointments"}
                rows={filteredToday}
                onAction={handleAction}
                onComplete={handleComplete}
                onRowClick={(row) => setSelected(row)}
                actions={
                  flowFilter ? (
                    <button type="button" onClick={() => setFlowFilter(() => null)} className="text-xs font-medium text-primary-700 hover:underline" data-testid="front-desk-clear-stage">
                      Show all
                    </button>
                  ) : undefined
                }
                emptyMessage={flowFilter || search ? "No appointments match this view." : "No appointments today."}
              />
            </div>
          </div>
        </div>
      )}

      {workflow.element}
    </div>
  );
}
