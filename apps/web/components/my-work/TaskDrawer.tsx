"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { Badge, Button, TASK_REASON_LABEL, TASK_REASON_TONE, useDialogFocus } from "@pulseos/ui";
import type { TaskRow } from "@pulseos/types";
import { withFrom } from "@/components/shell/BackLink";
import { dueBucket, formatDueInZone } from "./taskBuckets";

const STATUS_LABEL: Record<TaskRow["status"], string> = { pending: "Open", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" };

/**
 * A task's detail (tasks have no page of their own): opened from a board card
 * or a calendar event. Offers the same real actions as the list row.
 */
export function TaskDrawer({
  task,
  timeZone,
  now,
  canManage,
  canOpenJourney,
  currentUserId,
  error,
  busy,
  onClose,
  onComplete,
  onPlusOneDay,
  onAssignToMe,
  onLogOutcome,
}: {
  task: TaskRow;
  timeZone: string;
  now: Date;
  canManage: boolean;
  canOpenJourney: boolean;
  currentUserId: string | undefined;
  error: string | undefined;
  busy: boolean;
  onClose: () => void;
  onComplete: () => void;
  onPlusOneDay: () => void;
  onAssignToMe: () => void;
  /** Opens "Log outcome" for this task (only offered when the task belongs to a journey). */
  onLogOutcome?: () => void;
}) {
  const ref = useDialogFocus<HTMLDivElement>(true, onClose);
  const bucket = dueBucket(task, now, timeZone);
  const open = task.status === "pending" || task.status === "in_progress";
  const canAct = canManage && open;

  return (
    <div className="fixed inset-0 z-(--z-sheet) flex justify-end" role="dialog" aria-modal="true" aria-label={`Task for ${task.patientName}`}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 drawer-backdrop bg-slate-900/30" />
      <div ref={ref} tabIndex={-1} className="relative flex h-full w-full max-w-md flex-col overflow-hidden drawer-panel focus:outline-none" data-testid="task-drawer">
        <div className="flex items-start justify-between gap-2 border-b border-line p-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Next Action · {task.typeLabel}</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-ink">{task.patientName}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close task" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-primary-50 hover:text-ink sm:h-8 sm:w-8">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={task.status === "completed" ? "success" : bucket === "overdue" ? "warning" : "neutral"}>{bucket === "overdue" ? "Overdue" : STATUS_LABEL[task.status]}</Badge>
            <Badge tone={TASK_REASON_TONE[task.reason]}>{TASK_REASON_LABEL[task.reason]}</Badge>
            {task.priority === "high" && <Badge tone="warning">High priority</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Due</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-ink">{formatDueInZone(task.dueAt, timeZone)}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Assigned Team Member</dt>
              <dd className="mt-0.5 font-medium text-ink">{task.assignedToName ?? "Unassigned"}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Journey</dt>
              <dd className="mt-0.5">
                {task.journeyId && canOpenJourney ? (
                  <Link href={withFrom(`/journeys/${task.journeyId}`, "my-work")} className="font-medium text-primary-700 hover:underline">
                    {task.journeyType ?? "Journey"}
                  </Link>
                ) : (
                  <span className="text-ink">{task.journeyType ?? "No journey"}</span>
                )}
              </dd>
            </div>
          </dl>
          {task.notes && <p className="rounded-control border border-line bg-surface-muted px-3 py-2 text-xs text-ink">{task.notes}</p>}
          <Link href={withFrom(`/patients/${task.patientId}`, "my-work")} className="inline-block text-xs font-medium text-primary-700 hover:underline">
            Open Patient 360
          </Link>
          {error && (
            <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs font-medium text-danger-700" data-testid={`task-error-${task.id}`}>
              {error}
            </p>
          )}
        </div>

        {canAct && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
            {!task.assignedTo && currentUserId && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={onAssignToMe} data-testid={`task-assign-me-${task.id}`}>
                Assign to me
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={busy} onClick={onPlusOneDay} data-testid={`task-reschedule-${task.id}`}>
              +1 day
            </Button>
            {onLogOutcome && (
              <Button variant="primary" size="sm" disabled={busy} onClick={onLogOutcome} data-testid={`task-log-outcome-${task.id}`}>
                Log outcome
              </Button>
            )}
            <Button variant={onLogOutcome ? "secondary" : "primary"} size="sm" disabled={busy} onClick={onComplete} data-testid={`task-complete-${task.id}`}>
              Complete
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
