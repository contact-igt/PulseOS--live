import { describe, expect, it } from "vitest";
import type { FollowUpTypeVm } from "@pulseos/types";
import { NO_OWNER, buildFollowUpInput, buildReschedule, defaultType, initialFollowUpForm, rescheduleDefaults } from "../followUpForm";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-01T12:00:00.000Z"); // 17:30 IST
const ty = (key: string, requiresNote = false): FollowUpTypeVm => ({ id: `id-${key}`, key, label: key, canonicalTaskType: "FOLLOW_UP", defaultPriority: "normal", defaultOwner: "JOURNEY_OWNER", requiresNote, isActive: true, sortOrder: 0, departmentId: null, departmentName: null });
const TYPES = [ty("callback"), ty("appointment_risk", true), ty("general_followup")];

describe("Add Follow-up form", () => {
  it("starts on General Follow-up with no date or time chosen (nothing is assumed)", () => {
    expect(defaultType(TYPES)?.key).toBe("general_followup");
    expect(initialFollowUpForm(TYPES)).toMatchObject({ typeId: "id-general_followup", date: "", time: "", ownerId: "", priority: "", note: "" });
    expect(initialFollowUpForm(TYPES, { typeKey: "callback" }).typeId).toBe("id-callback");
  });

  it("builds the request from hospital wall time; owner and priority are omitted when left on the type's defaults", () => {
    const s = { ...initialFollowUpForm(TYPES), date: "2026-10-02", time: "11:00", note: " Ring before noon " };
    expect(buildFollowUpInput(s, TYPES, TZ, NOW)).toEqual({ input: { followUpTypeId: "id-general_followup", dueAt: "2026-10-02T05:30:00.000Z", note: "Ring before noon" } });
  });

  it("an explicit owner, 'nobody' and a priority are sent; an unknown type, a missing time, a past time and a missing required note are refused", () => {
    const base = { ...initialFollowUpForm(TYPES), date: "2026-10-02", time: "11:00" };
    expect(buildFollowUpInput({ ...base, ownerId: "u1", priority: "high" }, TYPES, TZ, NOW)).toMatchObject({ input: { assignedTo: "u1", priority: "high" } });
    expect(buildFollowUpInput({ ...base, ownerId: NO_OWNER }, TYPES, TZ, NOW)).toMatchObject({ input: { assignedTo: null } });
    expect(buildFollowUpInput({ ...base, typeId: "nope" }, TYPES, TZ, NOW)).toHaveProperty("error");
    expect(buildFollowUpInput({ ...base, time: "" }, TYPES, TZ, NOW)).toEqual({ error: "Choose the date and time." });
    expect(buildFollowUpInput({ ...base, date: "2026-10-01", time: "09:00" }, TYPES, TZ, NOW)).toEqual({ error: "Pick a time in the future." });
    expect(buildFollowUpInput({ ...base, typeId: "id-appointment_risk" }, TYPES, TZ, NOW)).toEqual({ error: "appointment_risk needs a note — say what's happening." });
    expect(buildFollowUpInput({ ...base, typeId: "id-appointment_risk", note: "Doctor away" }, TYPES, TZ, NOW)).toHaveProperty("input");
  });

  it("reschedule needs a future hospital time; defaults keep the clock time but move an overdue task to tomorrow", () => {
    expect(buildReschedule("2026-10-03", "10:00", "  Monday please ", TZ, NOW)).toEqual({ dueAt: "2026-10-03T04:30:00.000Z", note: "Monday please" });
    expect(buildReschedule("2026-10-01", "09:00", "", TZ, NOW)).toEqual({ error: "Pick a time in the future." });
    expect(rescheduleDefaults("2026-09-29T05:30:00.000Z", TZ, NOW)).toEqual({ date: "2026-10-02", time: "11:00" });
    expect(rescheduleDefaults("2026-10-05T05:30:00.000Z", TZ, NOW)).toEqual({ date: "2026-10-05", time: "11:00" });
  });
});
