"use client";

import { useMemo } from "react";
import { CalendarView, type CalendarEvent, type CalendarMode } from "@pulseos/ui";
import type { TaskRow } from "@pulseos/types";
import type { ViewRange } from "@/lib/useViewState";
import { dueBucket } from "./taskBuckets";

/**
 * My Work by due date. Point events at each task's due instant, bucketed on
 * the hospital's calendar day. Below 640px the primitive shows its Agenda.
 */
export function TaskCalendar({
  tasks,
  now,
  timeZone,
  date,
  range,
  mode,
  onDateChange,
  onModeChange,
  onOpen,
}: {
  tasks: TaskRow[];
  now: Date;
  timeZone: string;
  date: string;
  range: ViewRange;
  mode: CalendarMode;
  onDateChange: (d: string) => void;
  onModeChange: (m: CalendarMode) => void;
  onOpen: (task: TaskRow) => void;
}) {
  const events = useMemo<CalendarEvent<TaskRow>[]>(
    () =>
      tasks.map((t) => {
        const bucket = dueBucket(t, now, timeZone);
        return {
          id: t.id,
          start: t.dueAt,
          title: t.patientName,
          subtitle: `${t.typeLabel}${t.journeyType ? ` · ${t.journeyType}` : ""}`,
          status: bucket === "overdue" ? "Overdue" : t.status === "completed" ? "Completed" : t.status === "cancelled" ? "Cancelled" : undefined,
          state: t.status === "completed" ? "completed" : t.status === "cancelled" ? "cancelled" : "default",
          tone: bucket === "overdue" ? "warning" : bucket === "done" ? "neutral" : "primary",
          data: t,
        };
      }),
    [tasks, now, timeZone],
  );

  return (
    <div className="min-w-0 p-3" data-testid="my-work-calendar">
      <CalendarView<TaskRow>
        ariaLabel="Tasks by due date"
        events={events}
        mode={mode}
        date={date}
        timeZone={timeZone}
        now={now}
        onDateChange={onDateChange}
        onModeChange={onModeChange}
        agendaSpan={range}
        onEventClick={(e) => e.data && onOpen(e.data)}
        emptyMessage="No tasks due in this period."
      />
    </div>
  );
}
