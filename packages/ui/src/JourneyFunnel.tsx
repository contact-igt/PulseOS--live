import { Card } from "./primitives";

export interface JourneyFunnelStage {
  key: string;
  label: string;
  count: number;
}

/**
 * Conversion funnel: Enquiry → Contacted → Booked → Attended → Consulted →
 * Treatment Converted. Bar width and the percentage are both % of the first
 * stage ("how much of our starting volume is still here"); the drop-off
 * column is the percentage-point loss since the previous stage. One blue hue,
 * thin rounded bars on a recessive track — a list you can read, not a
 * tapered marketing graphic.
 */
export function JourneyFunnel({ stages, onStageClick, testId }: { stages: JourneyFunnelStage[]; onStageClick?: (key: string) => void; testId?: string }) {
  const first = stages[0]?.count ?? 0;
  const last = stages[stages.length - 1]?.count ?? 0;
  const overallPct = first > 0 ? Math.round((last / first) * 100) : 0;

  // Largest single-step loss between adjacent stages, from the same counts.
  let biggest: { from: string; to: string; points: number } | null = null;
  for (let i = 1; i < stages.length; i++) {
    const points = first > 0 ? Math.round(((stages[i - 1].count - stages[i].count) / first) * 100) : 0;
    if (points > 0 && (!biggest || points > biggest.points)) biggest = { from: stages[i - 1].label, to: stages[i].label, points };
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden" data-testid={testId ?? "journey-funnel"}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="min-w-0 text-sm font-semibold tracking-tight text-ink">Patient Journey Performance</h2>
          <span className="text-xs text-ink-2">% of enquiries reaching each stage</span>
        </div>
        <span className="shrink-0 text-right text-xs text-ink-2">
          <span className="text-base font-semibold tabular-nums text-ink" data-testid="funnel-overall">{overallPct}%</span> enquiry → treatment
        </span>
      </div>
      <ul className="flex flex-1 flex-col justify-around p-3">
        {stages.map((stage, idx) => {
          const pctOfFirst = first > 0 ? Math.round((stage.count / first) * 100) : 0;
          const prevPctOfFirst = idx > 0 && first > 0 ? Math.round((stages[idx - 1].count / first) * 100) : null;
          const dropOffPoints = prevPctOfFirst !== null ? prevPctOfFirst - pctOfFirst : null;
          const barWidthPct = first > 0 ? Math.max(pctOfFirst, stage.count > 0 ? 3 : 0) : 0;

          return (
            <li key={stage.key}>
              <button
                type="button"
                onClick={() => onStageClick?.(stage.key)}
                title={`${stage.label}: ${stage.count} patients (${pctOfFirst}% of enquiries)${dropOffPoints ? ` — ${dropOffPoints}pp drop-off from the previous stage` : ""}`}
                className="flex w-full items-center gap-3 rounded-control px-2 py-2.5 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2 disabled:cursor-default disabled:hover:bg-transparent"
                disabled={!onStageClick}
                data-testid={`funnel-stage-${stage.key}`}
              >
                <span className="w-[6.5rem] shrink-0 text-sm leading-tight text-ink sm:w-36">{stage.label}</span>
                <span className="h-2.5 min-w-[24px] flex-1 overflow-hidden rounded-full bg-primary-100">
                  <span className="block h-full rounded-full bg-primary-500" style={{ width: `${barWidthPct}%` }} />
                </span>
                <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-ink">{stage.count}</span>
                <span className="w-10 shrink-0 text-right text-xs font-medium tabular-nums text-ink-2">{pctOfFirst}%</span>
                <span className="hidden w-14 shrink-0 text-right text-[11px] tabular-nums text-ink-2 sm:block">
                  {dropOffPoints !== null && dropOffPoints > 0 ? `-${dropOffPoints}pp` : dropOffPoints === 0 ? "flat" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {biggest && (
        <p className="border-t border-line bg-surface-info px-4 py-2.5 text-xs text-ink-2" data-testid="funnel-biggest-drop">
          Largest drop-off: <span className="font-medium text-ink">{biggest.from} → {biggest.to}</span> ({`-${biggest.points}pp`} of enquiries)
        </p>
      )}
    </Card>
  );
}
