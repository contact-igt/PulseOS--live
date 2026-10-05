import { describe, expect, it } from "vitest";
import type { ClinicHours, CrmOutcomeVm } from "@pulseos/types";
import { buildInlineAppointment, appointmentSaveLabel, initialInlineAppointment } from "../inlineAppointment";
import { buildLogInput, type LogState } from "@/components/outcomes/outcomeForm";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-01T12:00:00.000Z"); // 17:30 IST, a Thursday
const day: [string, string] = ["09:00", "16:00"];
const HOURS: ClinicHours = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: null };
const interested = { id: "o1", key: "interested", label: "Interested", stage: "contacted", requiresFollowUp: false, allowsAppointment: true, asksReason: false, followUpType: "FOLLOW_UP", sortOrder: 1, archived: false } as CrmOutcomeVm;
const needsReports = { ...interested, id: "o2", key: "needs_reports", requiresFollowUp: true, allowsAppointment: true } as CrmOutcomeVm;
const price = { ...interested, id: "o3", key: "price_enquiry", allowsAppointment: false } as CrmOutcomeVm;

describe("inline appointment (shared by Log Call and Log outcome)", () => {
  it("starts tomorrow, no time yet, confirmed", () => {
    expect(initialInlineAppointment(NOW, TZ)).toEqual({ apptDate: "2026-10-02", apptTime: "", apptDoctorId: "", apptBranchId: "", apptConfirmed: true });
  });
  it("builds an instant in the hospital's clock; refuses missing, closed, outside-hours and past times in plain words", () => {
    const base = { ...initialInlineAppointment(NOW, TZ), apptDate: "2026-10-07", apptTime: "11:30" }; // a Wednesday
    expect(buildInlineAppointment(base, TZ, NOW, HOURS)).toEqual({ input: { scheduledAt: "2026-10-07T06:00:00.000Z", confirmed: true } });
    expect(buildInlineAppointment({ ...base, apptTime: "" }, TZ, NOW, HOURS)).toEqual({ error: "Choose the appointment date and time." });
    expect(buildInlineAppointment({ ...base, apptDate: "2026-10-04" }, TZ, NOW, HOURS)).toHaveProperty("error", expect.stringContaining("closed on Sundays"));
    expect(buildInlineAppointment({ ...base, apptTime: "17:00" }, TZ, NOW, HOURS)).toHaveProperty("error", expect.stringContaining("09:00 and 16:00"));
    expect(buildInlineAppointment({ ...base, apptDate: "2026-10-01", apptTime: "10:00" }, TZ, NOW, null)).toEqual({ error: "That time has already passed. Choose a later time." });
  });
  it("the save button says what will happen", () => {
    expect(appointmentSaveLabel("call", true)).toBe("Save call & confirm appointment");
    expect(appointmentSaveLabel("outcome", false)).toBe("Save outcome & book appointment");
  });
});

describe("Log outcome can book the visit in the same save", () => {
  const state = (over: Partial<LogState> = {}): LogState => ({ note: "Patient called back and confirmed consultation.", reason: "", scheduleFollowUp: false, followUpLocal: "", fieldValues: {}, bookAppointment: true, appt: { ...initialInlineAppointment(NOW, TZ), apptDate: "2026-10-07", apptTime: "11:30" }, ...over });

  it("sends the visit and NO follow-up time (the visit is the next step), even for an outcome that normally needs a follow-up", () => {
    const built = buildLogInput(needsReports, state(), [], NOW, undefined, TZ, HOURS) as { input: { appointment?: unknown; followUpAt?: string } };
    expect(built.input.appointment).toEqual({ scheduledAt: "2026-10-07T06:00:00.000Z", confirmed: true });
    expect(built.input.followUpAt).toBeUndefined();
  });
  it("an outcome that does not allow a visit never sends one; the box is ignored", () => {
    const built = buildLogInput(price, state(), [], NOW, undefined, TZ, HOURS) as { input: { appointment?: unknown } };
    expect(built.input.appointment).toBeUndefined();
  });
  it("a bad time stops the save with the reason, before anything is sent", () => {
    expect(buildLogInput(interested, state({ appt: { ...initialInlineAppointment(NOW, TZ), apptDate: "2026-10-04", apptTime: "10:00" } }), [], NOW, undefined, TZ, HOURS)).toHaveProperty("error");
  });
  it("without booking, the follow-up behaviour is unchanged", () => {
    expect(buildLogInput(needsReports, state({ bookAppointment: false }), [], NOW, undefined, TZ)).toEqual({ error: "Choose when to follow up." });
  });
});
