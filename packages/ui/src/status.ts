import type { AppointmentStatus, AttentionReason, CallStatus, ConnectorStatus, JourneyStage, OperationalStatusKey, TaskReason, TreatmentStatus } from "@pulseos/types";

// One display map per domain, shared across every table/badge/drawer that
// shows this status — never a raw backend enum in front of a user, and
// never a second near-identical copy of the same map in a different file.
export type Tone = "neutral" | "warning" | "danger" | "primary" | "success";

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  requested: "Requested",
  scheduled: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  waiting: "Waiting",
  with_doctor: "With doctor",
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, Tone> = {
  requested: "neutral",
  scheduled: "neutral",
  confirmed: "neutral",
  checked_in: "warning",
  waiting: "warning",
  with_doctor: "primary",
  completed: "success",
  no_show: "danger",
  cancelled: "neutral",
};

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  completed: "Completed",
  missed: "Missed",
  no_answer: "No Answer",
  busy: "Busy",
  failed: "Failed",
};

export const CALL_STATUS_TONE: Record<CallStatus, Tone> = {
  completed: "success",
  missed: "danger",
  no_answer: "warning",
  busy: "warning",
  failed: "danger",
};

export const TREATMENT_STATUS_LABEL: Record<TreatmentStatus, string> = {
  ADVISED: "Advised",
  DECISION_PENDING: "Decision Pending",
  ACCEPTED: "Accepted",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  LOST: "Lost",
};

export const TREATMENT_STATUS_TONE: Record<TreatmentStatus, Tone> = {
  ADVISED: "neutral",
  DECISION_PENDING: "warning",
  ACCEPTED: "primary",
  SCHEDULED: "primary",
  COMPLETED: "success",
  DECLINED: "danger",
  CANCELLED: "danger",
  LOST: "danger",
};

export const JOURNEY_STAGE_LABEL: Record<JourneyStage, string> = {
  enquiry: "Enquiry",
  contacted: "Contacted",
  booked: "Appointment Booked",
  attended: "Attended",
  consulted: "Consulted",
  treatment_advised: "Treatment Advised",
  scheduled: "Treatment Scheduled",
  completed: "Treatment Completed",
  lost: "Lost",
};

export const JOURNEY_STAGE_TONE: Partial<Record<JourneyStage, Tone>> = {
  enquiry: "neutral",
  contacted: "neutral",
  booked: "primary",
  attended: "primary",
  consulted: "primary",
  treatment_advised: "warning",
  scheduled: "warning",
  completed: "success",
  lost: "danger",
};

export const ATTENTION_REASON_LABEL: Record<AttentionReason, string> = {
  overdue_callback: "Overdue callback",
  missed_follow_up: "Missed follow-up",
  no_show: "No-show",
  high_intent_uncontacted: "High-intent, uncontacted",
  treatment_decision_pending: "Treatment decision pending",
};

// Why a Task exists (distinct from its `type`, which is what action it is).
// Shown as a small per-row badge on "My Work" so a telecaller can tell a
// brand-new enquiry apart from a missed-call recovery at a glance. Shares
// wording with ATTENTION_REASON_LABEL for the five reasons both cover, plus
// the two Task-only reasons (manual_task, new_lead).
export const TASK_REASON_LABEL: Record<TaskReason, string> = {
  overdue_callback: "Overdue callback",
  missed_follow_up: "Missed follow-up",
  no_show: "No-show",
  high_intent_uncontacted: "High-intent, uncontacted",
  treatment_decision_pending: "Treatment decision pending",
  manual_task: "Manual task",
  new_lead: "New enquiry",
};

export const TASK_REASON_TONE: Record<TaskReason, Tone> = {
  overdue_callback: "warning",
  missed_follow_up: "danger",
  no_show: "danger",
  high_intent_uncontacted: "primary",
  treatment_decision_pending: "warning",
  manual_task: "neutral",
  new_lead: "primary",
};

export const CONNECTOR_STATUS_LABEL: Record<ConnectorStatus, string> = {
  NOT_CONFIGURED: "Not configured",
  CONNECTING: "Connecting",
  CONNECTED: "Connected",
  DEGRADED: "Degraded",
  ERROR: "Error",
  DISABLED: "Disabled",
};

export const CONNECTOR_STATUS_TONE: Record<ConnectorStatus, Tone> = {
  NOT_CONFIGURED: "neutral",
  CONNECTING: "warning",
  CONNECTED: "success",
  DEGRADED: "warning",
  ERROR: "danger",
  DISABLED: "neutral",
};

export const CONNECTOR_EVENT_STATUS_LABEL: Record<string, string> = {
  processed: "Processed",
  failed: "Failed",
  duplicate: "Duplicate",
  pending: "Pending",
};

export const CONNECTOR_EVENT_STATUS_TONE: Record<string, Tone> = {
  processed: "success",
  failed: "danger",
  duplicate: "warning",
  pending: "neutral",
};

/** The derived operational status (see deriveOperationalStatus): where the patient is right now. Amber/red only for waiting and no-show. */
export const OPERATIONAL_STATUS_LABEL: Record<OperationalStatusKey, string> = {
  appointment_booked: "Appointment booked",
  appointment_confirmed: "Appointment confirmed",
  checked_in: "Checked in",
  waiting: "Waiting",
  with_doctor: "With doctor",
  consultation_completed: "Consultation completed",
  treatment_follow_up: "Treatment follow-up",
  procedure_scheduled: "Procedure scheduled",
  procedure_done: "Procedure done",
  no_show: "No-show",
  cancelled: "Cancelled",
  closed: "Closed",
};

export const OPERATIONAL_STATUS_TONE: Record<OperationalStatusKey, Tone> = {
  appointment_booked: "neutral",
  appointment_confirmed: "primary",
  checked_in: "warning",
  waiting: "warning",
  with_doctor: "primary",
  consultation_completed: "success",
  treatment_follow_up: "primary",
  procedure_scheduled: "primary",
  procedure_done: "success",
  no_show: "danger",
  cancelled: "neutral",
  closed: "neutral",
};
