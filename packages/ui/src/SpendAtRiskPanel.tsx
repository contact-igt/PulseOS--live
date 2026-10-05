import type { SpendAtRiskCategory, SpendAtRiskCategoryKey, SpendAtRiskSummary } from "@pulseos/types";
import { Badge, EmptyState, Panel } from "./primitives";
import { formatInr } from "./format";

export function SpendAtRiskPanel({ data, onCategoryClick }: { data: SpendAtRiskSummary; onCategoryClick?: (key: SpendAtRiskCategoryKey) => void }) {
  const maxSpend = Math.max(...data.categories.map((c) => c.allocatedSpend), 1);

  return (
    <Panel
      title="Spend At Risk"
      action={
        <span className="flex items-center gap-2">
          {data.total > 0 && <Badge tone="warning">Recoverable</Badge>}
          <span className="text-lg font-semibold tabular-nums text-ink">{formatInr(data.total)}</span>
        </span>
      }
    >
      {data.categories.every((c) => c.journeyCount === 0) ? (
        <EmptyState message="No acquired journeys currently need recovery action" />
      ) : (
        <ul className="space-y-0.5">
          {data.categories.map((cat: SpendAtRiskCategory) => (
            <li key={cat.key}>
              <button
                type="button"
                onClick={() => onCategoryClick?.(cat.key)}
                disabled={cat.journeyCount === 0}
                className="flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="w-48 shrink-0 truncate text-xs text-ink">{cat.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-primary-100" aria-hidden="true">
                  <span className="block h-full rounded-full bg-primary-500" style={{ width: `${Math.max((cat.allocatedSpend / maxSpend) * 100, cat.allocatedSpend > 0 ? 4 : 0)}%` }} />
                </span>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-ink">{cat.journeyCount}</span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink">{formatInr(cat.allocatedSpend)}</span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-ink-2">
                  {cat.oldestAgeDays > 0 ? `${cat.oldestAgeDays}d overdue` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
