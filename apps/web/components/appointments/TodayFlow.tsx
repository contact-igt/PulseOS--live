"use client";

import { EmptyState, Panel } from "@pulseos/ui";
import type { AppointmentRow } from "@pulseos/types";
import { AppointmentAgendaRow } from "./AppointmentAgendaRow";
import { groupTodayFlow } from "./appointmentViews";

/**
 * Front Desk "Today flow": today's appointments (the same rows as the queue's
 * Today list) as a compact, time-ordered agenda grouped by arrival state.
 * Rows open the existing appointment drawer, which holds the real actions.
 */
export function TodayFlow({ rows, timeZone, dayLabel, onSelect, filtered }: { rows: AppointmentRow[]; timeZone: string; dayLabel: string; onSelect: (row: AppointmentRow) => void; filtered: boolean }) {
  const groups = groupTodayFlow(rows);
  return (
    <Panel title="Today flow" subtitle={`${dayLabel} · ${rows.length} ${rows.length === 1 ? "appointment" : "appointments"}`} padded={false} data-testid="front-desk-flow">
      {rows.length === 0 ? (
        <EmptyState message={filtered ? "No appointments match this search." : "No appointments today."} />
      ) : (
        <div className="grid grid-cols-1 divide-y divide-line lg:grid-cols-2 lg:divide-y-0">
          {groups.map((g) => (
            <section key={g.key} aria-label={`${g.label}, ${g.rows.length}`} className="min-w-0 px-3 py-2.5 lg:border-b lg:border-line lg:odd:border-r" data-testid={`front-desk-flow-group-${g.key}`}>
              <h3 className="mb-1 flex items-baseline gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
                {g.label}
                <span className="font-medium tabular-nums normal-case tracking-normal">{g.rows.length}</span>
              </h3>
              {g.rows.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-neutral-500">None</p>
              ) : (
                <ul className="space-y-0.5">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <AppointmentAgendaRow
                        row={r}
                        timeZone={timeZone}
                        context={[r.doctorName, r.reason].filter(Boolean).join(" · ")}
                        onSelect={onSelect}
                        testId={`front-desk-flow-item-${r.id}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
