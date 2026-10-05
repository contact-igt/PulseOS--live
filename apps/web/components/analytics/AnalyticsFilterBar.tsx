"use client";

import { useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { DATE_PRESETS, type AnalyticsFilterOptions, type Branch } from "@pulseos/types";
import { Button, FilterSelect, SOURCE_LABELS, localDayKey, useDialogFocus } from "@pulseos/ui";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { activeFilters, type AnalyticsFilters } from "./filters";
import { PeriodControls } from "@/components/filters/PeriodControls";

interface BarProps {
  filters: AnalyticsFilters;
  options?: AnalyticsFilterOptions;
  branches?: Branch[];
  onChange: (patch: Partial<AnalyticsFilters>) => void;
  onReset: () => void;
}

function Period({ filters, onChange }: Pick<BarProps, "filters" | "onChange">) {
  const today = localDayKey(new Date(), useHospitalTimeZone());
  return (
    <PeriodControls
      presets={DATE_PRESETS}
      maxSpanDays={366}
      value={{ range: filters.range, from: filters.from, to: filters.to }}
      today={today}
      onChange={(p) => onChange({ range: p.range as AnalyticsFilters["range"], from: p.from, to: p.to })}
      testIdPrefix="analytics"
    />
  );
}

function Selects({ filters, options, branches, onChange }: Omit<BarProps, "onReset">) {
  return (
    <>
      {(branches?.length ?? 0) > 1 && (
      <FilterSelect aria-label="Branch" value={filters.branchId ?? ""} onChange={(e) => onChange({ branchId: e.target.value || undefined })} data-testid="filter-branch">
        <option value="">All branches</option>
        {branches?.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </FilterSelect>
      )}
      <FilterSelect aria-label="Service line" value={filters.service ?? ""} onChange={(e) => onChange({ service: e.target.value || undefined })} data-testid="filter-service">
        <option value="">All services</option>
        {options?.services.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect aria-label="Source" value={filters.source ?? ""} onChange={(e) => onChange({ source: (e.target.value || undefined) as AnalyticsFilters["source"] })} data-testid="filter-source">
        <option value="">All sources</option>
        {options?.sources.map((s) => (
          <option key={s} value={s}>
            {SOURCE_LABELS[s]}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect aria-label="Campaign" value={filters.campaignId ?? ""} onChange={(e) => onChange({ campaignId: e.target.value || undefined })} data-testid="filter-campaign">
        <option value="">All campaigns</option>
        {options?.campaigns
          .filter((c) => !filters.source || c.source === filters.source)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </FilterSelect>
    </>
  );
}

function Chips({ filters, options, branches, onChange }: Omit<BarProps, "onReset">) {
  const chips: { key: string; label: string; clear: Partial<AnalyticsFilters> }[] = [];
  if (filters.branchId) chips.push({ key: "branch", label: `Branch: ${branches?.find((b) => b.id === filters.branchId)?.name ?? "…"}`, clear: { branchId: undefined } });
  if (filters.service) chips.push({ key: "service", label: `Service: ${filters.service}`, clear: { service: undefined } });
  if (filters.source) chips.push({ key: "source", label: `Source: ${SOURCE_LABELS[filters.source]}`, clear: { source: undefined } });
  if (filters.campaignId) chips.push({ key: "campaign", label: `Campaign: ${options?.campaigns.find((c) => c.id === filters.campaignId)?.name ?? "…"}`, clear: { campaignId: undefined } });
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters" data-testid="active-filters">
      {chips.map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => onChange(c.clear)}
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-chip bg-primary-100 px-2 py-0.5 text-[11px] font-medium text-primary-800 transition hover:bg-primary-200"
            title={`Remove filter — ${c.label}`}
            data-testid={`chip-${c.key}`}
          >
            <span className="truncate">{c.label}</span>
            <X size={11} aria-hidden="true" />
            <span className="sr-only">remove</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The single filter surface for the workspace. Desktop: one compact glass bar
 * (range, branch, service, source, campaign, reset) with the active filters
 * echoed as chips underneath. Phones: the range stays visible and every other
 * control moves into a "Filters" sheet with focus trap, Escape and focus return.
 */
export function AnalyticsFilterBar(props: BarProps) {
  const { filters, onChange, onReset } = props;
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useDialogFocus<HTMLDivElement>(sheetOpen, () => setSheetOpen(false));
  const active = activeFilters(filters);
  const nonRange = active.filter((a) => a.key !== "range").length;

  return (
    <div className="space-y-2" data-testid="analytics-filters">
      <div className="glass flex flex-wrap items-center gap-x-2 gap-y-2 rounded-panel px-2.5 py-2">
        <Period filters={filters} onChange={onChange} />

        <div className="hidden flex-wrap items-center gap-2 md:flex" data-testid="filter-selects-desktop">
          <span className="mx-0.5 h-5 w-px bg-line-strong" aria-hidden="true" />
          <Selects {...props} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {active.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onReset} data-testid="filters-reset" className="hidden md:inline-flex">
              Reset
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setSheetOpen(true)} className="md:hidden" data-testid="filters-open" aria-haspopup="dialog">
            <SlidersHorizontal size={13} aria-hidden="true" />
            Filters
            {nonRange > 0 && <span className="rounded-full bg-primary-600 px-1.5 text-[10px] font-semibold leading-4 text-white">{nonRange}</span>}
          </Button>
        </div>
      </div>

      <Chips {...props} />

      {sheetOpen && (
        <div className="fixed inset-0 z-(--z-sheet) md:hidden" data-testid="filters-sheet-root">
          <div className="drawer-backdrop absolute inset-0 bg-slate-900/30" onClick={() => setSheetOpen(false)} aria-hidden="true" />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Analytics filters"
            tabIndex={-1}
            className="dialog-panel absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-shell border-b-0 p-4 outline-none"
            data-testid="filters-sheet"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Filters</h2>
              <button type="button" onClick={() => setSheetOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-control text-ink-2 hover:bg-primary-50" aria-label="Close filters" data-testid="filters-close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="flex flex-col gap-2 [&_span]:w-full [&_select]:h-10 [&_select]:text-sm">
              <Selects {...props} />
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={onReset} disabled={active.length === 0}>
                Reset
              </Button>
              <Button variant="primary" onClick={() => setSheetOpen(false)}>
                Show results
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
