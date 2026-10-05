import type { ReactNode } from "react";
import type { AppointmentStatus, DoctorDashboard, DoctorNextPatient, DoctorRecentPatient, DoctorTodayItem } from "@pulseos/types";
import { Badge, Card, EmptyState, Panel, SectionHeading } from "./primitives";
import { SegmentedRadial } from "./SegmentedRadial";
import { MetricStrip } from "./MetricStrip";
import { APPOINTMENT_STATUS_LABEL as STATUS_LABEL, APPOINTMENT_STATUS_TONE as STATUS_TONE } from "./status";
import { fmtDate, fmtTime, hospitalDaysAgo } from "./format";

export function DoctorKpiStrip({ dashboard }: { dashboard: DoctorDashboard }) {
  return (
    <MetricStrip
      testId="doctor-kpi-strip"
      cells={[
        { key: "appointments", label: "Appointments today", value: dashboard.todayCount },
        { key: "checked_in", label: "Checked in", value: dashboard.checkedInCount },
        { key: "waiting", label: "Waiting", value: dashboard.waitingNow },
        { key: "with_me", label: "With me", value: dashboard.withMeCount },
        { key: "outcomes_pending", label: "Outcomes pending", value: dashboard.awaitingOutcome.length },
        { key: "follow_ups", label: "Follow-ups due", value: dashboard.treatmentFollowUps.length },
      ]}
    />
  );
}

export function DoctorFlowRadial({ dashboard }: { dashboard: DoctorDashboard }) {
  const scheduledCount = dashboard.todayCount;
  const seenCount = dashboard.today.filter((i) => i.status === "with_doctor" || i.status === "completed").length;
  const outcomeCount = dashboard.today.filter((i) => i.status === "completed").length - dashboard.awaitingOutcome.length;

  const segments = [
    { key: "scheduled", label: "Scheduled", count: scheduledCount, pct: 100, color: "var(--color-neutral-300)" },
    { key: "checked_in", label: "Checked In", count: dashboard.checkedInCount, pct: scheduledCount > 0 ? Math.round((dashboard.checkedInCount / scheduledCount) * 100) : 0, color: "var(--color-chart-amber)" },
    { key: "seen", label: "Seen", count: seenCount, pct: scheduledCount > 0 ? Math.round((seenCount / scheduledCount) * 100) : 0, color: "var(--color-chart-blue)" },
    { key: "outcome_recorded", label: "Outcome Recorded", count: Math.max(outcomeCount, 0), pct: scheduledCount > 0 ? Math.round((Math.max(outcomeCount, 0) / scheduledCount) * 100) : 0, color: "var(--color-primary-500)" },
  ];

  return (
    <SegmentedRadial
      title="Today's Patient Flow"
      subtitle={`${scheduledCount} scheduled`}
      segments={segments}
      // "Completion" here means the visit itself concluded (appointment
      // status reached completed) — a separate, earlier step than logging a
      // consultation outcome afterward. Named precisely so it doesn't read
      // as contradicting a 0% "Outcome Recorded" segment on the same ring.
      centerLabel="Visits Completed"
      centerValue={`${dashboard.completionPct}%`}
    />
  );
}

export function DoctorQuickStats({ dashboard }: { dashboard: DoctorDashboard }) {
  const cells = [
    { key: "awaiting_outcome", label: "Awaiting Outcome", value: dashboard.awaitingOutcome.length },
    { key: "treatment_follow_ups", label: "Treatment Follow-ups", value: dashboard.treatmentFollowUps.length },
    { key: "post_care", label: "Post-care Reviews", value: dashboard.postCare.length },
  ];
  return (
    <Card className="p-0">
      <div className="px-4 pt-3.5">
        <SectionHeading title="Quick Stats" />
      </div>
      <div className="grid grid-cols-3 divide-x divide-neutral-100">
        {cells.map((cell) => (
          <div key={cell.key} className="px-3 py-3 text-center">
            <span className="block text-xl font-semibold tabular-nums text-slate-900">{cell.value}</span>
            <span className="mt-0.5 block text-[11px] leading-tight text-neutral-500">{cell.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const isToday = (iso: string) => hospitalDaysAgo(iso) === 0;

type PatientLinkRenderer = (item: { patientId?: string; patientName: string }, children: ReactNode) => ReactNode;

/** The one patient the doctor is about to see: name, service, time and reason, with a link to Patient 360. */
export function NextPatientCard({
  patient,
  status,
  renderPatientLink,
}: {
  patient: DoctorNextPatient | null;
  status?: AppointmentStatus;
  renderPatientLink?: PatientLinkRenderer;
}) {
  return (
    <Panel title="Next patient" tone="info" data-testid="next-patient-card">
      {!patient ? (
        <EmptyState message="No one else is scheduled for today." />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="break-words text-base font-semibold tracking-tight text-ink">
              {renderPatientLink ? renderPatientLink(patient, patient.patientName) : patient.patientName}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <Badge tone="primary">{patient.journeyType}</Badge>
              {status && <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>}
              {patient.reason && <span className="min-w-0 break-words">{patient.reason}</span>}
            </p>
          </div>
          <div className="text-right">
            <span className="block text-xl font-semibold tabular-nums leading-none text-ink">{fmtTime(patient.appointmentTime)}</span>
            <span className="mt-1 block text-[11px] uppercase tracking-wide text-ink-2">Appointment</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function DoctorTodayList({
  items,
  title,
  highlightId,
  emptyMessage = "Nothing scheduled here right now.",
  showStatus = true,
  renderPatientLink,
  renderActions,
  testId,
}: {
  items: DoctorTodayItem[];
  title: string;
  highlightId?: string;
  emptyMessage?: string;
  /** Every row in this list shares the same appointment status by
   * construction (e.g. "Awaiting Outcome" is only ever completed visits) —
   * repeating that status badge on every row doesn't distinguish anything
   * and reads as contradicting the list's own title. Only "Today's Patient
   * Queue", where status genuinely varies row to row, wants it shown. */
  showStatus?: boolean;
  /** Wrap the patient name in a link (the package is router-free, so the page supplies its own Link). */
  renderPatientLink?: PatientLinkRenderer;
  /** Row-level actions (e.g. "Consultation done" for a patient who is with the doctor). The package stays router/API-free. */
  renderActions?: (item: DoctorTodayItem) => ReactNode;
  testId?: string;
}) {
  return (
    <Panel title={title} subtitle={`${items.length}`} padded={false} data-testid={testId}>
      {items.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const isNext = item.appointmentId === highlightId;
            const name = <span className={`min-w-0 break-words text-sm ${isNext ? "font-semibold text-primary-800" : "font-medium text-ink"}`}>{item.patientName}</span>;
            return (
              <li
                key={item.appointmentId}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 ${isNext ? "bg-surface-info" : ""}`}
                data-testid={isNext ? "next-patient-row" : undefined}
              >
                <span className="min-w-16 shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-2">{isToday(item.time) ? fmtTime(item.time) : `${fmtDate(item.time)}, ${fmtTime(item.time)}`}</span>
                <span className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-2 gap-y-1">
                  {renderPatientLink ? renderPatientLink(item, name) : name}
                  {isNext && <Badge tone="primary">Next</Badge>}
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {item.journeyType && <Badge tone="neutral">{item.journeyType}</Badge>}
                  {showStatus && <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>}
                </span>
                {renderActions?.(item)}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export const AwaitingOutcomeList = DoctorTodayList;

export function RecentPatientsList({ items, renderPatientLink }: { items: DoctorRecentPatient[]; renderPatientLink?: PatientLinkRenderer }) {
  return (
    <Panel title="Recent patients" subtitle={`${items.length}`} padded={false} data-testid="recent-patients">
      {items.length === 0 ? (
        <EmptyState message="No recent visits yet" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const name = <span className="block min-w-0 break-words text-sm font-medium text-ink">{item.patientName}</span>;
            return (
              <li key={item.appointmentId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  {renderPatientLink ? renderPatientLink(item, name) : name}
                  <span className="block text-xs text-ink-2">{item.journeyType}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-ink-2">{fmtDate(item.time)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
