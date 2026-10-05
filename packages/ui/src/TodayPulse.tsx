import type { TodayStrip } from "@pulseos/types";
import { Card } from "./primitives";
import { formatInrCompact } from "./format";

interface Stat {
  key: keyof TodayStrip;
  label: string;
  format?: (n: number) => string;
}

const STATS: Stat[] = [
  { key: "newEnquiries", label: "New enquiries" },
  { key: "appointmentsToday", label: "Appointments" },
  { key: "waitingNow", label: "Waiting now" },
  { key: "consultationsCompleted", label: "Consultations" },
  { key: "treatmentDecisionsPending", label: "Treatment decisions" },
  { key: "attributedRevenue", label: "Revenue today", format: formatInrCompact },
];

/**
 * Today's operational pulse: deliberately quieter than the hospital-level
 * headline strip above it (info surface, small numbers, no anchor cell).
 * Every stat drills into the filtered Patients list.
 */
export function TodayPulse({ data, onStatClick }: { data: TodayStrip; onStatClick?: (key: keyof TodayStrip) => void }) {
  // A hospital with revenue tracking off gets no revenue figure at all (null), not a zero.
  const stats = STATS.filter((s) => data[s.key] !== null);
  return (
    <Card tone="info" className="@container flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4" data-testid="kpi-strip">
      <p className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Today</p>
      <ul className={`grid min-w-0 flex-1 grid-cols-3 gap-x-2 gap-y-1 ${stats.length === 6 ? "@[48rem]:grid-cols-6" : "@[48rem]:grid-cols-5"}`}>
        {stats.map((s) => {
          const raw = data[s.key] as number;
          const value = s.format ? s.format(raw) : raw;
          const body = (
            <>
              <span className="block text-base font-semibold leading-5 tabular-nums text-ink">{value}</span>
              <span className="block text-[11px] leading-4 text-ink-2">{s.label}</span>
            </>
          );
          return (
            <li key={s.key} className="min-w-0">
              {onStatClick ? (
                <button
                  type="button"
                  onClick={() => onStatClick(s.key)}
                  className="block w-full rounded-control px-1.5 py-1 text-left transition hover:bg-white/70 focus-visible:-outline-offset-2"
                  data-testid={`kpi-${s.key}`}
                >
                  {body}
                </button>
              ) : (
                <div className="px-1.5 py-1" data-testid={`kpi-${s.key}`}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
