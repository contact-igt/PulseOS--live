import { describe, expect, it } from "vitest";
import type { TreatmentDefinitionVm } from "@pulseos/types";
import { buildSurgeryInput, buildSurgeryReschedule, initialSurgeryForm, proceduresFor, rescheduleSurgeryDefaults } from "../surgeryForm";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-01T12:00:00.000Z"); // 17:30 IST
const def = (key: string, specialtyKey: string): TreatmentDefinitionVm => ({ id: `id-${key}`, key, label: key, specialtyKey, defaultEstimatedValue: null, sortOrder: 0 });
const CATALOG = [def("CATARACT_SURGERY", "CATARACT"), def("LASIK", "LASER_VISION_CORRECTION"), def("SMILE", "LASER_VISION_CORRECTION")];

describe("Schedule surgery form", () => {
  it("offers the procedures of the journey's service when the catalogue has them, otherwise the whole catalogue", () => {
    expect(proceduresFor(CATALOG, "LASER_VISION_CORRECTION").map((d) => d.key)).toEqual(["LASIK", "SMILE"]);
    expect(proceduresFor(CATALOG, "SQUINT")).toHaveLength(3); // no mapping for this service: nothing is hidden
    expect(proceduresFor(CATALOG, null)).toHaveLength(3);
  });

  it("pre-fills doctor and branch from the appointment; procedure, date and time are left for staff to choose", () => {
    expect(initialSurgeryForm({ resourceId: "r1", branchId: "b1" })).toEqual({ treatmentDefinitionId: "", date: "", time: "", resourceId: "r1", branchId: "b1", note: "" });
  });

  it("builds the request from hospital wall time (09:30 in Kolkata is 04:00 UTC)", () => {
    const s = { ...initialSurgeryForm({ resourceId: "r1", branchId: "b1" }), treatmentDefinitionId: "id-CATARACT_SURGERY", date: "2026-10-12", time: "09:30", note: " Right eye " };
    expect(buildSurgeryInput(s, TZ, NOW)).toEqual({ input: { treatmentDefinitionId: "id-CATARACT_SURGERY", scheduledAt: "2026-10-12T04:00:00.000Z", resourceId: "r1", branchId: "b1", note: "Right eye" } });
  });

  it("refuses a missing procedure, date/time, doctor or branch, and a time that has already passed", () => {
    const ok = { ...initialSurgeryForm({ resourceId: "r1", branchId: "b1" }), treatmentDefinitionId: "p", date: "2026-10-12", time: "09:30" };
    expect(buildSurgeryInput({ ...ok, treatmentDefinitionId: "" }, TZ, NOW)).toEqual({ error: "Choose the procedure." });
    expect(buildSurgeryInput({ ...ok, time: "" }, TZ, NOW)).toEqual({ error: "Choose the surgery date and time." });
    expect(buildSurgeryInput({ ...ok, date: "2026-10-01", time: "17:00" }, TZ, NOW)).toEqual({ error: "Pick a surgery time in the future." });
    expect(buildSurgeryInput({ ...ok, resourceId: "" }, TZ, NOW)).toEqual({ error: "Choose the doctor." });
    expect(buildSurgeryInput({ ...ok, branchId: "" }, TZ, NOW)).toEqual({ error: "Choose the branch." });
  });

  it("a reschedule keeps the procedure and defaults to the current schedule in the hospital's clock", () => {
    expect(rescheduleSurgeryDefaults("2026-10-12T04:00:00.000Z", TZ)).toEqual({ date: "2026-10-12", time: "09:30" });
    const s = { ...initialSurgeryForm({ resourceId: "r1", branchId: "b1" }), date: "2026-10-14", time: "10:00" };
    expect(buildSurgeryReschedule(s, TZ, NOW)).toEqual({ input: { scheduledAt: "2026-10-14T04:30:00.000Z", resourceId: "r1", branchId: "b1" } });
  });
});
