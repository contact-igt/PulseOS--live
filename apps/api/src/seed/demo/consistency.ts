import type { DemoJourneyConfig, JourneyStageValue } from "./shared.js";

// Rules a seeded Journey must satisfy so no demo screen shows a contradiction
// (e.g. a completed treatment on a journey still labelled "treatment advised").
// They mirror what the domain services themselves do: recording an outcome
// sets the stage (outcome.service.ts STAGE_BY_OUTCOME), accepting a treatment
// leaves it at treatment_advised (treatment.service.ts), and the seed extends
// that to scheduled/completed once a treatment reaches those states.

const AFTER_ENQUIRY: JourneyStageValue[] = ["contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed"];
const AFTER_ATTENDED: JourneyStageValue[] = ["attended", "consulted", "treatment_advised", "scheduled", "completed", "lost"];
const AFTER_CONSULT: JourneyStageValue[] = ["consulted", "treatment_advised", "scheduled", "completed", "lost"];
const AFTER_ADVISED: JourneyStageValue[] = ["treatment_advised", "scheduled", "completed", "lost"];

const STAGES_BY_TREATMENT: Record<string, JourneyStageValue[]> = {
  ADVISED: ["treatment_advised"],
  DECISION_PENDING: ["consulted", "treatment_advised"],
  ACCEPTED: ["treatment_advised"],
  SCHEDULED: ["scheduled"],
  COMPLETED: ["completed"],
  DECLINED: ["lost"],
  CANCELLED: ["lost"],
  LOST: ["lost"],
};

/**
 * Human-readable contradictions in one journey config; empty when consistent.
 * When the tenant's catalog keys are given, a treatment must reference one of them.
 */
export function journeyConfigProblems(config: DemoJourneyConfig, catalogKeys?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const { stage } = config;

  if (AFTER_ENQUIRY.includes(stage) && config.contactedOffsetDays === null) {
    problems.push(`stage "${stage}" but the journey was never contacted`);
  }
  if (config.appt && ["checked_in", "waiting", "with_doctor", "completed"].includes(config.appt.status) && !AFTER_ATTENDED.includes(stage)) {
    problems.push(`appointment is ${config.appt.status} but stage is "${stage}"`);
  }
  if (config.outcome) {
    const allowed = config.outcome.value === "TREATMENT_ADVISED" ? AFTER_ADVISED : AFTER_CONSULT;
    if (!allowed.includes(stage)) problems.push(`outcome ${config.outcome.value} but stage is "${stage}"`);
  }
  if (config.treatment) {
    const allowed = STAGES_BY_TREATMENT[config.treatment.status];
    if (!allowed.includes(stage)) problems.push(`treatment ${config.treatment.status} but stage is "${stage}" (expected ${allowed.join(" / ")})`);
  }
  if (config.treatment && catalogKeys && !catalogKeys.has(config.treatment.definitionKey)) {
    problems.push(`treatment "${config.treatment.definitionKey}" is not in the tenant treatment catalog`);
  }
  if (config.revenueAmount && config.treatment?.status !== "COMPLETED") {
    problems.push("revenue recorded without a COMPLETED treatment");
  }
  return problems;
}

/** Throws with every problem across all configs, so a bad seed fails loudly instead of demoing a contradiction. */
export function assertJourneyConfigsConsistent(label: string, configs: DemoJourneyConfig[], names: string[], catalogKeys?: ReadonlySet<string>): void {
  const lines = configs.flatMap((c) => journeyConfigProblems(c, catalogKeys).map((p) => `  ${label} #${c.patientIdx} ${names[c.patientIdx] ?? "?"} (${c.journeyType}): ${p}`));
  if (lines.length > 0) throw new Error(`Inconsistent demo journeys:\n${lines.join("\n")}`);
}
