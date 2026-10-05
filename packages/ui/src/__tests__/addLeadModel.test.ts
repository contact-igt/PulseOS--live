import { describe, expect, it } from "vitest";
import type { CrmOutcomeVm } from "@pulseos/types";
import { LEAD_ERROR_COPY, LEAD_CHANNEL_OPTIONS, nextStepAvailability, reconcileNextStep, saveReadiness, toCreateLeadInput, type LeadFormValues } from "../addLeadModel";

const outcome = (over: Partial<CrmOutcomeVm>): CrmOutcomeVm => ({ id: "o1", key: "interested", label: "Interested", stage: "contacted", requiresFollowUp: false, allowsAppointment: true, asksReason: false, followUpType: "FOLLOW_UP", sortOrder: 0, archived: false, ...over });
const NOW = "2026-10-02T15:00"; // hospital wall time

const form = (over: Partial<LeadFormValues> = {}): LeadFormValues => ({
  phone: "98450 61122", name: "Kavitha", age: "", dateOfBirth: "", specialtyKey: "CATARACT", journeyType: "Cataract", branchId: "b1", sourceKey: "instagram", channel: "INSTAGRAM_DM",
  outcomeKey: "", outcomeReason: "", nextStep: "none", callbackDate: "2026-10-03", callbackTime: "11:00", callbackOwner: "", callbackNote: "",
  apptDate: "2026-10-03", apptTime: "10:00", apptDoctorId: "", apptBranchId: "", apptNote: "", followUpDate: "2026-10-03", followUpTime: "10:00", followUpNote: "",
  callEnabled: false, callDirection: "inbound", callConnected: true, callMinutes: "", callNote: "",
  email: "", preferredLanguage: "", doctorId: "", campaignId: "", ownerId: "", priority: "normal", notes: "", customFieldValues: {}, patientId: undefined, ...over,
});

describe("channel options", () => {
  it("offers only channels staff can honestly record by hand — never IVR (that comes from the phone system)", () => {
    expect(LEAD_CHANNEL_OPTIONS.map((c) => c.key)).toEqual(["MANUAL_CALL", "WHATSAPP", "INSTAGRAM_DM", "FACEBOOK_DM", "WALK_IN"]);
    expect(LEAD_CHANNEL_OPTIONS.find((c) => c.key === "MANUAL_CALL")!.label).toBe("Phone call");
  });
});

describe("nextStepAvailability — what each outcome allows", () => {
  it("no outcome: everything is open", () => expect(nextStepAvailability(undefined)).toMatchObject({ callback: true, follow_up: true, appointment: true, none: true }));
  it("an outcome that allows appointments keeps them", () => expect(nextStepAvailability(outcome({}))).toMatchObject({ appointment: true, none: true }));
  it("an outcome that does not allow appointments closes that option, with a reason", () => {
    const a = nextStepAvailability(outcome({ allowsAppointment: false }));
    expect(a.appointment).toBe(false);
    expect(a.hint).toMatch(/appointment/i);
  });
  it("an outcome that requires a follow-up allows only callback / general follow-up", () => {
    expect(nextStepAvailability(outcome({ requiresFollowUp: true, allowsAppointment: false }))).toMatchObject({ callback: true, follow_up: true, appointment: false, none: false });
  });
  it("a lost outcome takes no next step", () => expect(nextStepAvailability(outcome({ stage: "lost", allowsAppointment: false }))).toMatchObject({ callback: false, follow_up: false, appointment: false, none: true }));
});

describe("reconcileNextStep", () => {
  it("keeps a valid choice and moves an invalid one to the nearest allowed", () => {
    expect(reconcileNextStep("appointment", outcome({}))).toBe("appointment");
    expect(reconcileNextStep("appointment", outcome({ requiresFollowUp: true, allowsAppointment: false }))).toBe("callback");
    expect(reconcileNextStep("none", outcome({ requiresFollowUp: true, allowsAppointment: false }))).toBe("callback");
    expect(reconcileNextStep("callback", outcome({ stage: "lost", allowsAppointment: false }))).toBe("none");
    expect(reconcileNextStep("appointment", undefined)).toBe("appointment");
  });
});

describe("saveReadiness", () => {
  const ctx = { nowLocal: NOW, requiredFieldKeys: [] as string[], hasAppointmentDoctors: true };
  it("phone, service, source and branch are what a lead needs", () => {
    expect(saveReadiness(form(), ctx).ok).toBe(true);
    expect(saveReadiness(form({ phone: "" }), ctx).ok).toBe(false);
    expect(saveReadiness(form({ specialtyKey: "" }), ctx).ok).toBe(false);
    expect(saveReadiness(form({ sourceKey: "" }), ctx).ok).toBe(false);
    expect(saveReadiness(form({ branchId: "" }), ctx).ok).toBe(false);
  });
  it("a callback needs a future date and time", () => {
    expect(saveReadiness(form({ nextStep: "callback" }), ctx).ok).toBe(true);
    const past = saveReadiness(form({ nextStep: "callback", callbackDate: "2026-10-01" }), ctx);
    expect(past.ok).toBe(false);
    expect(past.reasons.join(" ")).toMatch(/future/i);
    expect(saveReadiness(form({ nextStep: "callback", callbackTime: "" }), ctx).ok).toBe(false);
  });
  it("an appointment needs a doctor and a future date and time", () => {
    expect(saveReadiness(form({ nextStep: "appointment", apptDoctorId: "" }), ctx).ok).toBe(false);
    expect(saveReadiness(form({ nextStep: "appointment", apptDoctorId: "d1" }), ctx).ok).toBe(true);
    expect(saveReadiness(form({ nextStep: "appointment", apptDoctorId: "d1", apptDate: "2026-10-02", apptTime: "09:00" }), ctx).ok).toBe(false);
  });
  it("an outcome that requires a follow-up cannot save without callback / follow-up details", () => {
    const o = outcome({ requiresFollowUp: true, allowsAppointment: false });
    expect(saveReadiness(form({ outcomeKey: "needs_callback", nextStep: "none" }), { ...ctx, outcome: o }).ok).toBe(false);
    expect(saveReadiness(form({ outcomeKey: "needs_callback", nextStep: "callback" }), { ...ctx, outcome: o }).ok).toBe(true);
  });
  it("required tenant fields must be filled", () => {
    const c = { ...ctx, requiredFieldKeys: ["eye_side"] };
    expect(saveReadiness(form({ customFieldValues: {} }), c).ok).toBe(false);
    expect(saveReadiness(form({ customFieldValues: { eye_side: "Left" } }), c).ok).toBe(true);
  });
});

describe("toCreateLeadInput", () => {
  const ctx = { normalizeFields: (v: Record<string, unknown>) => v };
  it("sends hospital wall times and only the details that apply", () => {
    const callback = toCreateLeadInput(form({ nextStep: "callback", callbackNote: " ring after lunch ", callbackOwner: "u1", outcomeKey: "needs_callback" }), ctx);
    expect(callback).toMatchObject({ phone: "98450 61122", name: "Kavitha", sourceKey: "instagram", channel: "INSTAGRAM_DM", outcomeKey: "needs_callback", nextStep: { kind: "callback", dueAt: "2026-10-03T11:00", assignedTo: "u1", note: "ring after lunch" } });
    expect(callback.followUp).toBeUndefined();
    const appt = toCreateLeadInput(form({ nextStep: "appointment", apptDoctorId: "d1", apptBranchId: "b2", apptNote: "Check-up" }), ctx);
    expect(appt.nextStep).toEqual({ kind: "appointment", scheduledAt: "2026-10-03T10:00", doctorId: "d1", branchId: "b2", note: "Check-up" });
    expect(toCreateLeadInput(form({ nextStep: "none" }), ctx).nextStep).toEqual({ kind: "none" });
    expect(toCreateLeadInput(form({ nextStep: "follow_up", followUpNote: "" }), ctx).nextStep).toEqual({ kind: "follow_up", dueAt: "2026-10-03T10:00" });
  });
  it("name, age and the rest are optional and omitted when blank; age becomes a number", () => {
    const i = toCreateLeadInput(form({ name: "  ", age: "42", email: "", notes: "" }), ctx);
    expect(i.name).toBeUndefined();
    expect(i.age).toBe(42);
    expect(i.email).toBeUndefined();
    expect(i.notes).toBeUndefined();
  });
  it("call details only go with a phone enquiry that asked for them", () => {
    const on = toCreateLeadInput(form({ channel: "MANUAL_CALL", callEnabled: true, callDirection: "outbound", callConnected: true, callMinutes: "2", callNote: "Asked cost" }), ctx);
    expect(on.call).toEqual({ direction: "outbound", connected: true, durationSeconds: 120, note: "Asked cost" });
    expect(toCreateLeadInput(form({ channel: "WALK_IN", callEnabled: true }), ctx).call).toBeUndefined();
    expect(toCreateLeadInput(form({ channel: "MANUAL_CALL", callEnabled: false }), ctx).call).toBeUndefined();
    expect(toCreateLeadInput(form({ channel: "MANUAL_CALL", callEnabled: true, callConnected: false, callMinutes: "5" }), ctx).call).toMatchObject({ connected: false, durationSeconds: undefined });
  });
  it("the outcome reason is sent only when one was typed", () => {
    expect(toCreateLeadInput(form({ outcomeKey: "not_interested", outcomeReason: " too far " }), ctx)).toMatchObject({ outcomeKey: "not_interested", outcomeReason: "too far" });
    expect(toCreateLeadInput(form({ outcomeKey: "" }), ctx).outcomeKey).toBeUndefined();
  });
});

describe("error copy tells the person what to change", () => {
  it("covers every step refusal with a plain sentence", () => {
    for (const code of ["appointment_time_in_past", "resource_unavailable", "doctor_not_found", "branch_not_found", "due_in_past", "assignee_invalid", "follow_up_required", "outcome_closes_journey", "outcome_disallows_appointment", "missing_required_fields", "type_invalid"]) {
      expect(LEAD_ERROR_COPY[code], code).toMatch(/\w/);
    }
    expect(LEAD_ERROR_COPY.resource_unavailable).toBe("This doctor already has another appointment at this time. Choose a different time or doctor.");
    expect(LEAD_ERROR_COPY.appointment_time_in_past).toBe("Choose a future appointment time.");
  });
});
