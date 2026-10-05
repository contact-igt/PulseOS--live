import type { SpecialtyDefinition } from "./specialty.service.js";
import type { TreatmentDefinitionSeed } from "./treatment-catalog.service.js";

// Fertility procedures, derived from the treatment labels the Gynecology demo already uses
// (IVF Cycle 1 / IVF Cycle 2 / IUI Cycle). Default values are demo figures, not a price list.
export const GYNECOLOGY_TREATMENTS: TreatmentDefinitionSeed[] = [
  { specialtyKey: "FERTILITY", key: "IUI_CYCLE", label: "IUI Cycle", defaultEstimatedValue: 25_000, sortOrder: 0 },
  { specialtyKey: "FERTILITY", key: "IVF_CYCLE_1", label: "IVF Cycle 1", defaultEstimatedValue: 90_000, sortOrder: 1 },
  { specialtyKey: "FERTILITY", key: "IVF_CYCLE_2", label: "IVF Cycle 2", defaultEstimatedValue: 100_000, sortOrder: 2 },
];

// Women's-health specialties, configured as plain SpecialtyTemplate data —
// the same mechanism as ophthalmology.templates.ts. Nothing else in the
// product knows these exist.
export const GYNECOLOGY_SPECIALTIES: SpecialtyDefinition[] = [
  {
    key: "GYNECOLOGY",
    displayName: "Gynecology / Maternity",
    defaultJourneyType: "Pregnancy Care",
    sortOrder: 0,
    fields: [
      { key: "pregnancy_status", label: "Pregnancy status", fieldType: "BOOLEAN" },
      { key: "gestational_week", label: "Gestational week", fieldType: "NUMBER" },
      { key: "edd", label: "EDD", fieldType: "DATE" },
      { key: "high_risk_status", label: "High-risk status", fieldType: "BOOLEAN" },
      { key: "previous_c_section", label: "Previous C-section", fieldType: "BOOLEAN" },
    ],
  },
  {
    key: "FERTILITY",
    displayName: "Fertility / IVF",
    defaultJourneyType: "Fertility",
    sortOrder: 1,
    fields: [
      { key: "trying_duration", label: "Trying duration", fieldType: "TEXT" },
      { key: "previous_fertility_treatment", label: "Previous fertility treatment", fieldType: "BOOLEAN" },
      { key: "ivf_interest", label: "IVF interest", fieldType: "BOOLEAN" },
      { key: "treatment_stage", label: "Treatment stage", fieldType: "SELECT", options: ["Evaluation", "IUI", "IVF", "Follow-up"] },
    ],
  },
];
