import type { ServiceMixRow } from "@pulseos/types";
import { Badge, EmptyState, Panel } from "./primitives";
import { formatInr } from "./format";

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @[36rem]:grid-cols-[minmax(11rem,1.8fr)_repeat(3,3rem)_minmax(0,1.2fr)]";
/** Revenue tracking off: no revenue column, so the three counts take the space. */
const GRID_NO_REVENUE = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @[36rem]:grid-cols-[minmax(11rem,1.8fr)_repeat(3,4.5rem)]";

/**
 * Service lines (Cataract, Laser Vision Correction, Keratoconus, Oculoplasty,
 * Squint, General Eye Consultation…): journeys, treatments in the pipeline,
 * completed treatments and attributed revenue per line. Revenue is the one
 * encoded measure (single-hue bar, value printed at the end); everything
 * else is a plain number. Selecting a row filters the rest of the dashboard
 * to that service; selecting it again clears the filter.
 */
export function ServiceLinePanel({
  rows,
  selected,
  onSelect,
  showRevenue = true,
}: {
  rows: ServiceMixRow[];
  /** Currently filtered service ("" or undefined = all). */
  selected?: string;
  onSelect?: (service: string) => void;
  /** False for a hospital with revenue tracking off: the panel never mentions revenue. */
  showRevenue?: boolean;
}) {
  const grid = showRevenue ? GRID : GRID_NO_REVENUE;
  const sorted = [...rows].sort((a, b) => (showRevenue ? (b.revenue ?? 0) - (a.revenue ?? 0) : 0) || b.journeys - a.journeys);
  const maxRevenue = Math.max(...sorted.map((r) => r.revenue ?? 0), 1);
  const totalRevenue = sorted.reduce((sum, r) => sum + (r.revenue ?? 0), 0);

  return (
    <Panel
      title="Service Lines"
      subtitle={showRevenue ? "Journeys, treatment pipeline and revenue by service" : "Journeys and treatment pipeline by service"}
      action={<span className="hidden text-xs text-ink-2 sm:inline">{onSelect ? "Select a line to filter this page" : showRevenue ? `${formatInr(totalRevenue)} total` : null}</span>}
      padded={false}
      className="h-full"
      data-testid="service-lines"
    >
      {sorted.length === 0 ? (
        <EmptyState message="No service-line activity yet" />
      ) : (
        <div className="@container">
          <div className={`${grid} hidden border-b border-line px-4 py-2 text-[11px] font-medium text-ink-2 @[36rem]:grid`} aria-hidden="true">
            <span>Service</span>
            <span className="text-right">Journeys</span>
            <span className="text-right">Pipeline</span>
            <span className="text-right">Completed</span>
            {showRevenue && <span className="pl-1">Revenue</span>}
          </div>
          <ul className="divide-y divide-line">
            {sorted.map((row) => {
              const isSelected = !!selected && selected === row.service;
              const width = Math.max(((row.revenue ?? 0) / maxRevenue) * 100, (row.revenue ?? 0) > 0 ? 3 : 0);
              const body = (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{row.service}</span>
                    {isSelected && <Badge tone="primary">Filtered</Badge>}
                  </span>
                  <span className="hidden text-right text-sm tabular-nums text-ink @[36rem]:block">
                    {row.journeys}
                    <span className="block text-[11px] leading-3 text-ink-2">{row.activeJourneys} active</span>
                  </span>
                  <span className="hidden text-right text-sm tabular-nums text-ink @[36rem]:block">{row.treatmentsInPipeline}</span>
                  <span className="hidden text-right text-sm tabular-nums text-ink @[36rem]:block">{row.treatmentsCompleted}</span>
                  {showRevenue && <span className="flex items-center gap-2 @[36rem]:col-auto">
                    <span className="hidden h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-primary-100 @[36rem]:block" aria-hidden="true">
                      <span className="block h-full rounded-full bg-primary-500" style={{ width: `${width}%` }} />
                    </span>
                    <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums text-ink">{(row.revenue ?? 0) > 0 ? formatInr(row.revenue ?? 0) : "—"}</span>
                  </span>}
                  <span className="col-span-2 text-[11px] text-ink-2 @[36rem]:hidden">
                    {row.journeys} journeys · {row.activeJourneys} active · {row.treatmentsInPipeline} in pipeline · {row.treatmentsCompleted} completed
                  </span>
                </>
              );
              const cls = `${grid} w-full px-4 py-2.5 text-left transition ${isSelected ? "bg-primary-50" : ""}`;
              return (
                <li key={row.service}>
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(isSelected ? "" : row.service)}
                      aria-pressed={isSelected}
                      className={`${cls} hover:bg-primary-50 focus-visible:-outline-offset-2`}
                      data-testid={`service-row-${row.service}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={cls} data-testid={`service-row-${row.service}`}>
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
