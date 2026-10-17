import { describe, expect, it } from "vitest";
import type { CrmFieldVm, LeadEditModel } from "@pulseos/types";
import { editReadiness, toEditForm, toUpdateLeadInput } from "../editLeadModel";

const field = (over: Partial<CrmFieldVm> & Pick<CrmFieldVm, "id" | "key" | "label" | "fieldType">): CrmFieldVm =>
  ({ specialtyKey: "GYNECOLOGY", options: null, required: false, sortOrder: 0, archived: false, origin: "CUSTOM", groupKey: "enquiry_details", placements: ["journey_detail"], defaultValue: null, visibleTo: "everyone", readOnly: false, filterable: false, carryForward: false, rules: [], ...over }) as CrmFieldVm;

const model = (over: Partial<LeadEditModel> = {}): LeadEditModel => ({
  journeyId: "j1",
  patientId: "p1",
  versions: { patient: "2026-10-17T05:00:00.000Z", journey: "2026-10-17T05:00:01.000Z" },
  patient: { name: "Asha Rao", dateOfBirth: null, age: 40, phone: "9876543210", email: null, preferredLanguage: "English", branchId: "b1", marketingConsent: true },
  journey: { journeyType: "Cataract", specialtyKey: "GYNECOLOGY", sourceKey: "phone", sourceLabel: "Phone", priority: "normal", notes: null, ownerId: null, stage: "enquiry", campaign: null },
  fields: [field({ id: "f1", key: "eye", label: "Eye", fieldType: "SELECT", options: ["Left", "Right"] })],
  fieldValues: { eye: "Left" },
  can: { editPatient: true, editJourney: true, changeOwner: true, changeSource: true },
  ...over,
});

describe("toUpdateLeadInput", () => {
  it("sends nothing when the form was not changed", () => {
    const m = model();
    expect(toUpdateLeadInput(m, toEditForm(m))).toBeNull();
  });

  it("sends only the fields that changed, with the versions it opened with", () => {
    const m = model();
    const form = { ...toEditForm(m), name: "  Asha R. Rao ", priority: "high" as const };
    expect(toUpdateLeadInput(m, form)).toEqual({ versions: m.versions, patient: { name: "Asha R. Rao" }, journey: { priority: "high" } });
  });

  it("clears an optional value with null", () => {
    const m = model({ patient: { ...model().patient, email: "a@b.in" } });
    expect(toUpdateLeadInput(m, { ...toEditForm(m), email: "" })).toEqual({ versions: m.versions, patient: { email: null } });
  });

  it("turns an age typed as text into a number, and a blank into null", () => {
    const m = model();
    expect(toUpdateLeadInput(m, { ...toEditForm(m), age: "41" })?.patient).toEqual({ age: 41 });
    expect(toUpdateLeadInput(m, { ...toEditForm(m), age: "" })?.patient).toEqual({ age: null });
  });

  it("unassigns the owner with null", () => {
    const m = model({ journey: { ...model().journey, ownerId: "u1" } });
    expect(toUpdateLeadInput(m, { ...toEditForm(m), ownerId: "" })?.journey).toEqual({ ownerId: null });
  });

  it("sends a changed source together with its reason", () => {
    const m = model();
    expect(toUpdateLeadInput(m, { ...toEditForm(m), sourceKey: "google", sourceReason: " Said Google " })?.journey).toEqual({ sourceKey: "google", sourceReason: "Said Google" });
  });

  it("sends changed custom fields only, and an emptied one as an empty value", () => {
    const m = model();
    expect(toUpdateLeadInput(m, { ...toEditForm(m), customFieldValues: { eye: "Right" } })?.customFieldValues).toEqual({ eye: "Right" });
    expect(toUpdateLeadInput(m, { ...toEditForm(m), customFieldValues: { eye: "" } })?.customFieldValues).toEqual({ eye: "" });
  });

  it("never sends a group the person may not edit", () => {
    const m = model({ can: { editPatient: false, editJourney: true, changeOwner: false, changeSource: false } });
    const form = { ...toEditForm(m), name: "Changed", ownerId: "u9", sourceKey: "google", sourceReason: "x", priority: "high" as const };
    expect(toUpdateLeadInput(m, form)).toEqual({ versions: m.versions, journey: { priority: "high" } });
  });
});

describe("editReadiness", () => {
  it("is ready for an untouched form", () => {
    const m = model();
    expect(editReadiness(m, toEditForm(m)).ok).toBe(true);
  });

  it("needs a phone, an enquiry, and a reason when the source changes", () => {
    const m = model();
    const form = toEditForm(m);
    expect(editReadiness(m, { ...form, phone: "12" }).reasons).toContain("Add the patient's phone number.");
    expect(editReadiness(m, { ...form, journeyType: " " }).reasons).toContain("Add what the patient enquired about.");
    expect(editReadiness(m, { ...form, sourceKey: "google" }).reasons).toContain("Say why the original source is being changed.");
    expect(editReadiness(m, { ...form, sourceKey: "google", sourceReason: "Patient said so" }).ok).toBe(true);
  });

  it("needs a required custom field to stay filled", () => {
    const m = model({ fields: [field({ id: "f1", key: "eye", label: "Eye", fieldType: "SELECT", options: ["Left"], required: true })] });
    expect(editReadiness(m, { ...toEditForm(m), customFieldValues: { eye: "" } }).reasons).toContain("Fill in the required details.");
  });
});
