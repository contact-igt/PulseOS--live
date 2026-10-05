"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { APPOINTMENT_STATUS_LABEL, APPOINTMENT_STATUS_TONE, Badge, EmptyState, Panel } from "@pulseos/ui";
import type { DoctorTodayItem } from "@pulseos/types";
import { fmtTimeInZone, groupDayParts } from "./appointmentViews";

/**
 * Doctor Home "Schedule": the doctor's own day (exactly the dashboard's `today`
 * rows) as an agenda split into Morning / Afternoon / Evening in hospital time,
 * with a "Now" marker. Presentation only - it widens nothing the doctor sees.
 */
export function DoctorDaySchedule({
  items,
  timeZone,
  dayLabel,
  highlightId,
  renderPatientLink,
}: {
  items: DoctorTodayItem[];
  timeZone: string;
  dayLabel: string;
  highlightId?: string;
  renderPatientLink: (item: DoctorTodayItem, children: ReactNode) => ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const parts = groupDayParts(items, timeZone);
  // The first appointment still ahead of the clock gets the "Now" marker above it.
  const nextUpId = items
    .filter((i) => new Date(i.time).getTime() >= now)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())[0]?.appointmentId;
  const nowLabel = fmtTimeInZone(new Date(now).toISOString(), timeZone);

  return (
    <Panel title="Today's schedule" subtitle={`${dayLabel} · ${items.length} ${items.length === 1 ? "appointment" : "appointments"}`} padded={false} data-testid="doctor-schedule">
      {items.length === 0 ? (
        <EmptyState message="No appointments on your schedule today." />
      ) : (
        <div className="divide-y divide-line">
          {parts.map((p) => (
            <section key={p.key} aria-label={`${p.label}, ${p.items.length}`} data-testid={`doctor-schedule-part-${p.key}`}>
              <h3 className="bg-surface-muted px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                {p.label} <span className="font-medium normal-case tracking-normal tabular-nums">· {p.items.length}</span>
              </h3>
              <ol className="divide-y divide-line/70">
                {p.items.map((item) => {
                  const isNext = item.appointmentId === highlightId;
                  const name = <span className={`min-w-0 break-words text-sm ${isNext ? "font-semibold text-primary-800" : "font-medium text-ink"}`}>{item.patientName}</span>;
                  return (
                    <Fragment key={item.appointmentId}>
                      {item.appointmentId === nextUpId && (
                        <li aria-label={`Now, ${nowLabel}`} className="flex items-center gap-2 px-4 py-1" data-testid="doctor-schedule-now">
                          <span className="text-[11px] font-semibold tabular-nums text-primary-700">Now · {nowLabel}</span>
                          <span aria-hidden="true" className="h-px flex-1 bg-primary-500" />
                        </li>
                      )}
                      <li
                        className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 ${isNext ? "bg-surface-info" : ""}`}
                        data-testid={`doctor-schedule-item-${item.appointmentId}`}
                      >
                        <span className="w-16 shrink-0 text-xs font-medium tabular-nums text-ink-2">{fmtTimeInZone(item.time, timeZone)}</span>
                        <span className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-2 gap-y-1">
                          {renderPatientLink(item, name)}
                          {isNext && <Badge tone="primary">Next</Badge>}
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {item.journeyType && <Badge tone="neutral">{item.journeyType}</Badge>}
                          <Badge tone={APPOINTMENT_STATUS_TONE[item.status]}>{APPOINTMENT_STATUS_LABEL[item.status]}</Badge>
                        </span>
                      </li>
                    </Fragment>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
