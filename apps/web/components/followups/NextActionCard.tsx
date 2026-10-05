"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, MessageCircle, Plus } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { APPOINTMENT_STATUS_LABEL, Badge, Button, Card, fmtSmartDateTime } from "@pulseos/ui";
import { FOLLOW_UP_KEYS, type AppointmentRow, type JourneyDetailVm, type TaskRow } from "@pulseos/types";
import { invalidateFollowUpQueries } from "./AddFollowUpSheet";
import { ReassignSheet, RescheduleSheet } from "./TaskActionSheets";
import { SendWhatsAppSheet } from "./SendWhatsAppSheet";
import { useCapability } from "@/lib/useEdition";

const BUCKET: Record<NonNullable<JourneyDetailVm["journey"]["nextTaskBucket"]>, { label: string; tone: "danger" | "primary" | "neutral" }> = {
  overdue: { label: "Overdue", tone: "danger" },
  today: { label: "Due today", tone: "primary" },
  upcoming: { label: "Upcoming", tone: "neutral" },
};

/**
 * The single most important thing to do next on this journey, straight from its open tasks (never stored): overdue
 * first, then today, then the earliest upcoming. Complete / Reschedule / Reassign use the existing task actions; when
 * the task is done the next one takes its place on the refresh. With nothing scheduled it says so and offers to add one.
 */
export function NextActionCard({ journey, canManage, onAdd, upcomingVisit = null }: { journey: JourneyDetailVm["journey"]; canManage: boolean; onAdd: () => void; /** The earliest visit still ahead: with no follow-up task, the visit IS what happens next. */ upcomingVisit?: AppointmentRow | null }) {
  const queryClient = useQueryClient();
  const task: TaskRow | null = journey.nextTask;
  const [sheet, setSheet] = useState<"reschedule" | "reassign" | "whatsapp" | null>(null);
  const canWhatsApp = useCapability("WHATSAPP_NOTIFICATIONS");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete() {
    if (!task || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.completeTask(task.id);
      invalidateFollowUpQueries(queryClient);
    } catch (err) {
      setError(err instanceof ApiError && err.message === "already_completed" ? "Someone already completed this." : "Couldn't complete it — try again.");
      invalidateFollowUpQueries(queryClient);
    } finally {
      setBusy(false);
    }
  }

  // A viewer who may not see tasks still learns when the next one is due, never its notes or owner.
  if (!task && journey.nextAction) {
    return (
      <Card className="p-4" data-testid="next-action">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Next action</p>
        <p className="mt-1 text-sm font-semibold text-ink">{journey.nextAction.label}</p>
        <p className="text-xs text-ink-2">Due {fmtSmartDateTime(journey.nextAction.dueAt)}</p>
      </Card>
    );
  }

  if (!task && upcomingVisit) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="next-action">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Next action</p>
          <p className="mt-1 text-sm font-semibold text-ink" data-testid="next-action-visit">Patient visit · {fmtSmartDateTime(upcomingVisit.scheduledAt)}</p>
          <p className="text-xs text-ink-2">{APPOINTMENT_STATUS_LABEL[upcomingVisit.status]}{upcomingVisit.doctorName ? ` · ${upcomingVisit.doctorName}` : ""}</p>
        </div>
        {canManage && (
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onAdd} data-testid="next-action-add">
            <Plus size={14} aria-hidden="true" /> Add follow-up
          </Button>
        )}
      </Card>
    );
  }

  if (!task) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="next-action">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Next action</p>
          <p className="mt-1 text-sm font-semibold text-ink" data-testid="next-action-empty">No follow-up scheduled</p>
          <p className="text-xs text-ink-2">Add one so this enquiry isn&apos;t forgotten.</p>
        </div>
        {canManage && (
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onAdd} data-testid="next-action-add">
            <Plus size={14} aria-hidden="true" /> Add follow-up
          </Button>
        )}
      </Card>
    );
  }

  const bucket = journey.nextTaskBucket ? BUCKET[journey.nextTaskBucket] : null;
  const isRisk = task.followUpTypeKey === FOLLOW_UP_KEYS.appointmentRisk;
  const ownersDiffer = !!task.assignedTo && !!journey.owner && task.assignedTo !== journey.owner.id;

  return (
    <Card className="space-y-3 p-4" data-testid="next-action">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Next action</p>
        <div className="flex items-center gap-1.5">
          {task.priority === "high" && <Badge tone="warning">High priority</Badge>}
          {bucket && <Badge tone={bucket.tone}>{bucket.label}</Badge>}
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-base font-semibold tracking-tight text-ink" data-testid="next-action-type">{task.typeLabel}</p>
          {isRisk && <Badge tone="primary">Needs attention</Badge>}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-2">
          <CalendarClock size={13} aria-hidden="true" />
          <span className="font-medium text-ink" data-testid="next-action-due">{fmtSmartDateTime(task.dueAt)}</span>
          <span>·</span>
          <span data-testid="next-action-owner">{task.assignedToName ?? "Unassigned"}</span>
          {ownersDiffer && journey.owner && <span data-testid="next-action-journey-owner">· journey team member {journey.owner.name}</span>}
        </p>
        {task.notes && <p className="mt-1.5 line-clamp-2 break-words text-xs leading-5 text-ink" data-testid="next-action-note">{task.notes}</p>}
      </div>

      {error && (
        <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/60 px-2.5 py-1.5 text-xs text-danger-700" data-testid="next-action-error">
          {error}
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="primary" size="sm" className="min-h-11 sm:min-h-0" onClick={complete} disabled={busy} data-testid="next-action-complete">
            {busy ? "Completing…" : "Complete"}
          </Button>
          <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-0" onClick={() => setSheet("reschedule")} disabled={busy} data-testid="next-action-reschedule">
            Reschedule
          </Button>
          <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-0" onClick={() => setSheet("reassign")} disabled={busy} data-testid="next-action-reassign">
            Reassign Team Member
          </Button>
          {canWhatsApp && (
            <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-0" onClick={() => setSheet("whatsapp")} disabled={busy} data-testid="next-action-whatsapp">
              <MessageCircle size={14} aria-hidden="true" /> Send WhatsApp
            </Button>
          )}
        </div>
      )}

      {sheet === "reschedule" && <RescheduleSheet task={task} onClose={() => setSheet(null)} />}
      {sheet === "reassign" && <ReassignSheet task={task} onClose={() => setSheet(null)} />}
      {sheet === "whatsapp" && <SendWhatsAppSheet journeyId={journey.id} onClose={() => setSheet(null)} />}
    </Card>
  );
}
