import { describe, expect, it } from "vitest";
import type { AppointmentRow, JourneyDetailVm, TreatmentRow } from "@pulseos/types";
import { buildJourneyProgress } from "../progressSteps";

// Journey Progress is built from the journey's real rows - never from the stage name alone - so it can never claim a
// step happened that did not.

type Detail = Pick<JourneyDetailVm, "appointments" | "treatments"> & { journey: Pick<JourneyDetailVm["journey"], "createdAt" | "sourceLabel" | "source" | "stage" | "nextAction" | "nextTask" | "nextTaskBucket"> };

const appt = (over: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id: "a1", patientId: "p", patientName: "P", journeyId: "j", branchName: null, doctorId: "d", doctorName: "Dr. Meera Shah", status: "scheduled",
  scheduledAt: "2026-10-12T05:00:00.000Z", reason: null, ...over,
});
const treatment = (over: Partial<TreatmentRow> = {}): TreatmentRow => ({ id: "t1", treatmentLabel: "Cataract Surgery", status: "ADVISED", estimatedValue: 0, ...over }) as TreatmentRow;
const detail = (over: Omit<Partial<Detail>, "journey"> & { journey?: Partial<Detail["journey"]> } = {}): Detail => ({
  appointments: [],
  treatments: [],
  ...over,
  journey: { createdAt: "2026-10-03T04:00:00.000Z", sourceLabel: "Google", source: "google", stage: "enquiry", nextAction: null, nextTask: null, nextTaskBucket: null, ...over.journey },
});
const byKey = (d: Detail) => Object.fromEntries(buildJourneyProgress(d).map((s) => [s.key, s]));

describe("buildJourneyProgress", () => {
  it("always lists the six steps in order", () => {
    expect(buildJourneyProgress(detail()).map((s) => s.key)).toEqual(["enquiry", "appointment", "attendance", "consultation", "treatment", "next_action"]);
  });

  it("a fresh enquiry: the enquiry is done (with its ORIGINAL source), the appointment is the current step, the rest wait", () => {
    const s = byKey(detail());
    expect(s.enquiry).toMatchObject({ state: "done" });
    expect(s.enquiry!.detail).toContain("Google");
    expect(s.appointment).toMatchObject({ state: "current", detail: "Not booked yet" });
    for (const k of ["attendance", "consultation", "treatment"]) expect(s[k]!.state, k).toBe("pending");
    expect(s.next_action).toMatchObject({ state: "pending", detail: "None scheduled" });
  });

  it("a booked visit: the appointment is done with its date and state, attendance is current", () => {
    const s = byKey(detail({ appointments: [appt({ status: "confirmed" })] }));
    expect(s.appointment!.state).toBe("done");
    expect(s.appointment!.detail).toMatch(/12 Oct/);
    expect(s.appointment!.detail).toMatch(/Confirmed/);
    expect(s.attendance!.state).toBe("current");
  });

  it("an arrival: attendance is done with the check-in time, the consultation is current", () => {
    const s = byKey(detail({ appointments: [appt({ status: "waiting", checkedInAt: "2026-10-12T04:40:00.000Z" })] }));
    expect(s.attendance).toMatchObject({ state: "done" });
    expect(s.attendance!.detail).toMatch(/10:10/);
    expect(s.consultation!.state).toBe("current");
  });

  it("with the doctor: the consultation is under way", () => {
    const s = byKey(detail({ appointments: [appt({ status: "with_doctor", checkedInAt: "2026-10-12T04:40:00.000Z" })] }));
    expect(s.consultation).toMatchObject({ state: "current", detail: "With the doctor now" });
  });

  it("a completed consultation: done, and the treatment step shows what was advised", () => {
    const s = byKey(detail({ appointments: [appt({ status: "completed", checkedInAt: "2026-10-12T04:40:00.000Z", completedAt: "2026-10-12T05:30:00.000Z" })], treatments: [treatment({ status: "ADVISED" })] }));
    expect(s.consultation!.state).toBe("done");
    expect(s.treatment!.detail).toMatch(/Cataract Surgery/);
    expect(s.treatment!.detail).toMatch(/Advised/);
    expect(s.treatment!.state).toBe("current");
  });

  it("a scheduled procedure is marked, a completed one is done", () => {
    const base = { appointments: [appt({ status: "completed", checkedInAt: "2026-10-12T04:40:00.000Z" })] };
    expect(byKey(detail({ ...base, treatments: [treatment({ status: "SCHEDULED" })] })).treatment!.detail).toMatch(/Scheduled/);
    expect(byKey(detail({ ...base, treatments: [treatment({ status: "COMPLETED" })] })).treatment!.state).toBe("done");
  });

  it("a completed consultation with no treatment says so plainly", () => {
    const s = byKey(detail({ appointments: [appt({ status: "completed", checkedInAt: "2026-10-12T04:40:00.000Z" })], treatments: [] }));
    expect(s.treatment).toMatchObject({ state: "pending", detail: "No treatment advised" });
  });

  it("a no-show is a problem on attendance, never a fake arrival; the consultation did not happen", () => {
    const s = byKey(detail({ journey: { stage: "booked" }, appointments: [appt({ status: "no_show" })] }));
    expect(s.attendance).toMatchObject({ state: "problem", detail: "Did not arrive" });
    expect(s.consultation!.state).toBe("pending");
  });

  it("a cancelled visit is a problem on the appointment step", () => {
    const s = byKey(detail({ appointments: [appt({ status: "cancelled" })] }));
    expect(s.appointment).toMatchObject({ state: "problem", detail: "Cancelled" });
  });

  it("a role that cannot see treatments gets an honest placeholder, not a guess", () => {
    const s = byKey(detail({ treatments: null }));
    expect(s.treatment).toMatchObject({ state: "pending", detail: "Not available for your role" });
  });

  it("the next action shows its type and when it is due", () => {
    const s = byKey(detail({ journey: { nextAction: { label: "Callback", dueAt: "2026-10-04T05:30:00.000Z" }, nextTaskBucket: "overdue" } }));
    expect(s.next_action!.state).toBe("current");
    expect(s.next_action!.detail).toMatch(/Callback/);
    expect(s.next_action!.detail).toMatch(/4 Oct/);
    expect(s.next_action!.tone).toBe("danger");
  });

  it("the latest of several visits drives the steps", () => {
    const s = byKey(detail({ appointments: [appt({ id: "a1", status: "no_show", scheduledAt: "2026-10-01T05:00:00.000Z" }), appt({ id: "a2", status: "completed", scheduledAt: "2026-10-08T05:00:00.000Z", checkedInAt: "2026-10-08T04:50:00.000Z" })] }));
    expect(s.attendance!.state).toBe("done");
    expect(s.consultation!.state).toBe("done");
  });
});
