import { describe, expect, it } from "vitest";
import { OPERATIONAL_STATUS_KEYS, deriveOperationalStatus, type AppointmentStatus, type JourneyStage, type OperationalStatusInput, type TreatmentStatus } from "@pulseos/types";

// The operational status is a DERIVED label over the canonical data (journey stage, appointments, treatment, tasks). It
// is never stored and never competes with the stages: these tests pin its precedence so the same facts always give the
// same answer, in any input order.

const appt = (status: AppointmentStatus, at = "2026-10-03T10:00:00.000Z") => ({ status, scheduledAt: at });
const input = (over: Partial<OperationalStatusInput> = {}): OperationalStatusInput => ({ stage: "contacted", appointments: [], treatments: [], openTaskTypes: [], ...over });
const status = (over: Partial<OperationalStatusInput> = {}) => deriveOperationalStatus(input(over));
const tx = (s: TreatmentStatus) => ({ status: s });

describe("deriveOperationalStatus", () => {
  it("has nothing to say before there is an appointment or a treatment (the lead status covers that)", () => {
    expect(status()).toBeNull();
    expect(status({ stage: "enquiry" })).toBeNull();
  });

  it("a booked visit is Appointment booked; once it is confirmed it is Appointment confirmed", () => {
    expect(status({ stage: "booked", appointments: [appt("scheduled")] })).toBe("appointment_booked");
    expect(status({ stage: "booked", appointments: [appt("requested")] })).toBe("appointment_booked");
    expect(status({ stage: "booked", appointments: [appt("confirmed")] })).toBe("appointment_confirmed");
  });

  it("an arrival moves through Checked in -> Waiting -> With doctor", () => {
    expect(status({ stage: "attended", appointments: [appt("checked_in")] })).toBe("checked_in");
    expect(status({ stage: "attended", appointments: [appt("waiting")] })).toBe("waiting");
    expect(status({ stage: "attended", appointments: [appt("with_doctor")] })).toBe("with_doctor");
  });

  it("a visit in the clinic outranks everything else on the journey, the furthest step first", () => {
    const ctx = { stage: "attended" as JourneyStage, treatments: [tx("SCHEDULED")], appointments: [appt("scheduled", "2026-10-09T10:00:00.000Z")] };
    expect(status({ ...ctx, appointments: [...ctx.appointments, appt("checked_in")] })).toBe("checked_in");
    expect(status({ ...ctx, appointments: [...ctx.appointments, appt("checked_in"), appt("with_doctor")] })).toBe("with_doctor");
    expect(status({ ...ctx, appointments: [...ctx.appointments, appt("waiting"), appt("checked_in")] })).toBe("waiting");
  });

  it("a completed consultation with nothing further is Consultation completed", () => {
    expect(status({ stage: "consulted", appointments: [appt("completed")] })).toBe("consultation_completed");
  });

  it("an open treatment decision is Treatment follow-up, whichever way it was recorded", () => {
    for (const t of ["ADVISED", "DECISION_PENDING", "ACCEPTED"] as TreatmentStatus[]) {
      expect(status({ stage: "treatment_advised", appointments: [appt("completed")], treatments: [tx(t)] }), t).toBe("treatment_follow_up");
    }
    // A treatment-decision / surgery task with no treatment row yet still reads as follow-up after a completed visit.
    expect(status({ stage: "consulted", appointments: [appt("completed")], openTaskTypes: ["TREATMENT_DECISION"] })).toBe("treatment_follow_up");
  });

  it("a declined, cancelled or lost treatment is not an open decision", () => {
    for (const t of ["DECLINED", "CANCELLED", "LOST"] as TreatmentStatus[]) {
      expect(status({ stage: "consulted", appointments: [appt("completed")], treatments: [tx(t)] }), t).toBe("consultation_completed");
    }
  });

  it("a scheduled procedure outranks a booked review visit and an open decision; a finished one is Procedure done", () => {
    expect(status({ stage: "scheduled", appointments: [appt("completed"), appt("scheduled", "2026-10-20T10:00:00.000Z")], treatments: [tx("SCHEDULED")] })).toBe("procedure_scheduled");
    expect(status({ stage: "completed", appointments: [appt("completed")], treatments: [tx("COMPLETED")] })).toBe("procedure_done");
    expect(status({ stage: "scheduled", appointments: [appt("completed")], treatments: [tx("ADVISED"), tx("SCHEDULED")] })).toBe("procedure_scheduled");
  });

  it("a booked visit beats an open decision (the next concrete thing is the visit)", () => {
    expect(status({ stage: "treatment_advised", appointments: [appt("completed"), appt("scheduled", "2026-10-12T10:00:00.000Z")], treatments: [tx("ADVISED")] })).toBe("appointment_booked");
  });

  it("a missed visit is No-show until a new visit is booked, then it is booked again", () => {
    expect(status({ stage: "booked", appointments: [appt("no_show")] })).toBe("no_show");
    expect(status({ stage: "booked", appointments: [appt("no_show", "2026-10-01T10:00:00.000Z"), appt("scheduled", "2026-10-08T10:00:00.000Z")] })).toBe("appointment_booked");
  });

  it("a cancelled visit is Cancelled until a new visit is booked", () => {
    expect(status({ stage: "booked", appointments: [appt("cancelled")] })).toBe("cancelled");
    expect(status({ stage: "booked", appointments: [appt("cancelled", "2026-10-01T10:00:00.000Z"), appt("confirmed", "2026-10-08T10:00:00.000Z")] })).toBe("appointment_confirmed");
  });

  it("the most recent closed visit decides between completed, no-show and cancelled", () => {
    expect(status({ stage: "consulted", appointments: [appt("no_show", "2026-09-20T10:00:00.000Z"), appt("completed", "2026-10-01T10:00:00.000Z")] })).toBe("consultation_completed");
    expect(status({ stage: "booked", appointments: [appt("completed", "2026-09-20T10:00:00.000Z"), appt("no_show", "2026-10-01T10:00:00.000Z")] })).toBe("no_show");
  });

  it("a closed (lost) journey is Closed, whatever else is recorded", () => {
    expect(status({ stage: "lost", appointments: [appt("no_show")] })).toBe("closed");
    expect(status({ stage: "lost", appointments: [appt("with_doctor")], treatments: [tx("SCHEDULED")] })).toBe("closed");
  });

  it("gives the same answer whatever order the facts arrive in", () => {
    const appointments = [appt("completed", "2026-09-01T10:00:00.000Z"), appt("no_show", "2026-09-10T10:00:00.000Z"), appt("cancelled", "2026-09-20T10:00:00.000Z"), appt("scheduled", "2026-10-30T10:00:00.000Z")];
    const treatments = [tx("DECLINED"), tx("ADVISED")];
    const base = status({ stage: "booked", appointments, treatments });
    for (let i = 0; i < 12; i++) {
      const shuffle = <T,>(a: T[]) => [...a].sort(() => Math.random() - 0.5);
      expect(status({ stage: "booked", appointments: shuffle(appointments), treatments: shuffle(treatments) })).toBe(base);
    }
  });

  it("accepts dates as strings or Date objects", () => {
    expect(status({ stage: "booked", appointments: [{ status: "no_show", scheduledAt: new Date("2026-10-01T10:00:00Z") }, { status: "completed", scheduledAt: "2026-09-01T10:00:00.000Z" }] })).toBe("no_show");
  });

  it("every key has a stable, unique name", () => {
    expect(new Set(OPERATIONAL_STATUS_KEYS).size).toBe(OPERATIONAL_STATUS_KEYS.length);
    expect(OPERATIONAL_STATUS_KEYS).toEqual([
      "appointment_booked", "appointment_confirmed", "checked_in", "waiting", "with_doctor", "consultation_completed",
      "treatment_follow_up", "procedure_scheduled", "procedure_done", "no_show", "cancelled", "closed",
    ]);
  });
});
