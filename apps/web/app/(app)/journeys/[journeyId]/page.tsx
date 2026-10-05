"use client";

import { treatmentDateLine } from "@/components/treatments/treatmentDates";
import { useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import {
  APPOINTMENT_STATUS_LABEL, APPOINTMENT_STATUS_TONE, Badge, Button, Card, OperationalStatusBadge, CustomFieldValueGrid, EmptyState, ErrorState, JOURNEY_STAGE_LABEL, JOURNEY_STAGE_TONE,
  PageHeader, Panel, Skeleton, TREATMENT_STATUS_LABEL, TREATMENT_STATUS_TONE, Timeline,
  fmtDate, fmtDateTime, formatInr, relativeTime, urgencyLabel,
} from "@pulseos/ui";
import { hasPermission, type JourneyDetailVm, type RevenueEventVm } from "@pulseos/types";
import { CalendarPlus, ChevronRight, ListPlus, Phone, UserRoundCog } from "lucide-react";
import { BackLink, carryFrom } from "@/components/shell/BackLink";
import { JourneyBreadcrumb } from "@/components/shell/Breadcrumb";
import { AssignOwnerDialog } from "@/components/journey/AssignOwnerDialog";
import { LogOutcomeSheet } from "@/components/outcomes/LogOutcomeSheet";
import { AddFollowUpSheet } from "@/components/followups/AddFollowUpSheet";
import { AppointmentContext } from "@/components/followups/AppointmentContext";
import { useAppointmentWorkflow } from "@/components/appointments/AppointmentWorkflow";
import { SurgeryCard } from "@/components/surgery/SurgeryCard";
import { InlineNotice } from "@/components/appointments/InlineNotice";
import { NextActionCard } from "@/components/followups/NextActionCard";
import { useQuickCreate } from "@/components/shell/QuickCreateProvider";
import { LogCallSheet } from "@/components/calls/LogCallSheet";
import { CallStatsStrip } from "@/components/calls/CallStatsStrip";
import { useCallDetail } from "@/components/calls/useCallDetail";
import { JourneyProgress } from "@/components/journey/JourneyProgress";
import { invalidateJourneyQueries } from "@/components/journey/invalidate";
import { useCapability } from "@/lib/useEdition";

const REVENUE_TYPE_LABEL: Record<RevenueEventVm["type"], string> = {
  consultation_fee: "Consultation fee",
  treatment_payment: "Treatment payment",
  other: "Payment",
};

const SOURCE_LABEL: Record<string, string> = {
  meta: "Meta", google: "Google", website: "Website", whatsapp: "WhatsApp", phone: "Phone", walk_in: "Walk-in", referral: "Referral", organic: "Organic", other: "Other",
};

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-ink">{children}</dd>
    </div>
  );
}

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function JourneyPageSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="journey-loading">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-40" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.5fr_1fr]">
        <Skeleton className="h-96" />
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="journey-not-found">
      <BackLink fallback="/journeys" fallbackLabel="Back to Journeys" />
      <Card className="py-6">
        <EmptyState
          message="This journey could not be found"
          hint="It may have been removed, or it belongs to a different hospital. Go back to Journeys to pick another."
          action={<Link href="/journeys" className="text-xs font-medium text-primary-600 hover:underline">Open Journeys</Link>}
        />
      </Card>
    </div>
  );
}

export default function JourneyDetailPage() {
  const params = useParams<{ journeyId: string }>();
  const journeyId = params.journeyId;
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  // "Log outcome" sheet; `taskId` is set when it is opened from one of the open follow-ups.
  const [logging, setLogging] = useState<{ taskId?: string } | null>(null);
  const [loggingCall, setLoggingCall] = useState(false);
  const [addingFollowUp, setAddingFollowUp] = useState(false);
  const quickCreate = useQuickCreate();
  const revenueTracking = useCapability("REVENUE_TRACKING");
  // The same drawer, steps and "What happens next?" sheet the Appointments and Front Desk pages use.
  const workflow = useAppointmentWorkflow();

  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  // One branch / one doctor: nothing to tell apart, so neither is repeated on the record.
  const multiBranch = (lookups.data?.branches.length ?? 0) > 1;
  const multiDoctor = (lookups.data?.doctors.length ?? 0) > 1;
  const detail = useQuery({
    queryKey: ["journey", journeyId],
    queryFn: () => api.journeyDetail(journeyId),
    retry: (count, err) => (err as { status?: number }).status !== 404 && count < 1,
  });

  const role = session.data?.user.role;
  const canAssign = role ? hasPermission(role, "MANAGE_JOURNEYS") : false;
  const canLogOutcome = role ? hasPermission(role, "MANAGE_TASKS") : false;
  const canLogCall = role ? hasPermission(role, "LOG_CALL") : false;
  const canAddFollowUp = role ? hasPermission(role, "MANAGE_TASKS") : false;
  const canBook = role ? hasPermission(role, "MANAGE_APPOINTMENTS") : false;
  const canManageTreatment = role ? hasPermission(role, "MANAGE_TREATMENT") : false;
  // Hooks must run on every render, before the loading/error early returns below.
  const callDetail = useCallDetail(detail.data?.patient.name ?? "");

  if (detail.isLoading) return <JourneyPageSkeleton />;
  if (detail.isError) {
    if ((detail.error as { status?: number }).status === 404) return <NotFound />;
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <BackLink fallback="/journeys" fallbackLabel="Back to Journeys" />
        <ErrorState message="Could not load this journey." />
      </div>
    );
  }
  if (!detail.data) return <NotFound />;

  const { patient, journey, customFields, timeline, tasks, appointments, treatments, revenue }: JourneyDetailVm = detail.data;
  const stageTone = JOURNEY_STAGE_TONE[journey.stage] ?? "neutral";
  const openTasks = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const doneTasks = tasks.length - openTasks.length;
  // "Not available for your role" is only true when revenue is on for the hospital but this role cannot see it.
  const restricted = [treatments === null ? "treatments" : null, revenue === null && revenueTracking ? "revenue" : null].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="journey-detail">
      <PageHeader
        back={<JourneyBreadcrumb patient={{ id: patient.id, name: patient.name }} journey={{ id: journey.id, journeyType: journey.journeyType }} />}
        title={patient.name}
        subtitle={`${patient.age !== null ? `${patient.age} yrs · ` : ""}${patient.phone}${multiBranch && patient.branchName ? ` · ${patient.branchName}` : ""}`}
        actions={
          // The three things Staff do most, in one place: log a call, schedule a follow-up, book a visit.
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center" data-testid="journey-actions">
            {canLogCall && (
              <Button variant="primary" className="min-h-11 lg:min-h-0" onClick={() => setLoggingCall(true)} data-testid="journey-log-call">
                <Phone size={14} aria-hidden="true" /> Log call
              </Button>
            )}
            {canAddFollowUp && (
              <Button variant="secondary" className="min-h-11 lg:min-h-0" onClick={() => setAddingFollowUp(true)} data-testid="journey-add-followup">
                <ListPlus size={14} aria-hidden="true" /> Add follow-up
              </Button>
            )}
            {canBook && (
              <Button variant="secondary" className="min-h-11 lg:min-h-0" onClick={() => quickCreate.openNewAppointment({ patient: { id: patient.id, name: patient.name, phone: patient.phone }, journeyId: journey.id })} data-testid="journey-book-appointment">
                <CalendarPlus size={14} aria-hidden="true" /> Book appointment
              </Button>
            )}
          </div>
        }
      />

      {/* Journey summary: what this enquiry is, where it stands, who owns the next move. */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700" aria-hidden="true">
            {initials(patient.name)}
          </span>
          <h2 className="text-base font-semibold tracking-tight text-ink" data-testid="journey-service">{journey.journeyType}</h2>
          <Link href={carryFrom(`/patients/${patient.id}`, searchParams.get("from"), "journeys")} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary-700 hover:underline" data-testid="journey-patient-link">
            Open Patient 360
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
          <span data-testid="journey-stage"><Badge tone={stageTone}>{JOURNEY_STAGE_LABEL[journey.stage] ?? journey.stage}</Badge></span>
          {/* Where the patient is right now (derived from the visit, treatment and tasks - never stored). */}
          <OperationalStatusBadge status={journey.operationalStatus} data-testid="journey-operational-status" />
          {journey.lastOutcome && (
            <span data-testid="journey-sub-status" title={`Last outcome logged ${fmtDateTime(journey.lastOutcome.at)}`}>
              <Badge tone="neutral">{journey.lastOutcome.label}</Badge>
            </span>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <JourneyProgress detail={detail.data} />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Original source" testId="journey-original-source">{journey.sourceLabel ?? SOURCE_LABEL[journey.source] ?? journey.source}</Fact>
          {journey.departmentName && <Fact label="Department" testId="journey-department">{journey.departmentName}</Fact>}
          <Fact label="Campaign">{journey.campaign?.name ?? "Organic / no campaign"}</Fact>
          <Fact label="Assigned Team Member" testId="journey-owner">
            <span className="flex items-center gap-1.5">
              <span className={`truncate ${journey.owner ? "" : "text-ink-2"}`}>{journey.owner?.name ?? "Unassigned"}</span>
              {canAssign && (
                <button
                  type="button"
                  onClick={() => setAssigning(true)}
                  aria-label={journey.owner ? "Reassign Team Member" : "Assign Team Member"}
                  className="inline-flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5 text-[11px] font-medium text-primary-700 hover:bg-primary-50"
                  data-testid="journey-assign-owner"
                >
                  <UserRoundCog size={12} aria-hidden="true" />
                  {journey.owner ? "Reassign" : "Assign"}
                </button>
              )}
            </span>
          </Fact>
          {multiDoctor && <Fact label="Doctor">{journey.doctorName ?? "—"}</Fact>}
          <Fact label="Enquiry created">{fmtDate(journey.createdAt)} <span className="text-xs text-ink-2">· {relativeTime(journey.createdAt)}</span></Fact>
          <Fact label="Last interaction">{relativeTime(journey.lastInteractionAt)}</Fact>
        </dl>

        <div className="mt-4 border-t border-line pt-3">
          <CallStatsStrip stats={journey.callStats} />
        </div>

        {customFields.length > 0 && (
          <div className="mt-5 border-t border-line pt-4" data-testid="journey-custom-fields">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Details</h3>
            <CustomFieldValueGrid fields={customFields} testId="journey-custom-field-values" />
          </div>
        )}
      </Card>


      {/* What to do next, and the visit it leads to — right under the actions. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.5fr_1fr]">
        <NextActionCard journey={journey} canManage={canAddFollowUp} onAdd={() => setAddingFollowUp(true)} upcomingVisit={appointments.filter((a) => a.status === "requested" || a.status === "scheduled" || a.status === "confirmed").sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0] ?? null} />
        <AppointmentContext
          appointments={appointments}
          canBook={canBook}
          canManage={workflow.canManage}
          onBook={() => quickCreate.openNewAppointment({ patient: { id: patient.id, name: patient.name, phone: patient.phone }, journeyId: journey.id })}
          onOpen={workflow.select}
          onAction={workflow.handleAction}
          onComplete={workflow.handleComplete}
        />
      </div>
      <SurgeryCard treatments={treatments} canManage={canManageTreatment} />
      {workflow.error && <InlineNotice message={workflow.error} onDismiss={workflow.clearError} testId="journey-appointment-error" />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="min-w-0" data-testid="journey-timeline">
          <Timeline events={timeline} renderEventDetail={callDetail.renderEventDetail} />
        </div>

        <div className="min-w-0 space-y-4">
          <Panel
            title="Follow-ups"
            subtitle={openTasks.length ? `${openTasks.length} open` : undefined}
            data-testid="journey-tasks"
            padded={false}
            action={
              canLogOutcome ? (
                <Button size="sm" variant="secondary" onClick={() => setLogging({})} data-testid="journey-log-outcome">
                  Log outcome
                </Button>
              ) : undefined
            }
          >
            {openTasks.length === 0 ? (
              <p className="px-4 py-3 text-xs text-ink-2">No open follow-ups{doneTasks ? ` · ${doneTasks} completed` : ""}.</p>
            ) : (
              <ul className="divide-y divide-line">
                {openTasks.map((t) => {
                  const due = urgencyLabel(t.dueAt);
                  return (
                    <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm" data-testid={`journey-task-${t.id}`}>
                      <div className="min-w-0">
                        <p className="truncate text-ink">{t.typeLabel}</p>
                        <p className="truncate text-xs text-ink-2">{t.assignedToName ?? "Unassigned"}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={`text-xs ${due.overdue ? "font-medium text-danger-700" : "text-ink-2"}`}>{due.text}</p>
                        <p className="text-[11px] text-neutral-500">{fmtDate(t.dueAt)}</p>
                        {canLogOutcome && (
                          <button type="button" onClick={() => setLogging({ taskId: t.id })} className="mt-0.5 min-h-11 text-[11px] font-medium text-primary-700 hover:underline sm:min-h-0" data-testid={`journey-task-log-${t.id}`}>
                            Log outcome
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {openTasks.length > 0 && doneTasks > 0 && <p className="border-t border-line px-4 py-2 text-[11px] text-ink-2">{doneTasks} completed</p>}
          </Panel>

          <Panel title="Appointments" data-testid="journey-appointments" padded={false}>
            {appointments.length === 0 ? (
              <p className="px-4 py-3 text-xs text-ink-2">No appointments booked yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {appointments.map((a) => (
                  <li key={a.id} className="text-sm">
                    <button type="button" onClick={() => workflow.select(a)} className="flex min-h-11 w-full items-start justify-between gap-3 px-4 py-2.5 text-left hover:bg-primary-50/50 sm:min-h-0" data-testid={`journey-appointment-${a.id}`}>
                      <span className="min-w-0">
                        <span className="block truncate text-ink">{fmtDateTime(a.scheduledAt)}</span>
                        <span className="block truncate text-xs text-ink-2">{[multiDoctor ? (a.doctorName ?? "Doctor not set") : null, a.reason].filter(Boolean).join(" · ")}</span>
                      </span>
                      <Badge tone={APPOINTMENT_STATUS_TONE[a.status] ?? "neutral"}>{APPOINTMENT_STATUS_LABEL[a.status] ?? a.status}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {treatments !== null && (
            <Panel title="Treatments" data-testid="journey-treatments" padded={false}>
              {treatments.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-2">No treatment advised yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {treatments.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-ink">{t.treatmentLabel}</p>
                        <p className="truncate text-xs text-ink-2">
                          {revenueTracking ? formatInr(t.estimatedValue) : ""}{(() => { const line = treatmentDateLine(t, fmtDate); if (!line) return ""; const text = line.recorded ? `${line.label.toLowerCase()} ${line.text}` : `${line.label === "Completed on" ? "completed" : "scheduled"}, date not recorded`; return revenueTracking ? ` · ${text}` : text.replace(/^./, (c) => c.toUpperCase()); })()}
                        </p>
                      </div>
                      <Badge tone={TREATMENT_STATUS_TONE[t.status] ?? "neutral"}>{TREATMENT_STATUS_LABEL[t.status] ?? t.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {revenueTracking && revenue !== null && (
            <Panel title="Revenue attribution" subtitle={formatInr(revenue.total)} data-testid="journey-revenue" padded={false}>
              {revenue.events.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-2">No revenue recorded yet. Attributed to {SOURCE_LABEL[journey.source] ?? journey.source}{journey.campaign ? ` · ${journey.campaign.name}` : ""} once payments post.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {revenue.events.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-ink">{REVENUE_TYPE_LABEL[e.type] ?? "Payment"}</p>
                        <p className="text-xs text-ink-2">{fmtDate(e.occurredAt)}</p>
                      </div>
                      <span className="tabular-nums text-ink">{formatInr(e.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {restricted.length > 0 && (
            <p className="px-1 text-[11px] text-ink-2" data-testid="journey-restricted-note">
              {restricted.join(" and ").replace(/^./, (c) => c.toUpperCase())} {restricted.length > 1 ? "are" : "is"} not available for your role.
            </p>
          )}
        </div>
      </div>

      {workflow.element}
      {loggingCall && canLogCall && <LogCallSheet target={{ kind: "log", journeyId: journey.id }} patientName={patient.name} onClose={() => setLoggingCall(false)} />}
      {callDetail.sheet}
      {addingFollowUp && canAddFollowUp && <AddFollowUpSheet journeyId={journey.id} patientName={patient.name} ownerName={journey.owner?.name ?? null} onClose={() => setAddingFollowUp(false)} />}
      {logging && canLogOutcome && <LogOutcomeSheet journeyId={journey.id} patient={{ id: patient.id, name: patient.name, phone: patient.phone }} taskId={logging.taskId} onClose={() => setLogging(null)} />}

      {assigning && canAssign && (
        <AssignOwnerDialog
          open
          subject={patient.name}
          owners={lookups.data?.owners ?? []}
          initialOwnerId={journey.owner?.id ?? null}
          onClose={() => setAssigning(false)}
          onSubmit={async (ownerId) => {
            const updated = await api.assignJourneyOwner(journey.id, ownerId);
            queryClient.setQueryData(["journey", journeyId], updated);
            invalidateJourneyQueries(queryClient);
            setAssigning(false);
          }}
        />
      )}
    </div>
  );
}
