"use client";

import type { AnalyticsFlow, AnalyticsServices } from "@pulseos/types";
import {
  CHART_INK,
  ChartEmptyState,
  ChartLegend,
  Table,
  TableBody,
  TableHead,
  TableShell,
  Td,
  Th,
  Tr,
  fmtCountNum,
  formatInr,
  formatInrCompact,
} from "@pulseos/ui";

/** Outcome segments, furthest first. Blue steps are ordinal (validated: adjacent lightness gaps >= 0.06); the two neutrals are "did not progress" states. */
const OUTCOMES: { id: string; label: string; fill: string; dark: boolean }[] = [
  { id: "outcome:completed", label: "Treatment completed", fill: "#1c5cab", dark: true },
  { id: "outcome:treatment", label: "Treatment advised", fill: "#2a78d6", dark: true },
  { id: "outcome:consulted", label: "Consulted", fill: "#5598e7", dark: true },
  { id: "outcome:appointment", label: "Appointment stage", fill: "#86b6ef", dark: false },
  { id: "outcome:not_progressed", label: "Not progressed", fill: "#dbe6f3", dark: false },
  { id: "outcome:lost", label: "Lost", fill: "#9fb2c8", dark: false },
];

interface OutcomeRow {
  id: string;
  label: string;
  total: number;
  counts: Record<string, number>;
}

function OutcomeGroup({ title, rows }: { title: string; rows: OutcomeRow[] }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</h3>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2" data-testid={`outcome-row-${row.id}`}>
            <span className="w-24 shrink-0 truncate text-xs text-ink sm:w-44" title={row.label}>
              {row.label}
            </span>
            <span
              className="flex h-6 min-w-0 flex-1 gap-0.5"
              role="img"
              aria-label={`${row.label}: ${OUTCOMES.filter((o) => row.counts[o.id]).map((o) => `${row.counts[o.id]} ${o.label.toLowerCase()}`).join(", ")}`}
            >
              {OUTCOMES.filter((o) => row.counts[o.id] > 0).map((o) => {
                const n = row.counts[o.id];
                return (
                  <span
                    key={o.id}
                    className="flex min-w-[6px] items-center justify-center overflow-hidden rounded-[3px] text-[11px] font-semibold tabular-nums leading-none"
                    style={{ flexGrow: n, flexBasis: 0, backgroundColor: o.fill, color: o.dark ? "#fff" : CHART_INK.primary }}
                    title={`${o.label}: ${n} of ${row.total} (${Math.round((n / row.total) * 100)}%)`}
                  >
                    {n / row.total >= 0.09 ? n : ""}
                  </span>
                );
              })}
            </span>
            <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-ink">{fmtCountNum(row.total)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Staged outcome view: for every source and every service line, where its
 * journeys have got to. Each journey sits in exactly one segment (its furthest
 * stage), "Not progressed" and "Lost" are explicit, and each row is a
 * 100%-stacked bar so rows of different volume compare on shape while the
 * count at the right keeps the volume honest.
 *
 * A Sankey was tried and rejected: at a few dozen journeys the ribbons are one
 * or two journeys wide, cross constantly, and read as noise; this shows the
 * same facts without inventing structure.
 */
export function JourneyOutcomes({ data }: { data: AnalyticsFlow }) {
  if (data.total === 0) return <ChartEmptyState height={200} message="No journeys in this period" />;
  const outcomeIds = new Set(OUTCOMES.map((o) => o.id));
  const bySource: OutcomeRow[] = data.nodes
    .filter((n) => n.kind === "source")
    .map((n) => {
      const counts: Record<string, number> = {};
      for (const l of data.sourceOutcomes) if (l.source === n.id && outcomeIds.has(l.target)) counts[l.target] = l.value;
      return { id: n.id, label: n.label, total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
    })
    .sort((a, b) => b.total - a.total);
  const byService: OutcomeRow[] = data.nodes
    .filter((n) => n.kind === "service")
    .map((n) => {
      const counts: Record<string, number> = {};
      for (const l of data.links) if (l.source === n.id && outcomeIds.has(l.target)) counts[l.target] = l.value;
      return { id: n.id, label: n.label, total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
    })
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-4" data-testid="journey-outcomes">
      <ChartLegend items={OUTCOMES.map((o) => ({ key: o.id, label: o.label, color: o.fill }))} />
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
        <OutcomeGroup title="By source" rows={bySource} />
        <OutcomeGroup title="By service line" rows={byService} />
      </div>
      <p className="text-[11px] leading-4 text-ink-2">
        Journeys created in the period, at the furthest stage they have reached. Lost journeys are shown as lost — the stage they were lost from is not recorded. Hover a segment for its count and share.
      </p>
    </div>
  );
}

/** Mini columns of enquiries per bucket, on a fixed 96px canvas. Honest: bars, not a smoothed line through sparse counts. */
function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const W = 96;
  const H = 18;
  const slot = W / Math.max(values.length, 1);
  const barW = Math.max(slot - 1, 1);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="block">
      {values.map((v, i) => {
        const h = v > 0 ? Math.max((v / max) * (H - 2), 2) : 1;
        return <rect key={i} x={i * slot} y={H - h} width={barW} height={h} rx={1} fill={v > 0 ? CHART_INK.accent : CHART_INK.track} />;
      })}
    </svg>
  );
}

/** Service-line table: volume, progress and revenue side by side, with a per-period trend. */
export function ServiceLines({ data, onServiceClick, activeService }: { data: AnalyticsServices; onServiceClick?: (service: string) => void; activeService?: string }) {
  if (data.rows.length === 0) return <ChartEmptyState height={160} message="No service-line activity in this period" />;
  const maxRevenue = Math.max(...data.rows.map((r) => r.revenue), 1);
  return (
    <div data-testid="service-lines-table">
      <TableShell className="border-0 shadow-none">
        <Table>
          <TableHead>
            <tr>
              <Th leading>Service line</Th>
              <Th align="right">Enquiries</Th>
              <Th align="right" title="Enquiries that reached an appointment">Appts</Th>
              <Th align="right" title="Enquiries that reached a consultation">Consulted</Th>
              <Th align="right" title="Enquiries advised treatment or beyond">Advised</Th>
              <Th align="right" title="Completed treatments">Treated</Th>
              <Th align="right">Revenue</Th>
              <Th>Trend</Th>
            </tr>
          </TableHead>
          <TableBody>
            {data.rows.map((r) => (
              <Tr key={r.service} onClick={onServiceClick ? () => onServiceClick(r.service) : undefined} className={activeService === r.service ? "bg-primary-50" : ""} data-testid={`service-row-${r.service}`}>
                <Td leading nowrap={false}>
                  <span className="text-xs font-medium text-ink">{r.service}</span>
                </Td>
                <Td align="right">{fmtCountNum(r.leads)}</Td>
                <Td align="right">{fmtCountNum(r.appointments)}</Td>
                <Td align="right">{fmtCountNum(r.consultations)}</Td>
                <Td align="right">{fmtCountNum(r.treatmentsAdvised)}</Td>
                <Td align="right">{fmtCountNum(r.treatmentsCompleted)}</Td>
                <Td align="right" title={r.revenue > 0 ? formatInr(r.revenue) : undefined}>
                  <span className="inline-flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-12 overflow-hidden rounded-full sm:block" style={{ backgroundColor: CHART_INK.track }} aria-hidden="true">
                      <span className="block h-full rounded-full" style={{ width: `${(r.revenue / maxRevenue) * 100}%`, backgroundColor: CHART_INK.accent }} />
                    </span>
                    <span className="w-14 text-right font-semibold">{r.revenue > 0 ? formatInrCompact(r.revenue) : "—"}</span>
                  </span>
                </Td>
                <Td>
                  <Spark values={r.trend} />
                </Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      </TableShell>
    </div>
  );
}
