"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import {
  Badge, Card, ConnectorModeBadge, CustomFieldValueGrid, EmptyState, ErrorState, Panel, Skeleton, Tabs, Timeline, ViewSwitcher,
  JOURNEY_STAGE_LABEL, JOURNEY_STAGE_TONE, APPOINTMENT_STATUS_LABEL, TREATMENT_STATUS_LABEL,
  CALL_STATUS_LABEL, CALL_STATUS_TONE,
} from "@pulseos/ui";
import { formatInr, formatMoneyOrDash, fmtCallDuration, fmtDateTime as fmtDate, fmtSmartDateTime, urgencyLabel } from "@pulseos/ui";
import { ArrowUpRight, CalendarClock, History, PhoneIncoming, PhoneMissed, PhoneOutgoing } from "lucide-react";
import { carryFrom } from "@/components/shell/BackLink";
import { PatientBreadcrumb } from "@/components/shell/Breadcrumb";
import { hasPermission } from "@pulseos/types";
import { pathAllowedForRole } from "@/components/shell/nav";
import type { AppointmentStatus, CallVm, JourneyCardVm, JourneyStage, TreatmentStatus } from "@pulseos/types";
import { useViewState } from "@/lib/useViewState";
import { useCallDetail } from "@/components/calls/useCallDetail";
import { PatientUpcomingList } from "@/components/patient360/PatientUpcomingList";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { useCapability } from "@/lib/useEdition";

const VIEWS = ["timeline", "upcoming"] as const;
type P360View = (typeof VIEWS)[number];
/** Until the Upcoming response names the hospital zone (tenants default to it). */
function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const CLOSED_STAGES: JourneyStage[] = ["completed", "lost"];
const isActiveJourney = (j: JourneyCardVm) => !CLOSED_STAGES.includes(j.stage);

/** "1 active journey" only when it really is active; a lone completed/lost journey says so instead. */
function journeySummary(journeys: JourneyCardVm[]): string {
  if (journeys.length === 0) return "No journeys yet";
  const active = journeys.filter(isActiveJourney).length;
  if (journeys.length === 1) {
    const only = journeys[0];
    return active === 1 ? "1 active journey" : `1 journey · ${JOURNEY_STAGE_LABEL[only.stage] ?? only.stage}`;
  }
  return `${journeys.length} journeys · ${active} active`;
}

// Four checkpoints a coordinator actually thinks in, collapsed from the
// finer-grained JourneyStage enum — "is this patient still pre-appointment,
// booked, in consultation, or into treatment?" at a glance, no separate
// funnel needed for a single journey.
const MINI_FLOW_STEPS = ["Enquiry", "Appointment", "Consultation", "Treatment"] as const;
// The index of the step currently in progress — "completed" points one past
// the last step so every step (Treatment included) renders as done, not
// stuck at "in progress" forever.
const STAGE_CHECKPOINT: Partial<Record<JourneyStage, number>> = {
  enquiry: 0, contacted: 0, booked: 1, attended: 1, consulted: 2, treatment_advised: 2, scheduled: 3, completed: 4,
};

function JourneyMiniFlow({ stage }: { stage: JourneyStage }) {
  if (stage === "lost") return null;
  const current = STAGE_CHECKPOINT[stage] ?? 0;
  const currentLabel = MINI_FLOW_STEPS[current] ?? "Treatment complete";
  return (
    <ol className="mt-3 flex items-center" aria-label={`Progress: ${currentLabel}`}>
      {MINI_FLOW_STEPS.map((label, i) => {
        const done = i < current;
        const isCurrent = i === current;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none" aria-current={isCurrent ? "step" : undefined}>
            <div className="flex flex-col items-center gap-1">
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${
                  done ? "bg-primary-600 text-white" : isCurrent ? "border-2 border-primary-600 bg-white text-primary-600" : "border border-neutral-300 bg-white text-neutral-300"
                }`}
              >
                {done ? "✓" : ""}
              </span>
              <span className={`whitespace-nowrap text-[10px] ${isCurrent ? "font-semibold text-ink" : done ? "text-ink-2" : "text-neutral-400"}`}>{label}</span>
            </div>
            {i < MINI_FLOW_STEPS.length - 1 && <span className={`mx-1 mb-3.5 h-px flex-1 ${done ? "bg-primary-600" : "bg-line"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}</dt>
      <dd className="mt-0.5 break-words text-xs font-medium leading-5 text-ink">{children}</dd>
    </div>
  );
}

function apptText(j: JourneyCardVm): string {
  if (!j.appointmentTime) return "None scheduled";
  return `${fmtDate(j.appointmentTime)} · ${APPOINTMENT_STATUS_LABEL[j.appointmentStatus as AppointmentStatus] ?? j.appointmentStatus}`;
}

function treatmentText(j: JourneyCardVm): string {
  if (!j.treatmentLabel) return "None recorded";
  return `${j.treatmentLabel} · ${TREATMENT_STATUS_LABEL[j.treatmentStatus as TreatmentStatus] ?? j.treatmentStatus}`;
}

/** Operational status of the focused journey: who owns it, what happens next, and where the visit / treatment stands. */
function OperationalStatus({ journey }: { journey: JourneyCardVm }) {
  const overdue = !!journey.nextActionDueAt && urgencyLabel(journey.nextActionDueAt).overdue && isActiveJourney(journey);
  const cells: { key: string; label: string; value: ReactNode }[] = [
    { key: "stage", label: "Stage", value: <Badge tone={JOURNEY_STAGE_TONE[journey.stage] ?? "neutral"}>{JOURNEY_STAGE_LABEL[journey.stage] ?? journey.stage}</Badge> },
    {
      key: "next-action",
      label: "Next action",
      value: journey.nextActionDueAt ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {fmtDate(journey.nextActionDueAt)}
          {overdue && <Badge tone="warning">Overdue</Badge>}
        </span>
      ) : (
        "None pending"
      ),
    },
    { key: "appointment", label: "Appointment", value: apptText(journey) },
    { key: "treatment", label: "Treatment", value: treatmentText(journey) },
    { key: "owner", label: "Assigned Team Member", value: journey.ownerName ?? "Unassigned" },
    { key: "doctor", label: "Doctor", value: journey.doctorName ?? "—" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-6" data-testid="patient-operational-status">
      {cells.map((c) => (
        <div key={c.key} className="min-w-0 bg-surface px-4 py-2.5" data-testid={`status-${c.key}`}>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{c.label}</dt>
          <dd className="mt-1 break-words text-xs font-semibold leading-5 text-ink">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JourneyCard({ journey, active, canOpen, onSelect }: { journey: JourneyCardVm; active: boolean; canOpen: boolean; onSelect: () => void }) {
  // Opening a journey from here keeps the list this person came from (Leads > Patient > Cataract), else Patients.
  const from = useSearchParams().get("from");
  return (
    <Card
      className={`p-4 transition-colors ${active ? "border-primary-500! ring-1 ring-primary-500/30" : ""}`}
      onClick={onSelect}
      data-testid={`journey-card-${journey.id}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="break-words text-sm font-semibold tracking-tight text-ink">{journey.journeyType}</h3>
          <Badge tone={JOURNEY_STAGE_TONE[journey.stage] ?? "neutral"}>{JOURNEY_STAGE_LABEL[journey.stage] ?? journey.stage}</Badge>
        </div>
        {canOpen && (
          <Link
            href={carryFrom(`/journeys/${journey.id}`, from, "patients")}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary-700 hover:underline"
            data-testid={`open-journey-${journey.id}`}
          >
            Open journey
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        )}
      </div>
      <JourneyMiniFlow stage={journey.stage} />
      {/* Specialty custom fields (e.g. Ophthalmology's "Eye Concern") —
          configured in Settings, captured on Add Lead. A compact grid, not a
          card or a row per field. */}
      {journey.customFields.length > 0 && (
        <div className="mt-3.5 border-t border-line pt-3" data-testid="journey-custom-fields">
          <CustomFieldValueGrid fields={journey.customFields} testId={`journey-custom-field-values-${journey.id}`} />
        </div>
      )}
      <p className="mt-3 text-[11px] text-ink-2">
        Last interaction {journey.lastInteractionAt ? fmtSmartDateTime(journey.lastInteractionAt) : "—"}
      </p>
    </Card>
  );
}

const CALL_DIRECTION_ICON = { inbound: PhoneIncoming, outbound: PhoneOutgoing } as const;

// The `calls` table (Runo webhook ingestion) has been writing real rows for
// a while — this is the first UI that reads any of it. Deliberately its own
// compact card rather than merged into the Timeline: a call is patient-level
// (not always tied to the currently-selected journey), and cramming full
// call detail into Timeline rows would defeat Timeline's own "concise, one
// story" design. Recording is a plain link-out, not an inline player — an
// embedded player/transcript view is real future scope (see the omnichannel
// audit), not built this pass.
/** Opens the authenticated recording stream (PulseOS checks the permission and streams the audio — never the provider's URL). */
function RecordingButton({ callId }: { callId: string }) {
  return (
    <a href={api.callRecordingUrl(callId)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium text-primary-700 hover:underline" data-testid={`call-recording-${callId}`}>
      Recording
    </a>
  );
}

function CallHistoryList({ calls, canPlayRecording }: { calls: CallVm[]; canPlayRecording: boolean }) {
  if (calls.length === 0) return null;
  return (
    <Panel title={`Calls (${calls.length})`} subtitle="Duration, recording and disposition" padded={false}>
      <ul className="divide-y divide-line" data-testid="call-history-list">
        {calls.map((call) => {
          const Icon = call.status === "missed" ? PhoneMissed : CALL_DIRECTION_ICON[call.direction];
          return (
            <li key={call.id} className="flex items-start gap-2.5 px-4 py-2.5 text-sm" data-testid={`call-row-${call.id}`}>
              <Icon size={15} className="mt-0.5 shrink-0 text-ink-2" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={CALL_STATUS_TONE[call.status]}>{CALL_STATUS_LABEL[call.status]}</Badge>
                  <ConnectorModeBadge mode={call.connectorMode} />
                  <span className="text-xs text-ink-2">{fmtSmartDateTime(call.startedAt)}</span>
                </div>
                <p className="mt-1 break-words text-xs text-ink-2">
                  {call.agentName ?? "Unknown agent"} · {fmtCallDuration(call.durationSeconds)}
                  {call.disposition ? ` · ${call.disposition}` : ""}
                  {call.endpointLabel ? ` · ${call.endpointLabel}` : ""}
                </p>
                {call.hasRecording && canPlayRecording && <RecordingButton callId={call.id} />}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function AcquisitionMetric({ label, children, strong = false }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm text-ink ${strong ? "font-semibold" : ""}`}>{children}</dd>
    </div>
  );
}

const ALL_JOURNEYS = "all";

export default function Patient360Page() {
  const params = useParams<{ patientId: string }>();
  const patientId = params.patientId;
  const [selection, setSelection] = useState<string>(ALL_JOURNEYS);
  const showRevenue = useCapability("REVENUE_TRACKING");

  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  // Journey Detail needs VIEW_JOURNEYS *and* a place in the role's navigation (a Doctor has the permission but
  // is routed home from /journeys); mirrored here only to avoid a dead link, never as the authorization boundary.
  const canOpenJourney = !!session.data && hasPermission(session.data.user.role, "VIEW_JOURNEYS") && pathAllowedForRole(session.data.user.role, "/journeys");

  const patient360 = useQuery({ queryKey: ["patient360", patientId], queryFn: () => api.patient360(patientId) });
  const journeys = useMemo(() => patient360.data?.journeys ?? [], [patient360.data]);
  const selectedJourney = journeys.find((j) => j.id === selection);
  // The journey the status strip describes: the selected one, else the most recent still-active one, else the most recent.
  const focusJourney = selectedJourney ?? journeys.find(isActiveJourney) ?? journeys[0];
  const timelineJourneyId = selectedJourney?.id;

  // Upcoming: existing future appointments / open tasks / scheduled treatments for THIS patient,
  // permission-trimmed server-side; grouped in the hospital's timezone the response names.
  const upcoming = useQuery({ queryKey: ["patient360", patientId, "upcoming"], queryFn: () => api.patientUpcoming(patientId), enabled: patient360.isSuccess });
  const timeZone = useHospitalTimeZone();
  const callDetail = useCallDetail(patient360.data?.patient.name ?? "");
  const { view, setView } = useViewState<P360View>({ views: VIEWS, defaultView: "timeline", timeZone });
  const upcomingCount = upcoming.data ? upcoming.data.items.filter((i) => !selectedJourney || i.journeyId === selectedJourney.id).length : null;

  const timeline = useQuery({
    queryKey: ["timeline", patientId, timelineJourneyId ?? "all"],
    queryFn: () => api.patientTimeline(patientId, timelineJourneyId),
    enabled: patient360.isSuccess,
  });

  if (patient360.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-32" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (patient360.isError || !patient360.data) {
    return <ErrorState message="Could not load this patient." />;
  }

  const { patient, calls, acquisition } = patient360.data;

  // Duplicate service names (two Cataract journeys) get a numeric suffix so the selector stays unambiguous.
  const typeSeen = new Map<string, number>();
  const journeyTabs = journeys.map((j) => {
    const n = (typeSeen.get(j.journeyType) ?? 0) + 1;
    typeSeen.set(j.journeyType, n);
    return { key: j.id, label: n > 1 ? `${j.journeyType} (${n})` : j.journeyType, testId: `journey-tab-${j.id}` };
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="patient-360">
      <PatientBreadcrumb patient={{ id: patient.id, name: patient.name }} />

      {/* Patient identity, journey selector and operational status: one header panel */}
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-100 text-sm font-semibold text-primary-700" aria-hidden="true">
            {initials(patient.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h1 className="break-words text-xl font-semibold tracking-tight text-ink">{patient.name}</h1>
              <span className="text-xs text-ink-2" data-testid="patient-journey-summary">{journeySummary(journeys)}</span>
            </div>
            <p className="mt-0.5 break-words text-sm text-ink-2">
              {patient.age !== null ? `${patient.age} yrs · ` : ""}{patient.phone} · {patient.preferredLanguage} · {patient.branchName ?? "No branch"}
            </p>
          </div>
        </div>
        {journeys.length > 1 && (
          <div className="border-t border-line px-4 py-2.5" data-testid="journey-selector">
            <Tabs
              ariaLabel="Journey"
              items={[{ key: ALL_JOURNEYS, label: "All journeys", testId: "journey-tab-all" }, ...journeyTabs]}
              value={selection}
              onChange={setSelection}
            />
          </div>
        )}
        {focusJourney && <OperationalStatus journey={focusJourney} />}
      </Card>

      {/* Main area: Timeline first (left), journey context (right) */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ViewSwitcher
              ariaLabel="Patient view"
              value={view}
              onChange={setView}
              options={[
                { key: "timeline", label: "Timeline", icon: <History size={14} />, controls: "patient-view-panel" },
                { key: "upcoming", label: upcomingCount === null ? "Upcoming" : `Upcoming ${upcomingCount}`, icon: <CalendarClock size={14} />, controls: "patient-view-panel" },
              ]}
            />
            {selectedJourney && (
              <p className="px-1 text-xs text-ink-2">Showing {selectedJourney.journeyType} only.</p>
            )}
          </div>
          <div id="patient-view-panel" role="tabpanel" aria-label={view === "upcoming" ? "Upcoming" : "Timeline"} className="min-w-0">
          {view === "upcoming" ? (
            upcoming.isLoading ? (
              <Skeleton className="h-48" />
            ) : upcoming.isError || !upcoming.data ? (
              <ErrorState message="Could not load what's upcoming for this patient." />
            ) : (
              <PatientUpcomingList
                items={upcoming.data.items}
                timeZone={timeZone}
                journeyId={selectedJourney?.id}
                showJourney={journeys.length > 1}
                role={session.data?.user.role}
                now={new Date()}
              />
            )
          ) : timeline.isLoading ? (
            <Skeleton className="h-96" />
          ) : timeline.isError ? (
            <ErrorState message="Could not load the timeline." />
          ) : (
            timeline.data && <Timeline events={timeline.data} order="desc" renderEventDetail={callDetail.renderEventDetail} />
          )}
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-2">Journeys ({journeys.length})</h2>
          {journeys.length === 0 && (
            <Card><EmptyState message="No journeys yet" hint="A journey starts when an enquiry or appointment is recorded." /></Card>
          )}
          {journeys.map((j) => (
            <JourneyCard key={j.id} journey={j} active={journeys.length > 1 && j.id === selectedJourney?.id} canOpen={canOpenJourney} onSelect={() => journeys.length > 1 && setSelection(j.id)} />
          ))}
          <CallHistoryList calls={calls} canPlayRecording={!!session.data && hasPermission(session.data.user.role, "VIEW_CALL_RECORDING")} />
        </div>
      </div>

      {/* Acquisition / revenue: subordinate, below the operational section */}
      <Panel title={showRevenue ? "Acquisition & revenue" : "Acquisition"} subtitle={showRevenue ? "Where this patient came from and what it has generated" : "Where this patient came from"}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <AcquisitionMetric label="Source">{acquisition.source ?? "—"}</AcquisitionMetric>
          <AcquisitionMetric label="Campaign">{acquisition.campaignName ?? "Organic / No campaign"}</AcquisitionMetric>
          <AcquisitionMetric label="First touch">{fmtDate(acquisition.firstTouchAt)}</AcquisitionMetric>
          <AcquisitionMetric label="Acquisition cost">{formatMoneyOrDash(acquisition.allocatedAcquisitionCost)}</AcquisitionMetric>
          {showRevenue && acquisition.estimatedTreatmentValue !== null && <AcquisitionMetric label="Est. treatment value">{formatInr(acquisition.estimatedTreatmentValue)}</AcquisitionMetric>}
          {showRevenue && acquisition.attributedRevenue !== null && <AcquisitionMetric label="Attributed revenue" strong>{formatInr(acquisition.attributedRevenue)}</AcquisitionMetric>}
        </dl>

        {acquisition.lastTouch && (
          <div className="mt-4 rounded-control border border-primary-100 bg-surface-info px-3 py-2 text-xs text-primary-800" data-testid="patient-last-touch">
            <span className="font-semibold">Multi-touch:</span>{" "}
            {acquisition.touchpointCount} touches recorded — most recently via <strong>{acquisition.lastTouch.source ?? "unknown source"}</strong>
            {acquisition.lastTouch.campaignName ? ` (${acquisition.lastTouch.campaignName})` : ""} on {fmtDate(acquisition.lastTouch.occurredAt)}. First touch above is preserved.
          </div>
        )}
      </Panel>
      {callDetail.sheet}
    </div>
  );
}
