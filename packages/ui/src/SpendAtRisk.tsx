import type { AttentionReason, SpendAtRisk as SpendAtRiskData } from "@pulseos/types";
import { Badge, Panel } from "./primitives";
import { formatInr } from "./format";
import { ATTENTION_REASON_LABEL as REASON_LABEL } from "./status";

/**
 * Spend At Risk: marketing spend tied to journeys that are still active but
 * stalled on a follow-up. Recoverable by definition — never "waste". The
 * total leads; the reasons underneath are a single-hue bar list. `marketingSpend`
 * (optional) adds the share-of-spend context line.
 */
export function SpendAtRisk({
  data,
  marketingSpend,
  onReasonClick,
}: {
  data: SpendAtRiskData;
  /** Total marketing spend, to express the at-risk figure as a share. */
  marketingSpend?: number;
  onReasonClick?: (reason: AttentionReason) => void;
}) {
  const max = Math.max(...data.byReason.map((r) => r.estimatedValue), 1);
  const share = marketingSpend && marketingSpend > 0 ? Math.round((data.totalAtRisk / marketingSpend) * 100) : null;
  const rows = [...data.byReason].sort((a, b) => b.estimatedValue - a.estimatedValue);

  return (
    <Panel
      title="Spend At Risk"
      subtitle="Active journeys awaiting follow-up"
      action={data.totalAtRisk > 0 ? <Badge tone="warning">Recoverable</Badge> : undefined}
      id="spend-at-risk-panel"
    >
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-ink" data-testid="spend-at-risk-total">
          {formatInr(data.totalAtRisk)}
        </span>
        {share !== null && <span className="text-xs text-ink-2">{share}% of marketing spend</span>}
      </div>
      <ul className="@container space-y-0.5">
        {rows.map((row) => (
          <li key={row.reason}>
            <button
              type="button"
              onClick={() => onReasonClick?.(row.reason)}
              className="flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2 disabled:cursor-default"
              disabled={!onReasonClick}
              data-testid={`spend-risk-${row.reason}`}
            >
              <span className={`min-w-0 flex-1 text-xs leading-snug ${row.count === 0 ? "text-ink-2" : "text-ink"}`}>{REASON_LABEL[row.reason]}</span>
              <span className="hidden h-2 w-16 shrink-0 overflow-hidden rounded-full bg-primary-100 @[28rem]:block" aria-hidden="true">
                <span className="block h-full rounded-full bg-primary-500" style={{ width: `${Math.max((row.estimatedValue / max) * 100, row.estimatedValue > 0 ? 6 : 0)}%` }} />
              </span>
              <span className="w-[4.5rem] shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-ink-2">{row.count} {row.count === 1 ? "journey" : "journeys"}</span>
              <span className={`w-16 shrink-0 text-right text-xs font-medium tabular-nums ${row.count === 0 ? "text-ink-2" : "text-ink"}`}>{formatInr(row.estimatedValue)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
