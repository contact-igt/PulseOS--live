"use client";

import type { ReactNode } from "react";
import { Ban, CircleCheck } from "lucide-react";
import type { CalendarEvent, EventLayout } from "@pulseos/ui";

function StateIcon({ state }: { state?: CalendarEvent["state"] }) {
  if (state === "cancelled") return <Ban size={11} aria-hidden="true" className="shrink-0 text-neutral-500" />;
  if (state === "completed") return <CircleCheck size={11} aria-hidden="true" className="shrink-0 text-accent-700" />;
  return null;
}

/**
 * Calendar event body for appointments. CalendarView's own compact block (a
 * 30-minute slot) drops the status line, leaving status as colour only; this
 * keeps the status as visible text in every layout. The button, accessible
 * label and click handling stay CalendarView's.
 */
export function renderAppointmentEvent(event: CalendarEvent, ctx: { layout: EventLayout; timeLabel: string }): ReactNode {
  const cancelled = event.state === "cancelled";
  const name = <span className={`min-w-0 flex-1 truncate font-medium ${cancelled ? "line-through" : ""}`}>{event.title}</span>;
  if (ctx.layout === "row") {
    // The agenda row already renders the time and a status badge around this body.
    return (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <StateIcon state={event.state} />
          {name}
        </span>
        {event.subtitle && <span className="truncate text-xs text-ink-2">{event.subtitle}</span>}
      </span>
    );
  }
  const time = ctx.layout === "pill" ? ctx.timeLabel.replace(" am", "a").replace(" pm", "p") : ctx.timeLabel;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <StateIcon state={event.state} />
      <span className="shrink-0 tabular-nums text-ink-2">{time}</span>
      {name}
      {/* Completed / cancelled already read from the icon (and strike-through); every other status stays as text. */}
      {event.status && event.state !== "completed" && event.state !== "cancelled" && <span className="shrink-0 text-[10px] font-medium text-ink-2">{event.status}</span>}
    </span>
  );
}
