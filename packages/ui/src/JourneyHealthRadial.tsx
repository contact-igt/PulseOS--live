import type { JourneyHealth } from "@pulseos/types";
import { SegmentedRadial } from "./SegmentedRadial";

// Cobalt → teal → light-blue → slate → navy — five distinguishable stops
// without reaching for purple (never used for AI/automation or anywhere
// else in this palette) or amber (reserved for operational warnings only —
// "consulted" is a healthy funnel stage, not a warning state, and chart-amber
// is the literal same hex as the warning/danger semantic tone).
const COLORS: Record<string, string> = {
  contacted: "var(--color-primary-700)",
  booked: "var(--color-chart-teal)",
  attended: "var(--color-primary-400)",
  consulted: "var(--color-neutral-600)",
  treatment_advised: "var(--color-primary-800)",
};

export function JourneyHealthRadial({ data, onSegmentClick }: { data: JourneyHealth; onSegmentClick?: (key: string) => void }) {
  return (
    <SegmentedRadial
      title="Journey Health"
      subtitle={`${data.totalJourneys} journeys`}
      segments={data.segments.map((s) => ({ key: s.key, label: s.label, count: s.count, pct: s.pct, color: COLORS[s.key] ?? "var(--color-chart-blue)" }))}
      centerLabel="Conversion"
      centerValue={`${data.overallPct}%`}
      onSegmentClick={onSegmentClick}
      testId="journey-health-radial"
    />
  );
}
