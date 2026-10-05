import type { AppointmentRow, JourneyDetailVm } from "@pulseos/types";
import { APPOINTMENT_STATUS_LABEL, TREATMENT_STATUS_LABEL, fmtDate, fmtDateTime, fmtTime } from "@pulseos/ui";

// Journey Progress: where this ONE enquiry stands, built from its real rows (appointments, treatments, next task) and never
// from the stage name alone, so it cannot claim a step happened that did not. Six steps, in the order a patient moves:
//   Enquiry -> Appointment -> Attendance -> Consultation -> Treatment -> Next action
// `current` marks the step that is waiting on someone right now; `problem` marks a step that went wrong (no-show, cancelled).

export type ProgressState = "done" | "current" | "pending" | "problem";
export type ProgressKey = "enquiry" | "appointment" | "attendance" | "consultation" | "treatment" | "next_action";

export interface ProgressStep {
  key: ProgressKey;
  label: string;
  state: ProgressState;
  detail: string;
  /** Emphasis for the detail text (overdue next action). */
  tone?: "danger";
}

type ProgressInput = Pick<JourneyDetailVm, "appointments" | "treatments"> & {
  journey: Pick<JourneyDetailVm["journey"], "createdAt" | "sourceLabel" | "source" | "stage" | "nextAction" | "nextTask" | "nextTaskBucket">;
};

const SOURCE_FALLBACK: Record<string, string> = { meta: "Meta", google: "Google", website: "Website", whatsapp: "WhatsApp", phone: "Phone", walk_in: "Walk-in", referral: "Referral", organic: "Organic", other: "Other" };
const IN_CLINIC = ["checked_in", "waiting", "with_doctor"];
const PENDING = ["requested", "scheduled", "confirmed"];
const ARRIVED = [...IN_CLINIC, "completed"];

const byTimeDesc = (a: AppointmentRow, b: AppointmentRow) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt) || a.id.localeCompare(b.id);

export function buildJourneyProgress(d: ProgressInput): ProgressStep[] {
  const appts = [...d.appointments].sort(byTimeDesc);
  const live = appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
  const pending = appts.find((a) => PENDING.includes(a.status));
  const inClinic = appts.find((a) => IN_CLINIC.includes(a.status));
  const completed = appts.find((a) => a.status === "completed");
  const arrived = appts.find((a) => ARRIVED.includes(a.status));
  // The latest visit that is over decides whether the patient came.
  const lastClosed = appts.find((a) => a.status === "completed" || a.status === "no_show" || a.status === "cancelled");

  const source = d.journey.sourceLabel ?? SOURCE_FALLBACK[d.journey.source] ?? d.journey.source;
  const steps: ProgressStep[] = [];

  steps.push({ key: "enquiry", label: "Enquiry", state: "done", detail: `${source} · ${fmtDate(d.journey.createdAt)}` });

  // Appointment: the visit that is booked (or was), or why there is none.
  const shown = pending ?? inClinic ?? completed ?? live[0];
  if (shown) steps.push({ key: "appointment", label: "Appointment", state: "done", detail: `${fmtDateTime(shown.scheduledAt)} · ${APPOINTMENT_STATUS_LABEL[shown.status]}` });
  else if (appts.some((a) => a.status === "cancelled") && !appts.some((a) => a.status === "no_show")) steps.push({ key: "appointment", label: "Appointment", state: "problem", detail: "Cancelled" });
  else if (appts.length > 0) steps.push({ key: "appointment", label: "Appointment", state: "done", detail: `${fmtDateTime(appts[0]!.scheduledAt)} · ${APPOINTMENT_STATUS_LABEL[appts[0]!.status]}` });
  else steps.push({ key: "appointment", label: "Appointment", state: "current", detail: "Not booked yet" });

  // Attendance: did the patient arrive?
  if (arrived && lastClosed?.status !== "no_show") {
    const at = arrived.checkedInAt ?? arrived.arrivedAt ?? null;
    steps.push({ key: "attendance", label: "Attendance", state: "done", detail: at ? `Checked in ${fmtTime(at)}` : "Arrived" });
  } else if (lastClosed?.status === "no_show" && !pending) steps.push({ key: "attendance", label: "Attendance", state: "problem", detail: "Did not arrive" });
  else steps.push({ key: "attendance", label: "Attendance", state: pending ? "current" : "pending", detail: pending ? "Waiting for the visit" : "—" });

  // Consultation.
  if (completed) steps.push({ key: "consultation", label: "Consultation", state: "done", detail: completed.completedAt ? `Completed ${fmtDateTime(completed.completedAt)}` : "Completed" });
  else if (inClinic?.status === "with_doctor") steps.push({ key: "consultation", label: "Consultation", state: "current", detail: "With the doctor now" });
  else if (inClinic) steps.push({ key: "consultation", label: "Consultation", state: "current", detail: inClinic.status === "waiting" ? "Waiting to be seen" : "Checked in, not yet seen" });
  else steps.push({ key: "consultation", label: "Consultation", state: "pending", detail: "—" });

  // Treatment: only what is actually recorded.
  if (d.treatments === null) steps.push({ key: "treatment", label: "Treatment", state: "pending", detail: "Not available for your role" });
  else if (d.treatments.length > 0) {
    // The furthest treatment along its path is the one that tells the story.
    const order = ["COMPLETED", "SCHEDULED", "ACCEPTED", "DECISION_PENDING", "ADVISED", "DECLINED", "CANCELLED", "LOST"];
    const t = [...d.treatments].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0]!;
    const done = t.status === "COMPLETED";
    steps.push({ key: "treatment", label: "Treatment", state: done ? "done" : t.status === "DECLINED" || t.status === "CANCELLED" || t.status === "LOST" ? "problem" : "current", detail: `${t.treatmentLabel} · ${TREATMENT_STATUS_LABEL[t.status]}` });
  } else steps.push({ key: "treatment", label: "Treatment", state: "pending", detail: completed ? "No treatment advised" : "—" });

  // Next action: straight from the open tasks.
  const next = d.journey.nextAction;
  if (next) steps.push({ key: "next_action", label: "Next action", state: "current", detail: `${next.label} · ${fmtDate(next.dueAt)}`, ...(d.journey.nextTaskBucket === "overdue" ? { tone: "danger" as const } : {}) });
  else if (pending) steps.push({ key: "next_action", label: "Next action", state: "current", detail: `Patient visit · ${fmtDateTime(pending.scheduledAt)}` });
  else steps.push({ key: "next_action", label: "Next action", state: "pending", detail: "None scheduled" });

  return steps;
}
