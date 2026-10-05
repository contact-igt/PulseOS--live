"use client";

import { useEffect, useId, useState } from "react";
import {
  APPOINTMENT_PRIMARY_OP,
  allowedAppointmentOps,
  appointmentReasonsFor,
  waitMinutes,
  type AppointmentAction,
  type AppointmentReasonCode,
  type AppointmentReasonKind,
  type AppointmentRow,
  type ClinicHours,
} from "@pulseos/types";
import { Badge, Button } from "./primitives";
import type { TimelineEventVm } from "./Timeline";
import { SideSheet } from "./SideSheet";
import { APPOINTMENT_STATUS_LABEL as STATUS_LABEL, APPOINTMENT_STATUS_TONE as STATUS_TONE } from "./status";
import { clinicHoursError, clinicHoursHint, clinicTimeBounds } from "./clinicHours";
import { fmtTime } from "./format";

const CONTROL = "h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25 sm:h-9";

/** A reason picked in the drawer; the page turns it into the API call (and converts wall time in the hospital's clock). */
export interface AppointmentReasonChoice {
  reasonCode: AppointmentReasonCode;
  note?: string;
}
export interface RescheduleChoice extends AppointmentReasonChoice {
  /** Hospital-local wall time as typed: "YYYY-MM-DD" and "HH:mm". */
  date: string;
  time: string;
}

type Panel = null | AppointmentReasonKind;

function fmtWhen(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleString("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

function ReasonFields({ kind, reason, onReason, note, onNote, error, prefix }: { kind: AppointmentReasonKind; reason: string; onReason: (v: string) => void; note: string; onNote: (v: string) => void; error: string | null; prefix: string }) {
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const noteId = `${uid}-note`;
  const errId = `${uid}-err`;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={reasonId} className="block text-xs font-medium text-ink">Reason</label>
        <select id={reasonId} className={CONTROL} value={reason} onChange={(e) => onReason(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} data-testid={`${prefix}-reason`}>
          <option value="">Choose a reason…</option>
          {appointmentReasonsFor(kind).map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={noteId} className="block text-xs font-medium text-ink">Note <span className="font-normal text-ink-2">(optional)</span></label>
        <textarea id={noteId} className={`${CONTROL} h-20! py-2`} maxLength={500} value={note} onChange={(e) => onNote(e.target.value)} data-testid={`${prefix}-note`} />
      </div>
      {error && <p id={errId} role="alert" className="text-xs text-danger-700" data-testid={`${prefix}-error`}>{error}</p>}
    </div>
  );
}

/**
 * One appointment: who, when, with whom, why, where it stands — and the one obvious next step. The offered steps come
 * from the shared transition graph (the same table the API enforces), so a button only appears for a step the server
 * will accept. Rescheduling, cancelling and a no-show ask for a reason in place; nothing else needs one.
 */
export function AppointmentDrawer({
  appointment,
  recentEvents,
  onClose,
  onAction,
  onComplete,
  onReschedule,
  readOnly = false,
  error = null,
  timeZone,
  clinicHours,
}: {
  appointment: AppointmentRow | null;
  recentEvents?: TimelineEventVm[];
  onClose: () => void;
  onAction: (row: AppointmentRow, action: AppointmentAction, reason?: AppointmentReasonChoice) => void;
  /** Opens the completion step ("What happens next?"). */
  onComplete: (row: AppointmentRow) => void;
  onReschedule: (row: AppointmentRow, choice: RescheduleChoice) => void;
  /** Hide every operation for a viewer who can't call them (e.g. Doctor, VIEW_APPOINTMENTS only). */
  readOnly?: boolean;
  /** A failed action that left the drawer open (e.g. network error) — shown beside the actions; typed input is kept. */
  error?: string | null;
  /** The hospital's IANA zone, so times read the same wherever the laptop is. */
  timeZone?: string;
  /** The hospital's weekly hours (Lookups.clinicHours). Null/absent = no restriction. */
  clinicHours?: ClinicHours | null;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setPanel(null);
    setDate("");
    setTime("");
    setReason("");
    setNote("");
    setFormError(null);
  }, [appointment?.id]);
  // The waiting minutes follow the clock — derived from timestamps, never stored.
  useEffect(() => {
    if (!appointment) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [appointment]);

  if (!appointment) return null;
  const row = appointment;
  const allowed = allowedAppointmentOps(row.status);
  const primary = APPOINTMENT_PRIMARY_OP[row.status];
  const waited = waitMinutes(row, new Date(now));
  const secondary: { op: "reschedule" | "mark_no_show" | "cancel"; label: string; testId: string; kind: AppointmentReasonKind }[] = [
    ...(allowed.includes("reschedule") ? [{ op: "reschedule" as const, label: "Reschedule", testId: "drawer-action-reschedule", kind: "reschedule" as const }] : []),
    ...(allowed.includes("mark_no_show") ? [{ op: "mark_no_show" as const, label: "Mark no-show", testId: "drawer-action-no-show", kind: "no_show" as const }] : []),
    ...(allowed.includes("cancel") ? [{ op: "cancel" as const, label: "Cancel appointment", testId: "drawer-action-cancel", kind: "cancel" as const }] : []),
  ];

  function open(kind: AppointmentReasonKind) {
    setPanel(kind);
    setReason(kind === "no_show" ? "patient_no_show" : "");
    setNote("");
    setFormError(null);
  }

  function submit() {
    if (panel === "reschedule") {
      if (!date || !time) return setFormError("Choose the new date and time.");
      const hoursError = clinicHoursError(clinicHours, date, time);
      if (hoursError) return setFormError(hoursError);
      if (!reason) return setFormError("Choose why it is being rescheduled.");
      return onReschedule(row, { date, time, reasonCode: reason as AppointmentReasonCode, ...(note.trim() ? { note: note.trim() } : {}) });
    }
    if (!reason) return setFormError(panel === "cancel" ? "Choose why it is being cancelled." : "Choose a reason.");
    onAction(row, panel === "cancel" ? "cancel" : "mark_no_show", { reasonCode: reason as AppointmentReasonCode, ...(note.trim() ? { note: note.trim() } : {}) });
  }

  const stamps = [
    row.checkedInAt ? `Checked in ${fmtClock(row.checkedInAt, timeZone)}` : null,
    row.consultationStartedAt ? `With doctor ${fmtClock(row.consultationStartedAt, timeZone)}` : null,
    row.completedAt ? `Consultation completed ${fmtClock(row.completedAt, timeZone)}` : null,
  ].filter(Boolean);

  const panelTitle = panel === "reschedule" ? "Reschedule appointment" : panel === "cancel" ? "Cancel appointment" : "Mark as no-show";
  const panelConfirm = panel === "reschedule" ? "Save new time" : panel === "cancel" ? "Cancel appointment" : "Mark no-show";

  return (
    <SideSheet
      title={row.patientName}
      subtitle={[row.service, row.reason].filter(Boolean).join(" · ") || "Consultation"}
      dialogLabel="Appointment details"
      onClose={onClose}
      testId="appointment-drawer"
      footer={
        readOnly ? undefined : (
          <div className="w-full space-y-3">
            {error && (
              <p role="alert" className="rounded-control bg-danger-100 px-2.5 py-1.5 text-xs text-danger-700" data-testid="appointment-drawer-error">
                {error}
              </p>
            )}
            {panel ? (
              <div className="space-y-3" role="group" aria-label={panelTitle} data-testid="appointment-drawer-panel">
                <p className="text-sm font-semibold text-ink">{panelTitle}</p>
                {panel === "reschedule" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label htmlFor="appt-resched-date" className="block text-xs font-medium text-ink">New date</label>
                      <input id="appt-resched-date" type="date" className={CONTROL} value={date} onChange={(e) => setDate(e.target.value)} data-testid="drawer-reschedule-date" />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="appt-resched-time" className="block text-xs font-medium text-ink">New time</label>
                      <input id="appt-resched-time" type="time" className={CONTROL} value={time} onChange={(e) => setTime(e.target.value)} min={clinicTimeBounds(clinicHours, date)?.min} max={clinicTimeBounds(clinicHours, date)?.max} data-testid="drawer-reschedule-time" />
                    </div>
                  </div>
                )}
                <ReasonFields kind={panel} reason={reason} onReason={setReason} note={note} onNote={setNote} error={formError} prefix="drawer-reason" />
                {panel === "cancel" && <p className="text-[11px] leading-snug text-ink-2">This frees {fmtWhen(row.scheduledAt, timeZone)} on {row.doctorName ? `${row.doctorName}’s` : "the doctor’s"} schedule. PulseOS does not notify the patient automatically — let them know separately if they haven’t already.</p>}
                {panel === "reschedule" && <p className="text-[11px] leading-snug text-ink-2" data-testid="drawer-reschedule-hint">Times are in the hospital’s clock.{clinicHoursHint(clinicHours) ? ` ${clinicHoursHint(clinicHours)}.` : ""}</p>}
                <div className="flex gap-2">
                  <Button variant={panel === "reschedule" ? "primary" : "danger"} className="min-h-11 flex-1 sm:min-h-0" onClick={submit} data-testid="drawer-reason-confirm">
                    {panelConfirm}
                  </Button>
                  <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={() => setPanel(null)} data-testid="drawer-reason-back">
                    {panel === "cancel" ? "Keep appointment" : "Back"}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {primary && (
                  <Button
                    variant="primary"
                    className="min-h-11 w-full sm:min-h-10"
                    onClick={() => (primary.op === "complete" ? onComplete(row) : onAction(row, primary.op as AppointmentAction))}
                    data-testid={primary.op === "complete" ? "drawer-action-complete" : `drawer-action-${primary.op}`}
                  >
                    {primary.label}
                  </Button>
                )}
                {/* The "scheduled" step offers Confirm too, quietly, beside the other secondary steps. */}
                {(secondary.length > 0 || allowed.includes("confirm")) && (
                  <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1" data-testid="drawer-secondary-actions">
                    {allowed.includes("confirm") && primary?.op !== "confirm" && (
                      <button type="button" onClick={() => onAction(row, "confirm")} className="inline-flex min-h-11 items-center rounded-control px-3 text-xs font-medium text-primary-700 hover:bg-primary-50 sm:min-h-8" data-testid="drawer-action-confirm">
                        Confirm
                      </button>
                    )}
                    {secondary.map((s) => (
                      <button
                        key={s.op}
                        type="button"
                        onClick={() => open(s.kind)}
                        className={`inline-flex min-h-11 items-center rounded-control px-3 text-xs font-medium hover:bg-primary-50 sm:min-h-8 ${s.op === "reschedule" ? "text-primary-700" : "text-ink-2 hover:text-danger-700"}`}
                        data-testid={s.testId}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
          {waited !== null && <span className="text-xs font-medium tabular-nums text-ink" data-testid="appointment-drawer-wait">Waiting {waited} min</span>}
          {row.atRisk && <Badge tone="warning">Needs attention</Badge>}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">Appointment</h3>
          <dl className="space-y-1.5 text-sm" data-testid="appointment-drawer-details">
            <Row label="Patient"><a href={`/patients/${row.patientId}`} className="text-primary-700 hover:underline">{row.patientName}</a></Row>
            <Row label="Service">{row.service ?? "—"}</Row>
            <Row label="Doctor">{row.doctorName ?? "—"}</Row>
            <Row label="Branch">{row.branchName ?? "—"}</Row>
            <Row label="Date">{new Date(row.scheduledAt).toLocaleDateString("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" })}</Row>
            <Row label="Time">{new Date(row.scheduledAt).toLocaleTimeString("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })}</Row>
            <Row label="Status">{STATUS_LABEL[row.status]}</Row>
            {row.bookedBy && <Row label="Booked by">{row.bookedBy}</Row>}
            {row.statusReason && <Row label="Reason">{row.statusReason.label}{row.statusReason.note ? ` · ${row.statusReason.note}` : ""}</Row>}
          </dl>
          {stamps.length > 0 && <p className="mt-2 text-xs text-ink-2" data-testid="appointment-drawer-stamps">{stamps.join(" · ")}</p>}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">Recent activity</h3>
          {!recentEvents || recentEvents.length === 0 ? (
            <p className="text-xs text-ink-2">No recent activity on this journey.</p>
          ) : (
            <ol className="space-y-2.5 border-l border-line pl-3">
              {recentEvents.slice(-8).reverse().map((e) => (
                <li key={e.id}>
                  <p className="text-xs text-ink">{e.title}</p>
                  <p className="text-[11px] text-ink-2">{fmtTime(e.occurredAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </div>

        <a href={`/journeys/${row.journeyId}`} className="inline-block text-xs font-medium text-primary-700 hover:underline">
          Open journey →
        </a>
      </div>
    </SideSheet>
  );
}

function fmtClock(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}
