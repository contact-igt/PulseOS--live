"use client";

import { useState, type ReactNode } from "react";
import { CalendarClock, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import {
  DoctorKpiStrip,
  DoctorTodayList,
  ErrorState,
  NextPatientCard,
  OutcomeActionList,
  RecentPatientsList,
  Button,
  Skeleton,
  Toolbar,
  ViewSwitcher,
  formatKey,
  type OutcomeTreatmentChoice,
} from "@pulseos/ui";
import { hasPermission, type AppointmentRow, type ConsultationOutcomeValue, type DoctorTodayItem } from "@pulseos/types";
import { CompleteConsultationSheet } from "@/components/appointments/CompleteConsultationSheet";
import { withFrom } from "@/components/shell/BackLink";
import { useViewState } from "@/lib/useViewState";
import { useCalendarContext } from "@/components/appointments/hooks";
import { DoctorDaySchedule } from "@/components/appointments/DoctorDaySchedule";
import { DayNavigator, dayLabel } from "@/components/filters/DayNavigator";
import { useCapability } from "@/lib/useEdition";

const DOCTOR_VIEWS = ["overview", "schedule"] as const;
type DoctorView = (typeof DOCTOR_VIEWS)[number];
const VIEW_OPTIONS = [
  { key: "overview" as const, label: "Overview", icon: <LayoutDashboard size={14} />, controls: "doctor-view-panel" },
  { key: "schedule" as const, label: "Schedule", icon: <CalendarClock size={14} />, controls: "doctor-view-panel" },
];

const OUTCOME_NOTICE: Record<ConsultationOutcomeValue, string> = {
  CONSULTED: "Consultation completed",
  TREATMENT_ADVISED: "Surgery / procedure advised",
  NO_TREATMENT_REQUIRED: "No treatment needed",
  DECISION_PENDING: "Patient is deciding",
  FOLLOW_UP_REQUIRED: "Review / follow-up",
  TREATMENT_DECLINED: "Patient declined",
  REFERRED: "Referred",
  OTHER: "Outcome",
};

const ERROR_TEXT: Record<string, string> = {
  outcome_already_recorded: "An outcome was already recorded for this consultation. The list has been refreshed.",
  invalid_treatment_definition: "That treatment is no longer available in the catalog. Pick another one.",
  appointment_not_completed: "This consultation isn't completed yet. Complete it first, then record the outcome.",
  forbidden: "This patient is not on your schedule, so you can't record an outcome for them.",
  appointment_not_found: "This appointment could not be found.",
};

type Notice = { kind: "success" | "error"; text: string };

function patientLink(item: { patientId?: string }, children: ReactNode) {
  if (!item.patientId) return children;
  return (
    <Link href={withFrom(`/patients/${item.patientId}`, "doctor-home")} className="min-w-0 hover:text-primary-700 hover:underline">
      {children}
    </Link>
  );
}

export default function DoctorHomePage() {
  const revenueTracking = useCapability("REVENUE_TRACKING");
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  // The doctor finishes the consultation of the patient who is with them; the outcome is recorded right after.
  const [completing, setCompleting] = useState<DoctorTodayItem | null>(null);
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const canComplete = !!session.data && hasPermission(session.data.user.role, "COMPLETE_CONSULTATION");
  const { timeZone, today: todayKey } = useCalendarContext();
  const { view, setView, date, setState: setViewState } = useViewState<DoctorView>({ views: DOCTOR_VIEWS, defaultView: "overview", timeZone });
  const isToday = date === todayKey;

  const dashboard = useQuery({ queryKey: ["dashboard", "doctor", date], queryFn: () => api.doctorDashboard(date) });
  // The tenant's whole catalog, once; each awaiting row is offered only the slice matching its journey's specialty.
  const catalog = useQuery({ queryKey: ["treatment-catalog"], queryFn: () => api.treatmentCatalog() });

  const recordOutcome = useMutation({
    mutationFn: (vars: { item: DoctorTodayItem; outcome: ConsultationOutcomeValue; treatment?: OutcomeTreatmentChoice }) =>
      api.recordOutcome(vars.item.appointmentId, { outcome: vars.outcome, ...vars.treatment }),
    onSuccess: (_result, vars) => {
      const choice = vars.treatment;
      const treatmentName = !choice ? undefined : "treatmentDefinitionId" in choice ? catalog.data?.find((d) => d.id === choice.treatmentDefinitionId)?.label : choice.treatmentLabel;
      setNotice({
        kind: "success",
        text: `Outcome recorded: ${OUTCOME_NOTICE[vars.outcome]}${treatmentName ? ` (${treatmentName})` : ""} for ${vars.item.patientName}.`,
      });
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.message : "";
      setNotice({ kind: "error", text: ERROR_TEXT[code] ?? "Could not record the outcome. Please try again." });
    },
    // Success or failure, the queue must reflect the server (a 409 means someone already recorded it).
    onSettled: () => {
      for (const key of ["dashboard", "treatments", "journeys", "patients", "patient360", "timeline", "journey"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  if (dashboard.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return <ErrorState message="Could not load your schedule." />;
  }

  const { data } = dashboard;
  const nextStatus = data.nextPatient ? data.today.find((i) => i.appointmentId === data.nextPatient!.appointmentId)?.status : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="doctor-home">
      <Toolbar>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ViewSwitcher ariaLabel="Doctor home view" value={view} onChange={(v) => setView(v)} options={VIEW_OPTIONS} />
          <DayNavigator date={date} today={todayKey} onChange={(d) => setViewState({ date: d === todayKey ? undefined : d })} testIdPrefix="doctor" />
        </div>
      </Toolbar>

      <DoctorKpiStrip dashboard={data} />

      {completing && (
        <CompleteConsultationSheet
          // Only what the sheet reads for a doctor: who, which journey and service. (Surgery scheduling is not offered to a doctor.)
          appointment={{ id: completing.appointmentId, patientName: completing.patientName, journeyId: completing.journeyId ?? "", serviceKey: completing.specialtyKey ?? null } as AppointmentRow}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setNotice({ kind: "success", text: `Consultation completed for ${completing.patientName}. Record the outcome below.` });
            setCompleting(null);
          }}
        />
      )}

      {view === "schedule" ? (
        // Same `today` rows as the queue below, laid out as the doctor's day in hospital time.
        <div id="doctor-view-panel" role="tabpanel" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="min-w-0">
            <DoctorDaySchedule
              items={data.today}
              timeZone={timeZone}
              dayLabel={formatKey(date, { weekday: "short", day: "numeric", month: "short" })}
              highlightId={data.nextPatient?.appointmentId}
              renderPatientLink={patientLink}
            />
          </div>
          <div className="min-w-0">
            <NextPatientCard patient={data.nextPatient} status={nextStatus} renderPatientLink={patientLink} />
          </div>
        </div>
      ) : (
        <div id="doctor-view-panel" role="tabpanel" className="space-y-4">
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
            <div className="min-w-0 space-y-4">
              <NextPatientCard patient={data.nextPatient} status={nextStatus} renderPatientLink={patientLink} />
              <DoctorTodayList
                items={data.today}
                title={isToday ? "Today's patient queue" : `Patient queue · ${dayLabel(date, todayKey)}`}
                highlightId={data.nextPatient?.appointmentId}
                emptyMessage={isToday ? "No appointments on your schedule today." : "No appointments on your schedule for this day."}
                renderPatientLink={patientLink}
                renderActions={(item) =>
                  canComplete && item.status === "with_doctor" ? (
                    <Button size="sm" variant="primary" className="min-h-11 sm:min-h-0" onClick={() => setCompleting(item)} data-testid={`complete-consultation-${item.appointmentId}`}>
                      Consultation done
                    </Button>
                  ) : null
                }
                testId="doctor-queue"
              />
            </div>

            <div className="min-w-0 space-y-3">
              {notice && (
                <div
                  role={notice.kind === "error" ? "alert" : "status"}
                  className={`flex items-start justify-between gap-3 rounded-card border px-3 py-2 text-xs ${
                    notice.kind === "error" ? "border-danger-500/30 bg-danger-100 text-danger-700" : "border-primary-200 bg-surface-info text-primary-800"
                  }`}
                  data-testid="outcome-notice"
                >
                  <span className="min-w-0 break-words">{notice.text}</span>
                  <button type="button" onClick={() => setNotice(null)} className="shrink-0 font-medium underline-offset-2 hover:underline">
                    Dismiss
                  </button>
                </div>
              )}
              <OutcomeActionList
                title="Consultations awaiting outcome"
                items={data.awaitingOutcome}
                emptyMessage="No consultations waiting on an outcome."
                pendingAppointmentId={recordOutcome.isPending ? recordOutcome.variables?.item.appointmentId : null}
                renderPatientLink={patientLink}
                // Only the procedures of this journey's own service; an empty slice falls back to a free-text label.
                getTreatmentOptions={(item) => (catalog.data ?? []).filter((d) => !!item.specialtyKey && d.specialtyKey === item.specialtyKey)}
                onRecord={(appointmentId, outcome, treatment) => {
                  const item = data.awaitingOutcome.find((i) => i.appointmentId === appointmentId);
                  if (!item) return;
                  setNotice(null);
                  recordOutcome.mutate({ item, outcome, treatment });
                }}
              />
              <p className="px-1 text-[11px] leading-4 text-ink-2">
                Outcomes here drive follow-up and treatment tracking{revenueTracking ? " and revenue" : ""}. Clinical notes and prescriptions stay in your hospital&rsquo;s clinical system.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
            <DoctorTodayList
              items={data.treatmentFollowUps}
              title="Treatment follow-up"
              emptyMessage="No treatment follow-ups due."
              showStatus={false}
              renderPatientLink={patientLink}
              testId="doctor-treatment-follow-up"
            />
            <DoctorTodayList
              items={data.postCare}
              title="Post-care reviews"
              emptyMessage="No post-care reviews due."
              showStatus={false}
              renderPatientLink={patientLink}
              testId="doctor-post-care"
            />
          </div>

          <RecentPatientsList items={data.recentPatients} renderPatientLink={patientLink} />
        </div>
      )}
    </div>
  );
}
