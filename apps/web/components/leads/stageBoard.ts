import { JOURNEY_STAGE_LABEL } from "@pulseos/ui";
import type { JourneyStage, LeadRow } from "@pulseos/types";

const STAGE_ORDER: JourneyStage[] = ["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed", "lost"];

/** One read-only board column per journey stage, in the order a journey moves through them. */
export const STAGE_COLUMNS = STAGE_ORDER.map((key) => ({ key, title: JOURNEY_STAGE_LABEL[key] }));

export function countByStage(rows: LeadRow[]): Record<JourneyStage, number> {
  const counts = Object.fromEntries(STAGE_ORDER.map((k) => [k, 0])) as Record<JourneyStage, number>;
  for (const r of rows) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  return counts;
}
