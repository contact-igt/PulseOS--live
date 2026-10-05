import { describe, expect, it } from "vitest";
import type { AllocationRuleVm } from "@pulseos/types";
import { blankRule, formToInput, ruleSummary, ruleToForm, validateRuleForm } from "../allocationForm";

const rule: AllocationRuleVm = {
  id: "r1", name: "Meta cataract", sortOrder: 0, enabled: true, source: "meta", specialtyKey: "CATARACT", journeyType: null, branchId: "b1",
  pool: [{ userId: "u1", name: "Arun Kulkarni" }, { userId: "u2", name: "Meera Pillai" }],
};
const services = [{ key: "CATARACT", displayName: "Cataract" }];
const branches = [{ id: "b1", name: "Indiranagar Eye Centre" }];

describe("allocation rule form", () => {
  it("starts empty and enabled", () => {
    expect(blankRule()).toEqual({ name: "", source: "", specialtyKey: "", journeyType: "", branchId: "", userIds: [], enabled: true });
  });
  it("maps to the API: blank conditions become null, names are trimmed", () => {
    expect(formToInput({ ...blankRule(), name: " Laser team ", journeyType: " LASIK ", userIds: ["u1"] })).toEqual({
      name: "Laser team", source: null, specialtyKey: null, journeyType: "LASIK", branchId: null, userIds: ["u1"], enabled: true,
    });
    expect(ruleToForm(rule)).toMatchObject({ source: "meta", specialtyKey: "CATARACT", journeyType: "", branchId: "b1", userIds: ["u1", "u2"] });
  });
  it("needs a name, at least one condition (or it would match every lead) and at least one person", () => {
    expect(validateRuleForm({ ...blankRule(), name: "" })).toMatch(/name/i);
    expect(validateRuleForm({ ...blankRule(), name: "X", userIds: ["u1"] })).toMatch(/when/i);
    expect(validateRuleForm({ ...blankRule(), name: "X", source: "meta" })).toMatch(/who/i);
    expect(validateRuleForm({ ...blankRule(), name: "X", source: "meta", userIds: ["u1"] })).toBeNull();
  });
});

describe("ruleSummary", () => {
  it("reads as a sentence: conditions, then who, and says when work is shared", () => {
    expect(ruleSummary(rule, services, branches)).toBe("Meta · Cataract · Indiranagar Eye Centre → Arun Kulkarni, Meera Pillai (taking turns)");
    expect(ruleSummary({ ...rule, source: null, branchId: null, journeyType: "LASIK", pool: [rule.pool[0]!] }, services, branches)).toBe("Cataract · LASIK → Arun Kulkarni");
  });
});
