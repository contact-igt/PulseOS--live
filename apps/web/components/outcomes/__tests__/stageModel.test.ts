import { describe, expect, it } from "vitest";
import { JOURNEY_STAGES, type CrmOutcomeVm } from "@pulseos/types";
import { CONFIGURABLE_STAGES, SYSTEM_STAGES, outcomesForStage } from "../stageModel";

const o = (key: string, stage: "contacted" | "lost", sortOrder: number, archived = false): CrmOutcomeVm => ({ id: key, key, label: key, stage, requiresFollowUp: false, allowsAppointment: false, asksReason: false, followUpType: "FOLLOW_UP", sortOrder, archived });

describe("system stages vs configurable outcomes", () => {
  it("lists every canonical journey stage exactly once, in lifecycle order — no stage is invented or dropped", () => {
    expect(SYSTEM_STAGES.map((s) => s.key)).toEqual([...JOURNEY_STAGES]);
  });

  it("only Contacted and Lost take outcomes; every other stage is automatic and says how a journey gets there", () => {
    expect(CONFIGURABLE_STAGES.map((s) => s.key)).toEqual(["contacted", "lost"]);
    for (const s of SYSTEM_STAGES) expect(s.how.length).toBeGreaterThan(5);
  });

  it("outcomes group under their stage in saved order; archived ones stay readable but only when shown", () => {
    const all = [o("b", "contacted", 2), o("a", "contacted", 1), o("x", "lost", 3), o("old", "contacted", 9, true)];
    expect(outcomesForStage(all, "contacted", false).map((x) => x.key)).toEqual(["a", "b"]);
    expect(outcomesForStage(all, "contacted", true).map((x) => x.key)).toEqual(["a", "b", "old"]);
    expect(outcomesForStage(all, "lost", false).map((x) => x.key)).toEqual(["x"]);
    expect(outcomesForStage(all, "booked", true)).toEqual([]);
  });

  it("uses plain words, never an enum name", () => {
    for (const s of SYSTEM_STAGES) expect(s.label).not.toMatch(/_/);
  });
});
