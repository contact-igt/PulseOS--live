"use client";

import { Info } from "lucide-react";
import { Badge, KanbanBoard } from "@pulseos/ui";
import type { TaskRow } from "@pulseos/types";
import { allowedBucketMoves, dueBucket, formatDueInZone, type DueBucket } from "./taskBuckets";

const COLUMNS: { key: DueBucket; title: string; hint: string }[] = [
  { key: "overdue", title: "Overdue", hint: "Past due, still open" },
  { key: "today", title: "Today", hint: "Due later today" },
  { key: "upcoming", title: "Upcoming", hint: "Due tomorrow or later" },
  { key: "done", title: "Done", hint: "Completed or cancelled" },
];

/**
 * My Work as columns by due bucket (hospital-local days). A move is only
 * offered where it maps to a real endpoint - Today / Upcoming reschedule the
 * task, Done completes it - and only for MANAGE_TASKS callers. The board
 * rolls a card back with an inline error if the server rejects the move.
 */
export function TaskBoard({
  tasks,
  now,
  timeZone,
  canManage,
  onOpen,
  onMove,
}: {
  tasks: TaskRow[];
  now: Date;
  timeZone: string;
  canManage: boolean;
  onOpen: (task: TaskRow) => void;
  onMove: (task: TaskRow, to: DueBucket) => Promise<void>;
}) {
  return (
    <div className="min-w-0 space-y-2 p-3" data-testid="my-work-board">
      <p className="flex items-center gap-1.5 px-1 text-xs text-ink-2" data-testid="my-work-board-hint">
        <Info size={13} aria-hidden="true" className="shrink-0" />
        {canManage ? "Move a card to Today or Upcoming to reschedule it, or to Done to complete it." : "Read-only view. You can open tasks but not change them."}
      </p>
      <KanbanBoard
        ariaLabel="Tasks by due date"
        columns={COLUMNS}
        cards={tasks}
        getCardId={(t) => t.id}
        getColumnKey={(t) => dueBucket(t, now, timeZone)}
        getCardLabel={(t) => `${t.patientName}, ${t.typeLabel}`}
        onCardClick={onOpen}
        getAllowedMoves={canManage ? (t) => allowedBucketMoves(t, true, now, timeZone) : undefined}
        onMove={canManage ? (t, to) => onMove(t, to as DueBucket) : undefined}
        emptyColumnMessage="Nothing here"
        renderCard={(t) => {
          const overdue = dueBucket(t, now, timeZone) === "overdue";
          return (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-semibold text-ink">{t.patientName}</span>
              <span className="truncate text-xs text-ink-2">
                {t.typeLabel}
                {t.journeyType ? ` · ${t.journeyType}` : ""}
              </span>
              <span className={`flex items-center gap-1.5 text-[11px] tabular-nums ${overdue ? "font-medium text-danger-700" : "text-ink-2"}`}>
                {formatDueInZone(t.dueAt, timeZone)}
                {t.priority === "high" && <Badge tone="warning">High</Badge>}
              </span>
              <span className="truncate text-[11px] text-ink-2">{t.assignedToName ?? "Unassigned"}</span>
            </span>
          );
        }}
      />
    </div>
  );
}
