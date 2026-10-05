import { describe, expect, it } from "vitest";
import type { OperationsKpis } from "@pulseos/types";
import { attendanceRate, consultationRate, followUpCompletionRate, noShowRate, drillDay } from "../opsMath";

const k = (over: Partial<OperationsKpis> = {}): OperationsKpis => ({
  newEnquiries: 10, uncontacted: 1, noResponse: 0, followUpsDue: 4, followUpsOverdue: 1, followUpsCompleted: 6, appointmentsBooked: 8, appointmentsScheduled: 10, appointmentsAttended: 6,
  appointmentsNoShow: 2, appointmentsCancelled: 2, proceduresScheduled: 3, proceduresCompleted: 2, proceduresCompletedUndated: 0, consultationsCompleted: 5, converted: 2, conversionRate: 0.2, ...over,
});

describe("analytics rates use the right denominators", () => {
  it("attendance and no-show rates exclude cancelled visits (a cancelled visit was never expected)", () => {
    expect(attendanceRate(k())).toBeCloseTo(6 / 8);
    expect(noShowRate(k())).toBeCloseTo(2 / 8);
  });
  it("consultations are measured against patients who checked in", () => expect(consultationRate(k())).toBeCloseTo(5 / 6));
  it("follow-up completion = completed ÷ (completed + still due)", () => expect(followUpCompletionRate(k())).toBeCloseTo(6 / 10));
  it("no denominator, no rate (never 0% or NaN)", () => {
    expect(attendanceRate(k({ appointmentsScheduled: 2, appointmentsCancelled: 2 }))).toBeNull();
    expect(noShowRate(k({ appointmentsScheduled: 0, appointmentsCancelled: 0, appointmentsNoShow: 0 }))).toBeNull();
    expect(consultationRate(k({ appointmentsAttended: 0, consultationsCompleted: 0 }))).toBeNull();
    expect(followUpCompletionRate(k({ followUpsDue: 0, followUpsCompleted: 0 }))).toBeNull();
  });
});

describe("drillDay", () => {
  it("turns one day into a one-day custom range", () => expect(drillDay("2026-10-02")).toEqual({ range: "custom", from: "2026-10-02", to: "2026-10-02" }));
});
