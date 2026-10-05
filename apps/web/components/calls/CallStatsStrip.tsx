import type { CallStatsVm } from "@pulseos/types";
import { fmtSmartDateTime } from "@pulseos/ui";

/** Counts straight from this Journey's call records — shown only when there is something to count. */
export function CallStatsStrip({ stats }: { stats: CallStatsVm }) {
  if (stats.total === 0) {
    return (
      <p className="text-xs text-ink-2" data-testid="journey-call-stats">
        No calls yet
      </p>
    );
  }
  const items: [string, number][] = [
    ["Calls", stats.total],
    ["Incoming", stats.incoming],
    ["Outgoing", stats.outgoing],
    ["Connected", stats.connected],
    ["Not connected", stats.notConnected],
  ];
  return (
    <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5" data-testid="journey-call-stats">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dd className="text-sm font-semibold tabular-nums text-ink" data-testid={`call-stat-${label.toLowerCase().replace(/ /g, "-")}`}>
            {value}
          </dd>
          <dt className="text-xs text-ink-2">{label}</dt>
        </div>
      ))}
      {stats.lastCallAt && <p className="text-xs text-ink-2">Last call {fmtSmartDateTime(stats.lastCallAt)}</p>}
    </dl>
  );
}
