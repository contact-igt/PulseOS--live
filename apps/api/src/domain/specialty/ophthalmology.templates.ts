import type { CreateCustomFieldInput } from "@pulseos/types";
import type { SpecialtyDefinition } from "./specialty.service.js";
import type { TreatmentDefinitionSeed } from "./treatment-catalog.service.js";

// Ophthalmology is configured entirely through the generic specialty
// template / custom-field mechanism — no ophthalmology-specific code exists
// anywhere else in the product. Each service line (Cataract, Oculoplasty,
// Laser Vision Correction, Squint) is its own SpecialtyTemplate so Add Lead
// and Patient 360 show only the fields relevant to that Journey; the fields
// common to all eye care are declared once and prepended by the builder.
//
// Operational intake only — these capture what a coordinator needs to route
// and follow up an enquiry, not clinical findings (this is not an EMR).
// Labels that could read as a clinical determination say so plainly: they are
// what staff recorded or the patient reported, never PulseOS's own finding.

const YES_NO = ["Yes", "No"];
const LATERALITY = ["Right", "Left", "Both"];

const COMMON_EYE_FIELDS: CreateCustomFieldInput[] = [
  { key: "primary_eye_concern", label: "Primary eye concern", fieldType: "TEXT" },
  { key: "laterality", label: "Laterality", fieldType: "SELECT", options: LATERALITY },
  { key: "symptom_duration", label: "Duration of symptoms", fieldType: "TEXT" },
  { key: "previous_eye_surgery", label: "Previous eye surgery", fieldType: "SELECT", options: YES_NO },
  { key: "diabetes", label: "Diabetes", fieldType: "SELECT", options: YES_NO },
  { key: "glasses_or_lens_use", label: "Current glasses / contact lens use", fieldType: "TEXT" },
];

interface ServiceLine {
  key: string;
  displayName: string;
  fields: CreateCustomFieldInput[];
}

const SERVICE_LINES: ServiceLine[] = [
  {
    key: "CATARACT",
    displayName: "Cataract",
    fields: [
      { key: "cataract_diagnosis", label: "Recorded cataract status", fieldType: "SELECT", options: ["Suspected", "Confirmed"] },
      { key: "cataract_eye", label: "Eye", fieldType: "SELECT", options: LATERALITY },
      { key: "cataract_surgery_advised", label: "Surgery advised", fieldType: "SELECT", options: YES_NO },
      { key: "cataract_surgery_interest", label: "Surgery interest", fieldType: "SELECT", options: ["Considering", "Ready to schedule", "Needs counselling"] },
    ],
  },
  {
    key: "OCULOPLASTY",
    displayName: "Oculoplasty",
    fields: [
      { key: "oculoplasty_concern", label: "Concern", fieldType: "SELECT", options: ["Ptosis", "Eyelid swelling", "Tear duct problem", "Under-eye concern", "Eyelid lesion", "Other"] },
      { key: "cosmetic_or_functional", label: "Cosmetic / Functional", fieldType: "SELECT", options: ["Cosmetic", "Functional", "Both"] },
      { key: "oculoplasty_procedure_advised", label: "Procedure advised", fieldType: "SELECT", options: YES_NO },
    ],
  },
  {
    key: "LASER_VISION_CORRECTION",
    displayName: "Laser Vision Correction",
    fields: [
      { key: "lvc_interest", label: "Interest", fieldType: "SELECT", options: ["LASIK", "SMILE", "PRK", "Not sure"] },
      { key: "spectacle_power", label: "Current spectacle power (as reported)", fieldType: "TEXT" },
      { key: "lvc_contact_lens_use", label: "Contact lens use", fieldType: "SELECT", options: YES_NO },
      { key: "lvc_screening_completed", label: "Screening completed", fieldType: "SELECT", options: YES_NO },
      { key: "lvc_eligible", label: "Screening eligibility", fieldType: "SELECT", options: ["Yes", "No", "Pending evaluation"] },
    ],
  },
  {
    key: "SQUINT",
    displayName: "Squint",
    fields: [
      { key: "squint_patient_group", label: "Patient group", fieldType: "SELECT", options: ["Child", "Adult"] },
      { key: "squint_type", label: "Squint type", fieldType: "TEXT" },
      { key: "squint_since", label: "Since when", fieldType: "TEXT" },
      { key: "squint_previous_treatment", label: "Previous treatment", fieldType: "SELECT", options: ["Glasses", "Patching", "Surgery", "None"] },
      { key: "squint_surgery_advised", label: "Surgery advised", fieldType: "SELECT", options: YES_NO },
    ],
  },
  {
    // Coordinator-level intake only: what staff recorded or the patient reported. No corneal
    // measurements or grading — screening results live with the clinician, not in PulseOS.
    key: "KERATOCONUS",
    displayName: "Keratoconus",
    fields: [
      { key: "keratoconus_status", label: "Recorded keratoconus status", fieldType: "SELECT", options: ["Suspected", "Confirmed"] },
      { key: "keratoconus_eye", label: "Eye", fieldType: "SELECT", options: LATERALITY },
      { key: "eye_rubbing_history", label: "Eye-rubbing history (as reported)", fieldType: "SELECT", options: YES_NO },
      { key: "topography_done", label: "Corneal screening (topography) done", fieldType: "SELECT", options: YES_NO },
      { key: "cxl_advised", label: "Corneal cross-linking (CXL) advised", fieldType: "SELECT", options: YES_NO },
    ],
  },
];

// The procedures this hospital offers, per service line. default_estimated_value is a clearly-demo
// INR figure, not a price list.
export const OPHTHALMOLOGY_TREATMENTS: TreatmentDefinitionSeed[] = [
  { specialtyKey: "CATARACT", key: "CATARACT_SURGERY", label: "Cataract Surgery", defaultEstimatedValue: 42_000, sortOrder: 0 },
  { specialtyKey: "LASER_VISION_CORRECTION", key: "LASIK", label: "LASIK", defaultEstimatedValue: 90_000, sortOrder: 1 },
  { specialtyKey: "LASER_VISION_CORRECTION", key: "SMILE", label: "SMILE", defaultEstimatedValue: 96_000, sortOrder: 2 },
  { specialtyKey: "LASER_VISION_CORRECTION", key: "PRK", label: "PRK", defaultEstimatedValue: 70_000, sortOrder: 3 },
  { specialtyKey: "KERATOCONUS", key: "CXL", label: "Corneal Cross-Linking (CXL)", defaultEstimatedValue: 32_000, sortOrder: 4 },
  { specialtyKey: "OCULOPLASTY", key: "PTOSIS_CORRECTION", label: "Ptosis Correction", defaultEstimatedValue: 55_000, sortOrder: 5 },
  { specialtyKey: "OCULOPLASTY", key: "DCR", label: "DCR / Tear Duct Procedure", defaultEstimatedValue: 38_000, sortOrder: 6 },
  { specialtyKey: "SQUINT", key: "SQUINT_SURGERY", label: "Squint Surgery", defaultEstimatedValue: 45_000, sortOrder: 7 },
];

export const OPHTHALMOLOGY_SPECIALTIES: SpecialtyDefinition[] = [
  ...SERVICE_LINES.map((line, i) => ({
    key: line.key,
    displayName: line.displayName,
    defaultJourneyType: line.displayName,
    sortOrder: i,
    fields: [...COMMON_EYE_FIELDS, ...line.fields],
  })),
  {
    key: "GENERAL_EYE_CONSULTATION",
    displayName: "General Eye Consultation",
    defaultJourneyType: "General Eye Consultation",
    sortOrder: SERVICE_LINES.length,
    fields: COMMON_EYE_FIELDS,
  },
  {
    key: "OTHER",
    displayName: "Other",
    defaultJourneyType: "Other eye enquiry",
    sortOrder: SERVICE_LINES.length + 1,
    fields: COMMON_EYE_FIELDS,
  },
];
