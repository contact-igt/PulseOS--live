import type { CrmOutcomeVm, JourneyStage } from "@pulseos/types";

/**
 * The journey's SYSTEM stages: owned by PulseOS, in lifecycle order, never renamed, removed or reordered by a hospital
 * (reports, the state machines and the Command Centre depend on them). A hospital configures only the OUTCOMES recorded
 * under the two stages a logged call or follow-up can move a journey to. Every other stage is reached automatically.
 */
export interface SystemStage {
  key: JourneyStage;
  label: string;
  /** Plain words for how a journey gets here. */
  how: string;
  /** Outcomes can be configured under this stage (only the stages an outcome can move a journey to). */
  outcomes: boolean;
}

export const SYSTEM_STAGES: SystemStage[] = [
  { key: "enquiry", label: "Enquiry", how: "A new enquiry comes in.", outcomes: false },
  { key: "contacted", label: "Contacted", how: "Staff reach the patient. The outcome says how it went.", outcomes: true },
  { key: "booked", label: "Appointment booked", how: "An appointment is booked.", outcomes: false },
  { key: "attended", label: "Attended", how: "The patient arrives for the visit.", outcomes: false },
  { key: "consulted", label: "Consulted", how: "The doctor completes the consultation.", outcomes: false },
  { key: "treatment_advised", label: "Treatment advised", how: "A treatment is advised and accepted.", outcomes: false },
  { key: "scheduled", label: "Treatment scheduled", how: "A procedure is scheduled.", outcomes: false },
  { key: "completed", label: "Treatment completed", how: "The treatment is completed.", outcomes: false },
  { key: "lost", label: "Lost", how: "The patient will not continue. The outcome says why.", outcomes: true },
];

export const CONFIGURABLE_STAGES = SYSTEM_STAGES.filter((s) => s.outcomes);

/** Outcomes under one stage, in their saved order; archived ones only when asked. */
export function outcomesForStage(outcomes: CrmOutcomeVm[], stage: JourneyStage, showArchived: boolean): CrmOutcomeVm[] {
  return outcomes.filter((o) => o.stage === stage && (showArchived || !o.archived)).sort((a, b) => a.sortOrder - b.sortOrder);
}
