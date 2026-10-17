import { describe, expect, it } from "vitest";
import { planJourneyUpdate, planPatientUpdate, summarizeChanges, type JourneySnapshot, type PatientSnapshot } from "../domain/lead/lead-edit.logic.js";

const patient: PatientSnapshot = { name: "Asha Rao", dateOfBirth: null, reportedAge: 40, email: null, preferredLanguage: "English", marketingConsent: true };
const journey: JourneySnapshot = { journeyType: "Cataract", priority: "normal", notes: null };
const today = "2026-10-17";

describe("planPatientUpdate", () => {
  it("returns nothing when no value actually changes", () => {
    const plan = planPatientUpdate(patient, { name: "  Asha Rao ", email: null, preferredLanguage: "English", marketingConsent: true }, today);
    expect(plan).toEqual({ ok: true, set: {}, changes: [] });
  });

  it("trims names and records a before/after change", () => {
    const plan = planPatientUpdate(patient, { name: "  Asha R. Rao " }, today);
    expect(plan).toMatchObject({ ok: true, set: { name: "Asha R. Rao" }, changes: [{ field: "name", label: "Name", from: "Asha Rao", to: "Asha R. Rao" }] });
  });

  it("clears an optional value with null and treats a blank string the same way", () => {
    const withEmail = { ...patient, email: "a@b.in" };
    expect(planPatientUpdate(withEmail, { email: null }, today)).toMatchObject({ ok: true, set: { email: null }, changes: [{ field: "email", from: "a@b.in", to: null }] });
    expect(planPatientUpdate(withEmail, { email: "  " }, today)).toMatchObject({ ok: true, set: { email: null } });
  });

  it("refuses a malformed email, a future date of birth and an impossible age", () => {
    expect(planPatientUpdate(patient, { email: "not-an-email" }, today)).toEqual({ ok: false, invalid: ["email"] });
    expect(planPatientUpdate(patient, { dateOfBirth: "2027-01-01" }, today)).toEqual({ ok: false, invalid: ["dateOfBirth"] });
    expect(planPatientUpdate(patient, { age: 151 }, today)).toEqual({ ok: false, invalid: ["age"] });
    expect(planPatientUpdate(patient, { age: 12.5 }, today)).toEqual({ ok: false, invalid: ["age"] });
  });

  it("never stores a blank preferred language", () => {
    expect(planPatientUpdate(patient, { preferredLanguage: "   " }, today)).toEqual({ ok: false, invalid: ["preferredLanguage"] });
  });

  it("reports every invalid field at once", () => {
    const plan = planPatientUpdate(patient, { email: "x", age: -1 }, today);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect([...plan.invalid].sort()).toEqual(["age", "email"]);
  });

  it("records a consent change as Yes / No", () => {
    expect(planPatientUpdate(patient, { marketingConsent: false }, today)).toMatchObject({ ok: true, set: { marketingConsent: false }, changes: [{ field: "marketingConsent", from: "Yes", to: "No" }] });
  });
});

describe("planJourneyUpdate", () => {
  it("changes the enquiry type, priority and notes", () => {
    const plan = planJourneyUpdate(journey, { journeyType: " Retina ", priority: "high", notes: "Call after 5pm" });
    expect(plan).toMatchObject({ ok: true, set: { journeyType: "Retina", priority: "high", notes: "Call after 5pm" } });
    if (plan.ok) expect(plan.changes.map((c) => c.field)).toEqual(["journeyType", "priority", "notes"]);
  });

  it("does not copy note text into the change record (notes can hold anything staff typed)", () => {
    const plan = planJourneyUpdate(journey, { notes: "private detail" });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.changes).toEqual([{ field: "notes", label: "Notes", from: null, to: "Updated" }]);
  });

  it("refuses a blank enquiry type", () => {
    expect(planJourneyUpdate(journey, { journeyType: "  " })).toEqual({ ok: false, invalid: ["journeyType"] });
  });
});

describe("summarizeChanges", () => {
  it("lists the labels of what changed", () => {
    expect(summarizeChanges([{ field: "name", label: "Name", from: "a", to: "b" }, { field: "email", label: "Email", from: null, to: "x@y.in" }])).toBe("Changed: Name, Email");
  });
});
