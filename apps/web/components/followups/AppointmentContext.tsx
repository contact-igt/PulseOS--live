"use client";

import { CalendarCheck, Plus } from "lucide-react";
import { APPOINTMENT_STATUS_LABEL, APPOINTMENT_STATUS_TONE, Badge, Button, Card, fmtSmartDateTime } from "@pulseos/ui";
import { APPOINTMENT_PRIMARY_OP, type AppointmentAction, type AppointmentRow } from "@pulseos/types";

const OPEN = new Set(["requested", "scheduled", "confirmed", "checked_in", "waiting", "with_doctor"]);

/** The next live appointment on this journey, or null. Deep detail stays in the appointment drawer. */
export function nextAppointment(appointments: AppointmentRow[], now: Date): AppointmentRow | null {
  const live = appointments.filter((a) => OPEN.has(a.status) && new Date(a.scheduledAt).getTime() >= now.getTime() - 3 * 3_600_000);
  return live.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())[0] ?? null;
}

/** The most recent consultation completed on this journey, or null. */
export function lastCompleted(appointments: AppointmentRow[]): AppointmentRow | null {
  return appointments.filter((a) => a.status === "completed").sort((a, b) => (b.completedAt ?? b.scheduledAt).localeCompare(a.completedAt ?? a.scheduledAt))[0] ?? null;
}

const SHORT: Record<string, string> = { confirm: "Confirm appointment", check_in: "Check in", mark_waiting: "Move to waiting", send_to_doctor: "Send to doctor", complete: "Consultation done" };

/**
 * One compact block of appointment context beside the Next Action: the live visit with its one next step (the same
 * step the drawer and Front Desk offer), or "Completed today", or an invitation to book. Never a full section.
 */
export function AppointmentContext({
  appointments,
  canBook,
  onBook,
  canManage = false,
  onOpen,
  onAction,
  onComplete,
}: {
  appointments: AppointmentRow[];
  canBook: boolean;
  onBook: () => void;
  canManage?: boolean;
  onOpen?: (row: AppointmentRow) => void;
  onAction?: (row: AppointmentRow, action: AppointmentAction) => void;
  onComplete?: (row: AppointmentRow) => void;
}) {
  const appt = nextAppointment(appointments, new Date());
  const done = appt ? null : lastCompleted(appointments);
  const primary = appt ? APPOINTMENT_PRIMARY_OP[appt.status] : undefined;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="appointment-context">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{appt ? (appt.status === "scheduled" || appt.status === "confirmed" || appt.status === "requested" ? "Upcoming appointment" : "Appointment today") : "Appointment"}</p>
        {appt ? (
          <>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-ink" data-testid="appointment-context-when">
              <CalendarCheck size={14} aria-hidden="true" className="text-primary-600" />
              {fmtSmartDateTime(appt.scheduledAt)}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
              <span data-testid="appointment-context-doctor">{appt.doctorName ?? "Doctor to be confirmed"}</span>
              <Badge tone={APPOINTMENT_STATUS_TONE[appt.status]}>{APPOINTMENT_STATUS_LABEL[appt.status]}</Badge>
              {appt.atRisk && <Badge tone="warning">Needs attention</Badge>}
            </p>
          </>
        ) : done ? (
          <p className="mt-1 text-sm font-semibold text-ink" data-testid="appointment-context-completed">
            Consultation completed · {fmtSmartDateTime(done.completedAt ?? done.scheduledAt)}
            <span className="mt-0.5 block text-xs font-normal text-ink-2">{done.doctorName ?? "Doctor not set"}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm font-semibold text-ink" data-testid="appointment-context-empty">No appointment booked</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {appt && canManage && primary && (
          <Button
            variant="primary"
            size="sm"
            className="min-h-11 sm:min-h-0"
            onClick={() => (primary.op === "complete" ? onComplete?.(appt) : onAction?.(appt, primary.op as AppointmentAction))}
            data-testid="appointment-context-primary"
          >
            {SHORT[primary.op] ?? primary.label}
          </Button>
        )}
        {appt && onOpen && (
          <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-0" onClick={() => onOpen(appt)} data-testid="appointment-context-open">
            Details
          </Button>
        )}
        {!appt && canBook && (
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onBook} data-testid="appointment-context-book">
            <Plus size={14} aria-hidden="true" /> Book appointment
          </Button>
        )}
      </div>
    </Card>
  );
}
