"use client";

import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import { Button } from "@pulseos/ui";
import { LEAD_COLUMNS, PAGE_SIZES, type LeadColumn, type Page, type PageSize } from "./leadList";

/** Which columns the table shows. A view choice only: nothing about the CRM fields or the data changes. */
export function ColumnPicker({ value, onChange, onReset }: { value: LeadColumn[]; onChange: (next: LeadColumn[]) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} data-testid="leads-columns-button">
        <Columns3 size={14} aria-hidden="true" /> Columns
      </Button>
      {open && (
        <div role="dialog" aria-label="Choose columns" className="floating absolute right-0 z-(--z-dropdown) mt-1 w-56 rounded-panel p-3" data-testid="leads-columns-popover">
          <p className="mb-1 text-[11px] text-ink-2">Patient is always shown.</p>
          <ul>
            {LEAD_COLUMNS.map((c) => (
              <li key={c.key}>
                <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-8">
                  <input
                    type="checkbox"
                    checked={value.includes(c.key)}
                    disabled={value.length === 1 && value.includes(c.key)}
                    onChange={(e) => onChange(LEAD_COLUMNS.map((x) => x.key).filter((k) => (k === c.key ? e.target.checked : value.includes(k))))}
                    data-testid={`leads-column-${c.key}`}
                  />
                  {c.label}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onReset} className="mt-1 text-xs text-primary-700 underline-offset-2 hover:underline">Show all columns</button>
        </div>
      )}
    </div>
  );
}

/** "Showing 26–50 of 143", rows per page and previous / next. The list is already filtered; this only pages it. */
export function PaginationBar({ page, size, onPage, onSize }: { page: Page<unknown>; size: PageSize; onPage: (p: number) => void; onSize: (s: PageSize) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-2" data-testid="leads-pagination">
      <span data-testid="leads-result-count" aria-live="polite">{page.total === 0 ? "No leads" : `Showing ${page.from}–${page.to} of ${page.total}`}</span>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          Rows
          <select value={size} onChange={(e) => onSize(Number(e.target.value) as PageSize)} className="h-11 rounded-control border border-line-strong bg-surface px-1.5 text-xs text-ink sm:h-8" data-testid="leads-page-size">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <Button variant="secondary" size="sm" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)} data-testid="leads-prev">Previous</Button>
        <span aria-hidden="true">{page.page} / {page.pages}</span>
        <Button variant="secondary" size="sm" disabled={page.page >= page.pages} onClick={() => onPage(page.page + 1)} data-testid="leads-next">Next</Button>
      </div>
    </div>
  );
}
