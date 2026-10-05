import { describe, expect, it } from "vitest";
import { blankField, defaultFromText, defaultToText, fieldToForm, formToCreateInput, formToUpdateInput, placementSummary, slugifyKey, validateFieldForm } from "../crmFieldForm";
import type { CrmFieldVm } from "@pulseos/types";

const existing: CrmFieldVm = {
  id: "f1", specialtyKey: "CATARACT", key: "budget", label: "Budget", fieldType: "NUMBER", options: null, required: true, sortOrder: 3, archived: false, origin: "CUSTOM",
  groupKey: "qualification", placements: ["add_lead", "followup_outcome"], defaultValue: 50000, visibleTo: "front_office", readOnly: false, filterable: false, carryForward: false, rules: [],
};

describe("slugifyKey", () => {
  it("turns a label into a valid key (lowercase, underscores, starts with a letter, bounded)", () => {
    expect(slugifyKey("Budget (₹)")).toBe("budget");
    expect(slugifyKey("  Trying  duration / months ")).toBe("trying_duration_months");
    expect(slugifyKey("2nd opinion?")).toBe("f_2nd_opinion");
    expect(slugifyKey("x".repeat(80)).length).toBeLessThanOrEqual(48);
    expect(slugifyKey("!!!")).toBe("");
  });
});

describe("form <-> API", () => {
  it("a blank field starts with the standard placements, everyone visibility and the chosen service", () => {
    expect(blankField("CATARACT")).toMatchObject({ specialtyKey: "CATARACT", placements: ["add_lead", "journey_detail", "patient_360"], visibleTo: "everyone", required: false, fieldType: "TEXT", groupKey: "enquiry_details" });
  });

  it("builds a create input with the generated key, trimmed label and options only for choice types", () => {
    const f = { ...blankField("*"), label: "  Preferred time ", fieldType: "SELECT" as const, options: ["Morning", " ", "Evening", "Morning"] };
    expect(formToCreateInput(f)).toMatchObject({ specialtyKey: "*", key: "preferred_time", label: "Preferred time", fieldType: "SELECT", options: ["Morning", "Evening"] });
    expect(formToCreateInput({ ...f, fieldType: "TEXT" }).options).toBeUndefined();
  });

  it("an edit sends only what the editor owns (never key or service) and keeps the default typed", () => {
    const form = fieldToForm(existing);
    expect(form.defaultText).toBe("50000");
    const input = formToUpdateInput({ ...form, label: "Budget (INR)", defaultText: "75000" });
    expect(input).toEqual({ label: "Budget (INR)", fieldType: "NUMBER", options: undefined, required: true, groupKey: "qualification", placements: ["add_lead", "followup_outcome"], defaultValue: 75000, visibleTo: "front_office", readOnly: false, filterable: false, carryForward: false, rules: [] });
    expect(input).not.toHaveProperty("key");
    expect(input).not.toHaveProperty("specialtyKey");
  });

  it("default values round-trip by type", () => {
    expect(defaultFromText("NUMBER", "12")).toBe(12);
    expect(defaultFromText("NUMBER", "")).toBeNull();
    expect(defaultFromText("BOOLEAN", "true")).toBe(true);
    expect(defaultFromText("BOOLEAN", "false")).toBe(false);
    expect(defaultFromText("MULTI_SELECT", "A, B")).toEqual(["A", "B"]);
    expect(defaultFromText("TEXT", "hello")).toBe("hello");
    expect(defaultToText("MULTI_SELECT", ["A", "B"])).toBe("A, B");
    expect(defaultToText("BOOLEAN", true)).toBe("true");
    expect(defaultToText("TEXT", null)).toBe("");
  });
});

describe("validateFieldForm (what the editor can say before the server does)", () => {
  it("needs a label, a usable key, options for choice fields and at least one placement", () => {
    expect(validateFieldForm({ ...blankField("*"), label: "" })).toMatch(/label/i);
    expect(validateFieldForm({ ...blankField("*"), label: "!!!" })).toMatch(/letters or numbers/i);
    expect(validateFieldForm({ ...blankField("*"), label: "Pick", fieldType: "SELECT", options: ["", " "] })).toMatch(/option/i);
    expect(validateFieldForm({ ...blankField("*"), label: "Pick", placements: [] })).toMatch(/where/i);
    expect(validateFieldForm({ ...blankField("*"), label: "Pick" })).toBeNull();
    // an existing field keeps its key, so a symbols-only edit of the label is still fine
    expect(validateFieldForm({ ...fieldToForm(existing), label: "!!!" }, { editing: true })).toBeNull();
  });
});

describe("placementSummary", () => {
  it("names up to two places, then counts the rest", () => {
    expect(placementSummary(["add_lead"])).toBe("Add Lead");
    expect(placementSummary(["add_lead", "journey_detail"])).toBe("Add Lead · Journey Detail");
    expect(placementSummary(["add_lead", "journey_detail", "patient_360", "appointment"])).toBe("Add Lead · Journey Detail · Patient 360 · Appointment");
    expect(placementSummary([])).toBe("Nowhere");
  });
});
