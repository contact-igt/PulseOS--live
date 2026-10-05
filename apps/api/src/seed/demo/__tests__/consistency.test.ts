import { describe, expect, it } from "vitest";
import { assertJourneyConfigsConsistent, journeyConfigProblems } from "../consistency.js";
import type { DemoJourneyConfig } from "../shared.js";
import { GYNECOLOGY_PATIENT_NAMES, JOURNEY_CONFIGS as GYN } from "../gynecology.js";
import { OPHTHALMOLOGY_PATIENT_NAMES, JOURNEY_CONFIGS as EYE } from "../ophthalmology.js";
import { OPHTHALMOLOGY_SPECIALTIES, OPHTHALMOLOGY_TREATMENTS } from "../../../domain/specialty/ophthalmology.templates.js";
import { GYNECOLOGY_TREATMENTS } from "../../../domain/specialty/gynecology.templates.js";

const base: DemoJourneyConfig = { patientIdx: 0, journeyType: "X", source: "google", campaignKey: null, stage: "consulted", contactedOffsetDays: -1, createdOffsetDays: -2 };

describe("journeyConfigProblems", () => {
  it("accepts a coherent journey", () => {
    expect(journeyConfigProblems({ ...base, stage: "completed", treatment: { definitionKey: "T", status: "COMPLETED", estimatedValue: 1 }, revenueAmount: 1 })).toEqual([]);
  });
  it("flags a completed treatment on a journey still at treatment_advised", () => {
    const p = journeyConfigProblems({ ...base, stage: "treatment_advised", treatment: { definitionKey: "T", status: "COMPLETED", estimatedValue: 1 } });
    expect(p[0]).toMatch(/COMPLETED but stage is "treatment_advised"/);
  });
  it("flags a scheduled treatment that is not at the scheduled stage", () => {
    expect(journeyConfigProblems({ ...base, stage: "treatment_advised", treatment: { definitionKey: "T", status: "SCHEDULED", estimatedValue: 1 } })).toHaveLength(1);
  });
  it("flags a contacted-or-later journey with no contact date", () => {
    expect(journeyConfigProblems({ ...base, stage: "contacted", contactedOffsetDays: null })[0]).toMatch(/never contacted/);
  });
  it("flags an in-clinic appointment on a journey still at enquiry/booked", () => {
    expect(journeyConfigProblems({ ...base, stage: "booked", appt: { status: "waiting", offsetDays: 0, doctor: "d" } })[0]).toMatch(/waiting but stage/);
  });
  it("flags revenue without a completed treatment", () => {
    expect(journeyConfigProblems({ ...base, stage: "treatment_advised", treatment: { definitionKey: "T", status: "ADVISED", estimatedValue: 1 }, revenueAmount: 5 })[0]).toMatch(/revenue/);
  });
  it("flags an advised outcome that never advanced the stage", () => {
    expect(journeyConfigProblems({ ...base, stage: "attended", appt: { status: "completed", offsetDays: -1, doctor: "d" }, outcome: { value: "TREATMENT_ADVISED" } })[0]).toMatch(/TREATMENT_ADVISED/);
  });
});

describe("treatment catalog linkage", () => {
  const withTreatment: DemoJourneyConfig = { ...base, stage: "treatment_advised", treatment: { definitionKey: "PRK", status: "ADVISED", estimatedValue: 1 } };
  it("flags a treatment whose catalog key is not in the tenant catalog", () => {
    expect(journeyConfigProblems(withTreatment, new Set(["LASIK"]))[0]).toMatch(/PRK.*not in the tenant treatment catalog/);
  });
  it("accepts a treatment whose catalog key exists", () => {
    expect(journeyConfigProblems(withTreatment, new Set(["PRK"]))).toEqual([]);
  });
  it("assertJourneyConfigsConsistent throws when a key is missing from the catalog", () => {
    expect(() => assertJourneyConfigsConsistent("eye", [withTreatment], ["Someone"], new Set(["LASIK"]))).toThrow(/not in the tenant treatment catalog/);
  });
});

describe("seeded demo journeys", () => {
  it.each([
    ["gynecology", GYN, GYNECOLOGY_PATIENT_NAMES, GYNECOLOGY_TREATMENTS],
    ["ophthalmology", EYE, OPHTHALMOLOGY_PATIENT_NAMES, OPHTHALMOLOGY_TREATMENTS],
  ] as const)("%s configs have no contradictions and every treatment is in the catalog", (_label, configs, names, catalog) => {
    const keys = new Set(catalog.map((t) => t.key));
    const problems = configs.flatMap((c) => journeyConfigProblems(c, keys).map((p) => `#${c.patientIdx} ${names[c.patientIdx]}: ${p}`));
    expect(problems).toEqual([]);
  });

  it("every ophthalmology catalog procedure belongs to a real ophthalmology specialty", () => {
    const specialties = new Set(OPHTHALMOLOGY_SPECIALTIES.map((s) => s.key));
    for (const t of OPHTHALMOLOGY_TREATMENTS) expect(specialties.has(t.specialtyKey), t.key).toBe(true);
  });

  it("the ophthalmology catalog lists the eight expected procedures", () => {
    expect(OPHTHALMOLOGY_TREATMENTS.map((t) => t.label)).toEqual([
      "Cataract Surgery", "LASIK", "SMILE", "PRK", "Corneal Cross-Linking (CXL)", "Ptosis Correction", "DCR / Tear Duct Procedure", "Squint Surgery",
    ]);
  });

  it("KERATOCONUS is a specialty with coordinator-level fields (no measurements)", () => {
    const kc = OPHTHALMOLOGY_SPECIALTIES.find((s) => s.key === "KERATOCONUS")!;
    expect(kc.defaultJourneyType).toBe("Keratoconus");
    expect(kc.fields.map((f) => f.key)).toEqual(expect.arrayContaining(["keratoconus_status", "keratoconus_eye", "eye_rubbing_history", "topography_done", "cxl_advised"]));
  });

  it("each ophthalmology procedure is used by at least one seeded eye journey", () => {
    const used = new Set(EYE.map((c) => c.treatment?.definitionKey));
    for (const t of OPHTHALMOLOGY_TREATMENTS) expect(used.has(t.key), `${t.key} is seeded`).toBe(true);
  });

  it("a Keratoconus journey advised CXL and one at an earlier stage are seeded", () => {
    const kc = EYE.filter((c) => c.specialtyKey === "KERATOCONUS");
    expect(kc.length).toBeGreaterThanOrEqual(2);
    expect(kc.some((c) => c.treatment?.definitionKey === "CXL" && c.outcome?.value === "TREATMENT_ADVISED" && c.task)).toBe(true);
    expect(kc.some((c) => c.stage === "enquiry")).toBe(true);
  });
});
