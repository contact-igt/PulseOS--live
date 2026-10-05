import type { PatientFlowCount } from "@pulseos/types";
import { Panel } from "./primitives";

const LABELS: Record<PatientFlowCount["bucket"], string> = {
  confirmed: "Confirmed",
  checked_in: "Checked in",
  waiting: "Waiting",
  with_doctor: "With doctor",
  completed: "Completed",
};

const COMPACT_LABELS: Record<PatientFlowCount["bucket"], string> = {
  confirmed: "Confirmed",
  checked_in: "Checked in",
  waiting: "Waiting",
  with_doctor: "With Dr.",
  completed: "Done",
};

// Blue family ordered by progress through the visit, with amber reserved for
// the one genuinely operational state (Waiting). Every bucket is also named
// and counted in the legend, so no meaning rides on colour alone.
const COLORS: Record<PatientFlowCount["bucket"], string> = {
  confirmed: "var(--color-primary-200)",
  checked_in: "var(--color-primary-400)",
  waiting: "var(--color-chart-amber)",
  with_doctor: "var(--color-primary-600)",
  completed: "var(--color-primary-800)",
};

export function PatientFlowBoard({
  data,
  onBucketClick,
  compact = false,
}: {
  data: PatientFlowCount[];
  onBucketClick?: (bucket: PatientFlowCount["bucket"]) => void;
  /** Narrower label set + tighter type for a 1/3-width panel. */
  compact?: boolean;
}) {
  const rawTotal = data.reduce((sum, r) => sum + r.count, 0);
  const total = Math.max(rawTotal, 1);
  const labels = compact ? COMPACT_LABELS : LABELS;

  return (
    <Panel title="Patient Flow Today" subtitle={`${rawTotal} appointments`} data-testid="patient-flow">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-primary-100" data-testid="patient-flow-bar">
        {data.map((row) => (
          <button
            key={row.bucket}
            type="button"
            title={`${LABELS[row.bucket]}: ${row.count}`}
            aria-label={`${LABELS[row.bucket]}: ${row.count}`}
            onClick={() => onBucketClick?.(row.bucket)}
            // A zero-count stage still renders as a thin sliver — never 0px,
            // which would read as "this stage doesn't exist".
            className={`h-full min-w-[4px] transition-opacity hover:opacity-80 ${row.count === 0 ? "opacity-30" : ""}`}
            style={{ width: `${(row.count / total) * 100}%`, backgroundColor: COLORS[row.bucket] }}
            data-testid={`flow-bucket-${row.bucket}`}
          />
        ))}
      </div>
      <ul className="mt-3 grid w-full gap-0.5" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
        {data.map((row) => (
          <li key={row.bucket} className="min-w-0">
            <button
              type="button"
              onClick={() => onBucketClick?.(row.bucket)}
              className="block w-full min-w-0 rounded-control px-1 py-1 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2"
            >
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-sm ring-1 ring-inset ring-primary-700/15" style={{ backgroundColor: COLORS[row.bucket] }} aria-hidden="true" />
                <span className={`font-semibold tabular-nums ${row.count === 0 ? "text-ink-2" : "text-ink"} ${compact ? "text-base" : "text-lg"}`}>{row.count}</span>
              </span>
              <span className="block text-[11px] leading-3.5 text-ink-2">{labels[row.bucket]}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
