import { JOURNEY_STAGE_LABEL, fmtDateTime, hospitalDaysAgo } from "@pulseos/ui";
import type { JourneyDetailVm } from "@pulseos/types";

export interface LeadInsightRows {
  stageLabel: string;
  ageLabel: string;
  appointmentLabel: string;
}

/** The Insights tab's derived lines: all from the journey's own record, in the hospital's calendar. */
export function leadInsightRows(detail: JourneyDetailVm, now: Date): LeadInsightRows {
  const days = Math.max(0, hospitalDaysAgo(detail.journey.createdAt, now));
  const ageLabel = days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;

  const booked = detail.appointments;
  const upcoming = booked
    .filter((a) => a.status !== "cancelled" && a.status !== "no_show" && a.status !== "completed" && new Date(a.scheduledAt).getTime() >= now.getTime())
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
  const appointmentLabel = booked.length === 0 ? "None booked" : upcoming ? `${booked.length} · next ${fmtDateTime(upcoming.scheduledAt)}` : `${booked.length} · none upcoming`;

  return { stageLabel: JOURNEY_STAGE_LABEL[detail.journey.stage] ?? detail.journey.stage, ageLabel, appointmentLabel };
}
