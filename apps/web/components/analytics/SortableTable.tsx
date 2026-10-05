"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { TH } from "./common";

export interface SortColumn<T> {
  key: string;
  label: string;
  /** The value that is shown and sorted (numbers sort numerically, strings by locale). */
  get: (row: T) => string | number | null | undefined;
  /** Optional custom cell; defaults to the value. */
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
  /** The row's name cell (<th scope="row">). */
  rowHeader?: boolean;
  sortable?: boolean;
  /** Extra classes for the cell (e.g. to tint an attention value). */
  cellClass?: (row: T) => string;
}

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

const CELL = "px-2.5 py-1.5 text-xs tabular-nums text-ink";

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

/** Sort rows by a column; empty values are last in either direction, ties keep their original order. */
export function sortRows<T>(rows: T[], col: SortColumn<T> | undefined, dir: "asc" | "desc"): T[] {
  if (!col) return rows;
  const withIndex = rows.map((r, i) => ({ r, i, v: col.get(r) }));
  withIndex.sort((a, b) => {
    const ea = isEmpty(a.v);
    const eb = isEmpty(b.v);
    if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
    const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
    return (dir === "asc" ? c : -c) || a.i - b.i;
  });
  return withIndex.map((x) => x.r);
}

/**
 * An accessible sortable table: header cells carry `aria-sort`, the sort control is a real button (keyboard and screen
 * reader friendly), the table has a caption, and a row can be a drill target (its first cell becomes a button).
 */
export function SortableTable<T>({
  caption,
  rows,
  columns,
  rowKey,
  defaultSort,
  onRowClick,
  rowLabel,
  isDrillable,
  rowTestId,
  testId,
  minWidthClass = "min-w-[32rem]",
  maxHeightClass,
}: {
  caption: string;
  rows: T[];
  columns: SortColumn<T>[];
  rowKey: (row: T) => string;
  defaultSort: SortState;
  onRowClick?: (row: T) => void;
  /** The accessible name of a row's drill button, e.g. "Filter to Cataract". */
  rowLabel?: (row: T) => string;
  /** Rows for which the first cell is NOT a drill button (e.g. "Unassigned"). */
  isDrillable?: (row: T) => boolean;
  rowTestId?: (row: T) => string;
  testId?: string;
  minWidthClass?: string;
  maxHeightClass?: string;
}) {
  const [sort, setSort] = useState<SortState>(defaultSort);
  const sorted = useMemo(() => sortRows(rows, columns.find((c) => c.key === sort.key), sort.dir), [rows, columns, sort]);

  const toggle = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <div className={`overflow-auto rounded-control border border-line ${maxHeightClass ?? ""}`} data-testid={testId}>
      <table className={`w-full ${minWidthClass} border-collapse`}>
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line">
            {columns.map((c) => {
              const active = sort.key === c.key;
              const align = c.align === "left" ? "text-left" : "text-right";
              const sortable = c.sortable !== false;
              return (
                <th key={c.key} scope="col" aria-sort={sortable ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined} className={`${TH} ${align}`}>
                  {sortable ? (
                    <button type="button" onClick={() => toggle(c.key)} className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink max-md:min-h-11 ${c.align === "left" ? "" : "flex-row-reverse"}`} data-testid={`${testId ?? "table"}-sort-${c.key}`}>
                      <span>{c.label}</span>
                      {active ? sort.dir === "asc" ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" /> : <ChevronsUpDown size={11} className="opacity-40" aria-hidden="true" />}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line/60 last:border-0 hover:bg-primary-50/40" data-testid={rowTestId?.(row)}>
              {columns.map((c, i) => {
                const v = c.get(row);
                const content = c.render ? c.render(row) : isEmpty(v) ? "—" : v;
                const cls = `${CELL} ${c.align === "left" ? "text-left" : "text-right"} ${c.cellClass?.(row) ?? ""}`;
                const drill = onRowClick && i === 0 && rowLabel && (isDrillable ? isDrillable(row) : true);
                const inner = drill ? (
                  <button type="button" onClick={() => onRowClick(row)} aria-label={rowLabel(row)} className="max-w-[14rem] truncate text-left font-medium text-primary-700 hover:underline max-md:min-h-11" title={rowLabel(row)}>
                    {content}
                  </button>
                ) : (
                  content
                );
                return c.rowHeader ? (
                  <th key={c.key} scope="row" className={`${cls} font-medium`}>
                    {inner}
                  </th>
                ) : (
                  <td key={c.key} className={cls}>
                    {inner}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
