import type { SpecialtyDefinition } from "./specialty.service.js";
import type { TreatmentDefinitionSeed } from "./treatment-catalog.service.js";
import { GYNECOLOGY_SPECIALTIES, GYNECOLOGY_TREATMENTS } from "./gynecology.templates.js";
import { OPHTHALMOLOGY_SPECIALTIES, OPHTHALMOLOGY_TREATMENTS } from "./ophthalmology.templates.js";

// GLOBAL template definitions. These are read-only product data: installing one COPIES it into tenant-owned
// rows (a department, its services, fields and treatment catalogue), after which the hospital edits only its own
// copy. Nothing here is ever read at request time on a tenant's behalf, and nothing a tenant does changes it.

export interface DepartmentTemplate {
  key: string;
  displayName: string;
  description: string;
  specialties: SpecialtyDefinition[];
  treatments: TreatmentDefinitionSeed[];
}

export const DEPARTMENT_TEMPLATES: DepartmentTemplate[] = [
  {
    key: "ophthalmology",
    displayName: "Ophthalmology",
    description: "Cataract, laser vision correction, keratoconus, oculoplasty, squint, general eye consultation and more.",
    specialties: OPHTHALMOLOGY_SPECIALTIES,
    treatments: OPHTHALMOLOGY_TREATMENTS,
  },
  {
    key: "gynecology",
    displayName: "Gynecology",
    description: "Gynecology and fertility enquiries.",
    specialties: GYNECOLOGY_SPECIALTIES,
    treatments: GYNECOLOGY_TREATMENTS,
  },
];

export const findDepartmentTemplate = (key: string): DepartmentTemplate | undefined => DEPARTMENT_TEMPLATES.find((t) => t.key === key);
export const departmentKeyForTemplate = (templateKey: string): string => templateKey.toUpperCase();
