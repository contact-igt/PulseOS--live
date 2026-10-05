"use client";

import { useEffect, useRef, useState } from "react";
import { Download, SlidersHorizontal, X } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { REPORT_RANGES, type ReportExportKind, type ReportFilterOptions, type ReportQuery, type ReportRange } from "@pulseos/types";
import { Button, FilterSelect, SideSheet } from "@pulseos/ui";
import { activeReportChips } from "./reportFilters";


const EXPORTS: { kind: ReportExportKind; label: string; hint: string }[] = [
  { kind: "summary", label: "Report summary", hint: "KPIs, day by day, funnel, sources, services, team" },
  { kind: "enquiries", label: "Enquiries", hint: "Every enquiry created in the period" },
  { kind: "appointments", label: "Appointments", hint: "Every visit scheduled in the period" },
  { kind: "follow-ups", label: "Follow-ups", hint: "Due or completed in the period" },
  { kind: "procedures", label: "Procedures", hint: "Scheduled for, Completed on and Payment date, separately" },
];


// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function FilterSelects({ q, options, onChange }: { q: ReportQuery; options?: ReportFilterOptions; onChange: (p: Partial<ReportQuery>) => void }) {
  return (
    <>
      {(options?.branches.length ?? 0) > 1 && (
      <FilterSelect aria-label="Branch" value={q.branchId ?? ""} onChange={(e) => onChange({ branchId: e.target.value })} data-testid="report-filter-branch">
        <option value="">All branches</option>
        {options?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </FilterSelect>
      )}
      <FilterSelect aria-label="Department" value={q.departmentId ?? ""} onChange={(e) => onChange({ departmentId: e.target.value })} data-testid="report-filter-department">
        <option value="">All departments</option>
        {options?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </FilterSelect>
      <FilterSelect aria-label="Service" value={q.service ?? ""} onChange={(e) => onChange({ service: e.target.value })} data-testid="report-filter-service">
        <option value="">All services</option>
        {options?.services.map((s) => <option key={s} value={s}>{s}</option>)}
      </FilterSelect>
      <FilterSelect aria-label="Source" value={q.sourceId ?? ""} onChange={(e) => onChange({ sourceId: e.target.value })} data-testid="report-filter-source">
        <option value="">All sources</option>
        {options?.sources.map((s) => <option key={s.id} value={s.id}>{s.label}{s.archived ? " (archived)" : ""}</option>)}
      </FilterSelect>
      <FilterSelect aria-label="Team member" value={q.ownerId ?? ""} onChange={(e) => onChange({ ownerId: e.target.value })} data-testid="report-filter-owner">
        <option value="">All team members</option>
        {options?.owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </FilterSelect>
      {(options?.doctors.length ?? 0) > 1 && (
      <FilterSelect aria-label="Doctor" value={q.doctorId ?? ""} onChange={(e) => onChange({ doctorId: e.target.value })} data-testid="report-filter-doctor">
        <option value="">All doctors</option>
        {options?.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </FilterSelect>
      )}
    </>
  );
}


function ExportMenu({ q }: { q: ReportQuery }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ReportExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector<HTMLElement>("[data-testid=report-export]")?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function run(kind: ReportExportKind) {
    setBusy(kind);
    setError(null);
    try {
      const { blob, filename } = await api.downloadReport(kind, q);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "You do not have permission to export." : err instanceof ApiError && err.status === 413 ? "Too many rows — narrow the period or filters." : "Export failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="report-export-list" data-testid="report-export">
        <Download size={13} aria-hidden="true" />
        <span className="hidden sm:inline">Export to Excel</span>
        <span className="sm:hidden">Export</span>
      </Button>
      {open && (
        <div id="report-export-list" role="group" aria-label="Export to Excel" className="floating absolute right-0 z-(--z-dropdown) mt-1 w-72 rounded-panel border border-line p-1 shadow-glass" data-testid="report-export-menu">
          {EXPORTS.map((x) => (
            <button
              key={x.kind}
              type="button"
              disabled={busy !== null}
              onClick={() => void run(x.kind)}
              className="flex w-full flex-col items-start rounded-control px-2.5 py-2 text-left transition hover:bg-primary-50 disabled:opacity-60"
              data-testid={`report-export-${x.kind}`}
            >
              <span className="text-xs font-medium text-ink">{busy === x.kind ? `Preparing ${x.label.toLowerCase()}…` : x.label}</span>
              <span className="text-[11px] text-ink-2">{x.hint}</span>
            </button>
          ))}
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-ink-2">Uses the period and filters above · hospital time</p>
        </div>
      )}
      {error && (
        <p role="alert" className="absolute right-0 z-(--z-dropdown) mt-1 w-64 rounded-control bg-white px-2.5 py-1.5 text-xs text-danger-700 shadow-panel" data-testid="report-export-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReportFilterBar({ q, today, options, canExport, defaultRange, onChange, onReset }: { q: ReportQuery & { range: ReportRange }; today: string; options?: ReportFilterOptions; canExport: boolean; defaultRange: ReportRange; onChange: (p: Partial<ReportQuery>) => void; onReset: () => void }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const chips = activeReportChips(q, options);
  const dirty = chips.length > 0 || q.range !== defaultRange;

  return (
    <div className="space-y-2" data-testid="report-filters">
      <div className="glass flex flex-wrap items-center gap-x-2 gap-y-2 rounded-panel px-2.5 py-2">
        <PeriodControls presets={REPORT_RANGES} value={{ range: q.range, from: q.from, to: q.to }} today={today} onChange={(p) => onChange(p.range === "custom" ? { range: "custom", from: p.from, to: p.to } : { range: p.range as ReportRange })} testIdPrefix="report" label="Period" maxSpanDays={366} />
        <div className="hidden flex-wrap items-center gap-2 lg:flex [&_select]:max-w-[9.5rem] xl:[&_select]:max-w-[11rem]">
          <span className="mx-0.5 h-5 w-px bg-line-strong" aria-hidden="true" />
          <FilterSelects q={q} options={options} onChange={onChange} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={onReset} className="hidden lg:inline-flex" data-testid="report-reset">
              Reset
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setSheetOpen(true)} className="max-md:min-h-11 lg:hidden" aria-haspopup="dialog" data-testid="report-filters-open">
            <SlidersHorizontal size={13} aria-hidden="true" />
            Filters
            {chips.length > 0 && <span className="rounded-full bg-primary-600 px-1.5 text-[10px] font-semibold leading-4 text-white">{chips.length}</span>}
          </Button>
          {canExport && <ExportMenu q={q} />}
        </div>
      </div>

      {chips.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters" data-testid="report-chips">
          {chips.map((c) => (
            <li key={c.key}>
              <button type="button" onClick={() => onChange({ [c.key]: "" })} className="inline-flex max-w-[16rem] items-center gap-1 rounded-chip bg-primary-100 px-2 py-0.5 text-[11px] font-medium text-primary-800 transition hover:bg-primary-200" title={`Remove filter — ${c.label}`}>
                <span className="truncate">{c.label}</span>
                <X size={11} aria-hidden="true" />
                <span className="sr-only">remove</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sheetOpen && (
        <div className="lg:hidden">
          <SideSheet
            title="Filters"
            dialogLabel="Report filters"
            subtitle={chips.length > 0 ? `${chips.length} active` : undefined}
            onClose={() => setSheetOpen(false)}
            testId="report-filters-sheet"
            footer={
              <>
                {dirty && <Button variant="ghost" onClick={onReset} className="mr-auto min-h-11" data-testid="report-filters-reset">Reset</Button>}
                <Button variant="primary" onClick={() => setSheetOpen(false)} className="min-h-11">Show results</Button>
              </>
            }
          >
            <div className="flex flex-col gap-2 [&_span]:w-full [&_select]:h-11 [&_select]:text-sm">
              <FilterSelects q={q} options={options} onChange={onChange} />
            </div>
          </SideSheet>
        </div>
      )}
    </div>
  );
}