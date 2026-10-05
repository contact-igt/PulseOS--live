"use client";

import { Phone } from "lucide-react";
import { Badge, OperationalStatusBadge, fmtDateTime, urgencyLabel } from "@pulseos/ui";
import type { LeadRow, LeadStatus } from "@pulseos/types";
import { telHref } from "./LeadsTable";

const STATUS_LABEL: Record<LeadStatus, string> = { new: "New", uncontacted: "Uncontacted", follow_up_due: "Follow-up due", appointment_booked: "Appointment booked", no_response: "No response", converted: "Converted", lost: "Lost" };

/** Phone layout: one compact card per lead (patient, enquiry · status, source, next action, owner) and two actions. */
export function LeadCards({ rows, onOpen }: { rows: LeadRow[]; onOpen: (lead: LeadRow) => void }) {
  return (
    <ul className="divide-y divide-line" data-testid="lead-cards">
      {rows.map((lead) => {
        const due = lead.nextAction ? urgencyLabel(lead.nextAction.dueAt) : null;
        return (
          <li key={lead.id} className="space-y-1.5 px-4 py-3" data-testid={`lead-card-${lead.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{lead.patientName}</p>
                <p className="truncate text-xs text-ink-2">
                  {lead.journeyType} · {lead.outcomeLabel ?? STATUS_LABEL[lead.leadStatus]}
                </p>
              </div>
              <span className="flex flex-col items-end gap-1">
                <Badge tone={lead.leadStatus === "no_response" ? "danger" : lead.leadStatus === "follow_up_due" ? "warning" : "primary"}>{STATUS_LABEL[lead.leadStatus]}</Badge>
                <OperationalStatusBadge status={lead.operationalStatus} data-testid={`lead-card-op-status-${lead.id}`} />
              </span>
            </div>
            <p className="text-xs text-ink-2">{lead.sourceLabel}</p>
            {lead.nextAction && due && (
              <p className={`text-xs ${due.overdue ? "font-medium text-danger-700" : "text-ink"}`}>
                Next: {lead.nextAction.label} · {due.text} · {fmtDateTime(lead.nextAction.dueAt)}
              </p>
            )}
            {lead.nextAppointment && <p className="text-xs text-primary-700">Visit {fmtDateTime(lead.nextAppointment.at)}</p>}
            <p className="text-xs text-ink-2">Team Member: {lead.ownerName ?? "Unassigned"}</p>
            <div className="flex gap-2 pt-1">
              <a href={telHref(lead.phone)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control border border-line-strong bg-surface text-sm font-medium text-primary-700" data-testid={`lead-card-call-${lead.id}`}>
                <Phone size={15} aria-hidden="true" /> Call
              </a>
              <button type="button" onClick={() => onOpen(lead)} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-control bg-primary-600 text-sm font-semibold text-white" data-testid={`lead-card-open-${lead.id}`}>
                Open
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
