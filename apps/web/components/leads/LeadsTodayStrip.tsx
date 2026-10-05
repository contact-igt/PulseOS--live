"use client";

import type { LeadsTodaySummary } from "@pulseos/types";
import { MetricStrip } from "@pulseos/ui";

const CELLS: { key: keyof LeadsTodaySummary; label: string; testId: string; attention?: boolean }[] = [
  { key: "appointmentsToday", label: "Appointments today", testId: "today-appointments" },
  { key: "followUpsDue", label: "Follow-ups due", testId: "today-follow-ups" },
  { key: "overdue", label: "Overdue", testId: "today-overdue", attention: true },
  { key: "newToday", label: "New leads today", testId: "today-new" },
];

/**
 * A compact "today" strip above the list. Every value is a button that opens the matching filter, and every value is
 * the same number the opened list shows (the server counts both with one predicate). It is the shared MetricStrip (solid
 * cells clipped to one radius), so an active or hovered cell can never show a square corner outside the rounded strip.
 */
export function LeadsTodayStrip({ summary, onOpen, activeKey }: { summary: LeadsTodaySummary; onOpen: (key: keyof LeadsTodaySummary) => void; activeKey: keyof LeadsTodaySummary | null }) {
  return (
    <MetricStrip
      testId="leads-today-strip"
      ariaLabel="Today at a glance"
      layout="inline"
      activeKey={activeKey ?? undefined}
      cells={CELLS.map((c) => ({ key: c.key, label: c.label, value: summary[c.key], attention: c.attention, testId: c.testId, onClick: () => onOpen(c.key) }))}
    />
  );
}
