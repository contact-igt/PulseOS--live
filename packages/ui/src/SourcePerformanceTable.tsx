"use client";

import { useState } from "react";
import type { ConnectorMode, SourcePerformanceRow } from "@pulseos/types";
import { Badge, Card, Panel, SectionHeading } from "./primitives";
import { formatInr, formatMoneyOrDash, formatMoneyOrDashCompact, formatRoas } from "./format";

type SortKey = "spend" | "enquiries" | "treatments" | "revenue" | "roas";

// A synced campaign's spend/performance numbers are only as real as the
// connector that produced them — a FIXTURE-mode campaign must never read as
// equivalent to a LIVE one anywhere it's shown (Command Centre,
// Campaigns/Sources, Campaign Detail). No badge at all for a
// manually-created campaign with no connectorMode (never synced, so the
// question doesn't apply). Exported — the ONE shared badge, never re-derived
// locally per page.
export function ConnectorModeBadge({ mode }: { mode: ConnectorMode | null }) {
  if (!mode || mode === "LIVE") return null;
  return <Badge tone={mode === "SANDBOX" ? "warning" : "neutral"}>{mode === "SANDBOX" ? "Sandbox" : "Fixture"}</Badge>;
}

export function SourcePerformanceTable({
  rows,
  onRowClick,
  compact = false,
}: {
  rows: SourcePerformanceRow[];
  onRowClick?: (row: SourcePerformanceRow) => void;
  /** Top-5 ranked list (revenue, ROAS, spend, share bar) for a narrow dashboard panel. */
  compact?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>(compact ? "revenue" : "spend");
  const [desc, setDesc] = useState(true);

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    return desc ? bv - av : av - bv;
  });

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDesc((d) => !d);
    else {
      setSortKey(key);
      setDesc(true);
    }
  }

  const columns: { key: SortKey; label: string }[] = [
    { key: "spend", label: "Spend" },
    { key: "enquiries", label: "Enquiries" },
    { key: "treatments", label: "Treatments" },
    { key: "revenue", label: "Revenue" },
    { key: "roas", label: "ROAS" },
  ];

  if (compact) {
    // Names wrap to two lines instead of truncating to "Cataract Consultation ...";
    // a thin single-hue share bar carries revenue at a glance.
    const top = sorted.slice(0, 5);
    const maxRevenue = Math.max(...top.map((r) => r.revenue), 1);
    return (
      <Panel title="Top Campaigns by Revenue" subtitle="ROAS = revenue ÷ spend" padded={false} className="h-full" data-testid="top-campaigns">
        <ul className="divide-y divide-line">
          {top.map((row) => (
            <li key={row.campaignId ?? row.source}>
              <button
                type="button"
                onClick={() => onRowClick?.(row)}
                disabled={!onRowClick}
                className="block w-full px-4 py-2.5 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 min-w-0 text-sm font-medium leading-snug text-ink">{row.campaignName}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{formatMoneyOrDashCompact(row.revenue)}</span>
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <span className="text-[11px] capitalize text-ink-2">{row.source}</span>
                  <ConnectorModeBadge mode={row.connectorMode} />
                  <span className="text-[11px] tabular-nums text-ink-2">· {formatMoneyOrDashCompact(row.spend)} spend</span>
                  <span className="ml-auto text-xs font-medium tabular-nums text-ink">{formatRoas(row.roas)} ROAS</span>
                </span>
                <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-primary-100" aria-hidden="true">
                  <span className="block h-full rounded-full bg-primary-500" style={{ width: `${Math.max((row.revenue / maxRevenue) * 100, row.revenue > 0 ? 3 : 0)}%` }} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  return (
    <Card className="overflow-x-auto p-4">
      <SectionHeading title="Source / Campaign Performance" />
      <table className="w-full min-w-[480px] text-left text-xs">
        <thead>
          <tr className="text-neutral-500">
            <th className="truncate pb-1 font-medium">Campaign</th>
            {columns.map((c) => (
              <th key={c.key} className="cursor-pointer truncate pb-1 text-right font-medium hover:text-slate-900" onClick={() => toggleSort(c.key)}>
                {c.label}{sortKey === c.key ? (desc ? " ↓" : " ↑") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {sorted.map((row) => (
            <tr key={row.campaignId ?? row.source} className="cursor-pointer hover:bg-neutral-50" onClick={() => onRowClick?.(row)}>
              <td className="py-1.5">
                <span className="flex items-center gap-1.5">
                  <span className="block max-w-[220px] truncate text-slate-900">{row.campaignName}</span>
                  <ConnectorModeBadge mode={row.connectorMode} />
                </span>
                <span className="block truncate text-[11px] capitalize text-neutral-400">{row.source}</span>
              </td>
              <td className="py-1.5 text-right tabular-nums">{formatInr(row.spend)}</td>
              <td className="py-1.5 text-right tabular-nums">{row.enquiries}</td>
              <td className="py-1.5 text-right tabular-nums">{row.treatments}</td>
              <td className="py-1.5 text-right tabular-nums">{formatMoneyOrDash(row.revenue)}</td>
              <td className="py-1.5 text-right tabular-nums font-medium">{formatRoas(row.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
