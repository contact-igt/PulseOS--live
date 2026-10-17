import { describe, expect, it } from "vitest";
import type { AppointmentRow, JourneyDetailVm } from "@pulseos/types";
import { leadInsightRows } from "../insightRows";

const NOW = new Date("2026-10-17T06:30:00.000Z");
const appt = (over: Partial<AppointmentRow>): AppointmentRow => ({ id: "a", patientId: "p", patientName: "P", journeyId: "j", branchName: null, doctorId: "d", doctorName: null, status: "scheduled", scheduledAt: "2026-10-20T04:30:00.000Z", reason: null, ...over }) as AppointmentRow;
const detail = (over: { createdAt?: string; stage?: JourneyDetailVm["journey"]["stage"]; appointments?: AppointmentRow[] } = {}) =>
  ({ journey: { createdAt: over.createdAt ?? "2026-10-17T02:00:00.000Z", stage: over.stage ?? "enquiry" }, appointments: over.appointments ?? [] }) as unknown as JourneyDetailVm;

describe("leadInsightRows", () => {
  it("calls a lead made today 'Today' and counts whole days after that", () => {
    expect(leadInsightRows(detail(), NOW).ageLabel).toBe("Today");
    expect(leadInsightRows(detail({ createdAt: "2026-10-16T05:00:00.000Z" }), NOW).ageLabel).toBe("1 day");
    expect(leadInsightRows(detail({ createdAt: "2026-10-07T05:00:00.000Z" }), NOW).ageLabel).toBe("10 days");
  });

  it("names the stage", () => {
    expect(leadInsightRows(detail({ stage: "lost" }), NOW).stageLabel).toBe("Lost");
  });

  it("says when nothing is booked, and otherwise the count and the next visit", () => {
    expect(leadInsightRows(detail(), NOW).appointmentLabel).toBe("None booked");
    const rows = leadInsightRows(detail({ appointments: [appt({ id: "1", scheduledAt: "2026-10-25T04:30:00.000Z" }), appt({ id: "2", scheduledAt: "2026-10-20T04:30:00.000Z" }), appt({ id: "3", status: "cancelled", scheduledAt: "2026-10-18T04:30:00.000Z" })] }), NOW);
    expect(rows.appointmentLabel).toMatch(/^3 · next /);
    expect(rows.appointmentLabel).toContain("20 Oct");
  });

  it("does not offer a past or cancelled visit as the next one", () => {
    const rows = leadInsightRows(detail({ appointments: [appt({ scheduledAt: "2026-10-10T04:30:00.000Z", status: "completed" })] }), NOW);
    expect(rows.appointmentLabel).toBe("1 · none upcoming");
  });
});
