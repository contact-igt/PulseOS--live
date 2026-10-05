"use client";

import Link from "next/link";
import { Phone, UserRoundCog } from "lucide-react";
import { Badge, OperationalStatusBadge, OverflowMenu, Table, TableBody, TableHead, Td, Th, Tr, fmtDate, fmtDateTime, relativeTime, urgencyLabel } from "@pulseos/ui";
import type { LeadRow, LeadStatus } from "@pulseos/types";
import { withFrom } from "@/components/shell/BackLink";
import type { LeadColumn } from "./leadList";

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  uncontacted: "Uncontacted",
  follow_up_due: "Follow-up due",
  appointment_booked: "Appointment booked",
  no_response: "No response",
  converted: "Converted",
  lost: "Lost",
};
const STATUS_TONE: Record<LeadStatus, "neutral" | "warning" | "danger" | "primary"> = {
  new: "primary", uncontacted: "neutral", follow_up_due: "warning", appointment_booked: "primary", no_response: "danger", converted: "primary", lost: "neutral",
};

/**
 * The Leads table: who, what they enquired about, where they came from, where they stand, who owns them, what
 * happened last and what happens next (from Tasks). The whole row opens the Journey.
 */
/** Row actions beyond opening the journey: one quick Call, the rest in the overflow menu. */
export interface LeadRowActions {
  onAddFollowUp: (lead: LeadRow) => void;
  onBookAppointment: (lead: LeadRow) => void;
}

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

export function LeadsTable({
  rows,
  columns,
  actions,
  canAssign,
  selected,
  allSelected,
  onToggle,
  onToggleAll,
  onOpen,
  onAssign,
}: {
  rows: LeadRow[];
  columns: LeadColumn[];
  actions: LeadRowActions;
  canAssign: boolean;
  selected: Set<string>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onOpen: (lead: LeadRow) => void;
  onAssign: (lead: LeadRow) => void;
}) {
  const show = (c: LeadColumn) => columns.includes(c);
  return (
    <Table className="min-w-[760px]">
      <TableHead>
        <tr>
          {canAssign && (
            <Th leading className="w-10">
              <label className="flex items-center justify-center max-md:min-h-11 max-md:min-w-11"><input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all leads" data-testid="lead-select-all" className="max-md:h-5 max-md:w-5" /></label>
            </Th>
          )}
          <Th leading={!canAssign}>Patient</Th>
          {show("enquiry") && <Th>Enquiry</Th>}
          {show("source") && <Th>Original source</Th>}
          {show("status") && <Th>Journey status</Th>}
          {show("outcome") && <Th>Outcome</Th>}
          {show("owner") && <Th>Team Member</Th>}
          {show("created") && <Th>Created</Th>}
          {show("appointment") && <Th>Appointment</Th>}
          {show("lastInteraction") && <Th>Last interaction</Th>}
          {show("nextAction") && <Th>Next action</Th>}
          <Th><span className="sr-only">Actions</span></Th>
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((lead) => {
          const due = lead.nextAction ? urgencyLabel(lead.nextAction.dueAt) : null;
          return (
            <Tr key={lead.id} onClick={() => onOpen(lead)} data-testid={`lead-row-${lead.id}`} data-stage={lead.stage}>
              {canAssign && (
                <Td leading className="w-10" onClick={(e) => e.stopPropagation()}>
                  <label className="flex items-center justify-center max-md:min-h-11 max-md:min-w-11"><input type="checkbox" checked={selected.has(lead.id)} onChange={() => onToggle(lead.id)} aria-label={`Select ${lead.patientName}`} data-testid={`lead-select-${lead.id}`} className="max-md:h-5 max-md:w-5" /></label>
                </Td>
              )}
              <Td leading={!canAssign}>
                <Link href={withFrom(`/journeys/${lead.id}`, "leads")} onClick={(e) => e.stopPropagation()} className="block font-medium text-ink hover:text-primary-700 hover:underline">
                  {lead.patientName}
                </Link>
                <span className="block text-[11px] text-ink-2">{lead.phone}</span>
              </Td>
              {show("enquiry") && (
                <Td className="text-ink-2" data-testid={`lead-enquiry-${lead.id}`}>
                  <span className="block text-ink">{lead.journeyType}</span>
                  {lead.specialtyLabel && lead.specialtyLabel !== lead.journeyType && <span className="block text-[11px] text-neutral-500">{lead.specialtyLabel}</span>}
                </Td>
              )}
              {show("source") && (
                <Td className="text-ink-2">
                  <span className="block">{lead.sourceLabel}</span>
                  {lead.campaignName && <span className="block max-w-[10rem] truncate text-[11px] text-neutral-500">{lead.campaignName}</span>}
                </Td>
              )}
              {show("status") && (
                <Td>
                  <span className="flex flex-col items-start gap-1">
                    <Badge tone={STATUS_TONE[lead.leadStatus]}>{STATUS_LABEL[lead.leadStatus]}</Badge>
                    {/* Where the patient is right now (derived): booked, checked in, waiting, no-show... */}
                    <OperationalStatusBadge status={lead.operationalStatus} data-testid={`lead-op-status-${lead.id}`} />
                  </span>
                </Td>
              )}
              {show("outcome") && (
                <Td className="text-ink-2" data-testid={`lead-outcome-${lead.id}`}>
                  {lead.outcomeLabel ?? <span className="text-neutral-500">—</span>}
                </Td>
              )}
              {show("owner") && (
                <Td>
                  <span className="flex items-center gap-1.5">
                    <span className={lead.ownerName ? "text-ink" : "text-ink-2"} data-testid={`lead-owner-${lead.id}`}>
                      {lead.ownerName ?? "Unassigned"}
                    </span>
                    {canAssign && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAssign(lead);
                        }}
                        aria-label={`${lead.ownerName ? "Change" : "Assign"} team member for ${lead.patientName}`}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-chip text-primary-700 hover:bg-primary-50 max-md:h-11 max-md:w-11"
                        data-testid={`assign-owner-${lead.id}`}
                      >
                        <UserRoundCog size={14} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </Td>
              )}
              {show("created") && (
                <Td className="text-ink-2">
                  <span className="block">{fmtDate(lead.createdAt)}</span>
                  <span className="block text-[11px] text-neutral-500">{relativeTime(lead.createdAt)}</span>
                </Td>
              )}
              {show("appointment") && (
                <Td className="text-ink-2">
                  {lead.nextAppointment ? <span className="text-primary-700" data-testid={`lead-visit-${lead.id}`}>{fmtDateTime(lead.nextAppointment.at)}</span> : <span className="text-neutral-500">—</span>}
                </Td>
              )}
              {show("lastInteraction") && <Td className="text-ink-2">{relativeTime(lead.lastInteractionAt)}</Td>}
              {show("nextAction") && (
                <Td data-testid={`lead-next-${lead.id}`}>
                  {lead.nextAction && due ? (
                    <>
                      <span className="block text-ink">{lead.nextAction.label}</span>
                      <span className={`block text-[11px] ${due.overdue ? "font-medium text-danger-700" : "text-neutral-500"}`}>{due.text} · {fmtDateTime(lead.nextAction.dueAt)}</span>
                    </>
                  ) : (
                    <span className="text-neutral-500">—</span>
                  )}
                </Td>
              )}
              <Td onClick={(e) => e.stopPropagation()}>
                <span className="flex items-center justify-end gap-0.5">
                  <a href={telHref(lead.phone)} aria-label={`Call ${lead.patientName}`} className="inline-flex h-7 w-7 items-center justify-center rounded-chip text-primary-700 hover:bg-primary-50" data-testid={`lead-call-${lead.id}`}>
                    <Phone size={14} aria-hidden="true" />
                  </a>
                  <OverflowMenu
                    testId={`lead-menu-${lead.id}`}
                    items={[
                      { key: "open", label: "Open journey", onClick: () => onOpen(lead) },
                      { key: "followup", label: "Add follow-up", onClick: () => actions.onAddFollowUp(lead) },
                      { key: "appt", label: "Book appointment", onClick: () => actions.onBookAppointment(lead) },
                    ]}
                  />
                </span>
              </Td>
            </Tr>
          );
        })}
      </TableBody>
    </Table>
  );
}
