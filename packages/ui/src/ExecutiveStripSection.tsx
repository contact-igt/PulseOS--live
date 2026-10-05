import type { ExecutiveStrip } from "@pulseos/types";
import { formatInr, formatRoas } from "./format";

interface Metric {
  key: Exclude<keyof ExecutiveStrip, "period">;
  label: string;
  format: (v: number | null) => string;
}

// Order is the reading order of the business: outcome (revenue, the one blue
// anchor) → what it cost → how efficient → what is at risk → the volume
// behind it. On a phone the outcome comes first and spans the full width.
const METRICS: Metric[] = [
  { key: "attributedRevenue", label: "Attributed revenue", format: (v) => formatInr(v ?? 0) },
  { key: "marketingSpend", label: "Marketing spend", format: (v) => formatInr(v ?? 0) },
  { key: "roas", label: "ROAS", format: (v) => formatRoas(v) },
  { key: "spendAtRisk", label: "Spend at risk", format: (v) => formatInr(v ?? 0) },
  { key: "enquiries", label: "Enquiries acquired", format: (v) => String(v ?? 0) },
  { key: "consultations", label: "Consultations", format: (v) => String(v ?? 0) },
  { key: "treatmentsCompleted", label: "Treatments completed", format: (v) => String(v ?? 0) },
];

/**
 * Hospital-level business headline: one connected strip (same material as
 * MetricStrip), attributed revenue as the single blue anchor. Numbers come
 * from `/dashboard/executive`: the selected period (all time when none is
 * sent), whole hospital — branch/service filters do not narrow it.
 *
 * Container-driven columns rather than MetricStrip's fixed one-per-cell row:
 * seven ₹-figures do not fit one line in a ~740px content area, so the strip
 * goes 2 cols (anchor full width) → 4 cols (anchor spans two) → 7 cols.
 */
export function ExecutiveStripSection({ data, onSpendAtRiskClick }: { data: ExecutiveStrip; onSpendAtRiskClick?: () => void }) {
  return (
    <div className="@container">
      <div
        className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line shadow-panel @[30rem]:grid-cols-4 @[68rem]:grid-cols-7"
        data-testid="executive-strip"
      >
        {METRICS.map((m) => {
          const anchor = m.key === "attributedRevenue";
          const clickable = m.key === "spendAtRisk" && !!onSpendAtRiskClick;
          const surface = anchor ? "bg-primary-700 text-white" : "bg-surface";
          const span = anchor ? "col-span-2 @[68rem]:col-span-1" : "";
          const content = (
            <>
              <span className={`block text-xl font-semibold leading-none tabular-nums ${anchor ? "text-white" : "text-ink"}`}>{m.format(data[m.key])}</span>
              <span className={`mt-1.5 block text-xs font-medium leading-tight ${anchor ? "text-primary-100" : "text-ink-2"}`}>{m.label}</span>
            </>
          );
          return clickable ? (
            <button
              key={m.key}
              type="button"
              onClick={onSpendAtRiskClick}
              className={`flex min-w-0 flex-col items-start px-4 py-3 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2 ${surface} ${span}`}
              data-testid={`exec-${m.key}`}
            >
              {content}
            </button>
          ) : (
            <div key={m.key} className={`min-w-0 px-4 py-3 ${surface} ${span}`} data-testid={`exec-${m.key}`}>
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
