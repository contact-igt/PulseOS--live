"use client";

import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { allowedAppointmentOps, APPOINTMENT_PRIMARY_OP, type AppointmentAction, type AppointmentRow } from "@pulseos/types";
import { Badge, Button, EmptyState, Panel } from "./primitives";
import { Table, TableBody, TableHead, Td, Th, Tr } from "./Table";
import { APPOINTMENT_STATUS_LABEL as STATUS_LABEL, APPOINTMENT_STATUS_TONE as STATUS_TONE } from "./status";
import { fmtSmartDateTime, fmtTime } from "./format";

// The one forward step per status comes from the shared transition graph (@pulseos/types), the same table the API
// enforces, so a row only ever offers a step the server will accept. Short labels for a dense table.
const SHORT_LABEL: Record<string, string> = { confirm: "Confirm", check_in: "Check in", mark_waiting: "Move to waiting", send_to_doctor: "Send to doctor" };

/** "12 min" / "1h 05m" — whole minutes, never negative. */
export function formatWaitDuration(fromIso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Honest wait cell for a row in the waiting queue: the real check-in time when
 * the Timeline recorded one, otherwise how long past the booked slot it is
 * (labelled as such), otherwise nothing — never an invented duration.
 */
function waitCell(row: AppointmentRow, now: number): { text: string; basis: string | null; hint: string } {
  if (row.arrivedAt) {
    return { text: formatWaitDuration(row.arrivedAt, now), basis: `since ${fmtTime(row.arrivedAt)}`, hint: `Checked in at ${fmtTime(row.arrivedAt)}` };
  }
  if (new Date(row.scheduledAt).getTime() <= now) {
    return { text: formatWaitDuration(row.scheduledAt, now), basis: "past slot", hint: `Arrival time not recorded — counted from the ${fmtTime(row.scheduledAt)} slot` };
  }
  return { text: "—", basis: null, hint: "Arrival time not recorded" };
}

export function AppointmentList({
  title,
  subtitle,
  rows,
  emptyMessage = "Nothing here",
  onAction,
  onComplete,
  onRowClick,
  showDoctor = true,
  showBranch = false,
  showWait = false,
  showDate = false,
  actions,
}: {
  title: string;
  subtitle?: string;
  rows: AppointmentRow[];
  emptyMessage?: string;
  onAction?: (row: AppointmentRow, action: AppointmentAction, reason?: { reasonCode: string; note?: string }) => void;
  onComplete?: (row: AppointmentRow) => void;
  onRowClick?: (row: AppointmentRow) => void;
  showDoctor?: boolean;
  /** Adds the branch under the patient name (multi-branch tenants). */
  showBranch?: boolean;
  /** Adds a live "Wait" column (Front Desk waiting queue). */
  showWait?: boolean;
  /** Shows date + time instead of time only (lists that span several days). */
  showDate?: boolean;
  /** Optional header actions (filters, links). */
  actions?: ReactNode;
}) {
  // Ticks once a minute, and only while a wait column is on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!showWait) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [showWait]);

  const stop = (e: MouseEvent) => e.stopPropagation();
  const hasActions = !!onAction || !!onComplete;

  return (
    <Panel title={title} subtitle={subtitle ?? `${rows.length}`} action={actions} padded={false}>
      {rows.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <div className="overflow-x-auto" data-testid="appointment-list">
          <Table>
            <TableHead>
              <tr>
                {/* Below sm the Time column folds into the patient line, below md the Doctor column does too — so Status and the next step stay on screen. */}
                <Th leading className="hidden sm:table-cell">{showDate ? "When" : "Time"}</Th>
                <Th className="max-sm:pl-4">Patient</Th>
                {showDoctor && <Th className="hidden md:table-cell">Doctor</Th>}
                <Th>Status</Th>
                {showWait && <Th className="hidden sm:table-cell">Wait</Th>}
                {hasActions && <Th align="right">Next step</Th>}
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const primaryOp = APPOINTMENT_PRIMARY_OP[row.status]?.op;
                const next = primaryOp && primaryOp !== "complete" ? { action: primaryOp as AppointmentAction, label: SHORT_LABEL[primaryOp] ?? "Next" } : undefined;
                const canNoShow = allowedAppointmentOps(row.status).includes("mark_no_show");
                const wait = showWait ? waitCell(row, now) : null;
                return (
                  <Tr key={row.id} onClick={onRowClick ? () => onRowClick(row) : undefined} data-testid={`appointment-row-${row.id}`}>
                    <Td leading className="hidden tabular-nums text-ink-2 sm:table-cell">
                      {showDate ? fmtSmartDateTime(row.scheduledAt) : fmtTime(row.scheduledAt)}
                    </Td>
                    <Td nowrap={false} className="max-w-[10rem] max-sm:pl-4 max-sm:max-w-[9rem]">
                      {/* The first control in the row: opens the appointment drawer. The click bubbles to the row handler. */}
                      <button type="button" className="block max-w-full truncate text-left text-sm font-medium text-ink hover:text-primary-700 hover:underline">
                        {row.patientName}
                      </button>
                      {wait && <span className="block truncate text-[11px] font-medium tabular-nums text-ink sm:hidden">Waiting {wait.text}{wait.basis ? ` ${wait.basis}` : ""}</span>}
                      <span className="block truncate text-[11px] tabular-nums text-ink-2 sm:hidden">{showDate ? fmtSmartDateTime(row.scheduledAt) : fmtTime(row.scheduledAt)}</span>
                      {showDoctor && row.doctorName && <span className="block truncate text-[11px] text-ink-2 md:hidden">{row.doctorName}</span>}
                      {(showBranch && row.branchName) || row.reason ? (
                        <span className="block truncate text-[11px] text-ink-2">{[showBranch ? row.branchName : null, row.reason].filter(Boolean).join(" · ")}</span>
                      ) : null}
                    </Td>
                    {showDoctor && <Td className="hidden text-ink md:table-cell">{row.doctorName ?? "—"}</Td>}
                    <Td>
                      <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                      {row.atRisk && <span className="mt-0.5 block text-[11px] font-medium text-warning-700" data-testid={`appointment-risk-${row.id}`}>Needs attention</span>}
                    </Td>
                    {wait && (
                      <Td nowrap className="hidden tabular-nums text-ink sm:table-cell" title={wait.hint} data-testid={`appointment-wait-${row.id}`}>
                        {wait.text}
                        {wait.basis && <span className="block text-[11px] font-normal text-ink-2">{wait.basis}</span>}
                      </Td>
                    )}
                    {hasActions && (
                      <Td align="right" nowrap={false} className="sm:whitespace-nowrap">
                        <span className="inline-flex flex-wrap items-center justify-end gap-1.5" onClick={stop}>
                          {onAction && next && (
                            <Button size="sm" variant="secondary" className="max-sm:min-h-11" onClick={() => onAction(row, next.action)} data-testid={`appointment-action-${row.id}`}>
                              {next.label}
                            </Button>
                          )}
                          {onComplete && row.status === "with_doctor" && (
                            <Button size="sm" variant="primary" className="max-sm:min-h-11" onClick={() => onComplete(row)} data-testid={`appointment-complete-${row.id}`}>
                              Consultation done
                            </Button>
                          )}
                          {onAction && onRowClick && row.status === "no_show" && (
                            <Button size="sm" variant="secondary" className="max-sm:min-h-11" onClick={() => onRowClick(row)} data-testid={`appointment-reschedule-${row.id}`}>
                              Reschedule
                            </Button>
                          )}
                          {onAction && canNoShow && (
                            <Button size="sm" variant="danger" className="max-sm:min-h-11" onClick={() => onAction(row, "mark_no_show")} data-testid={`appointment-noshow-${row.id}`}>
                              No-show
                            </Button>
                          )}
                        </span>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
