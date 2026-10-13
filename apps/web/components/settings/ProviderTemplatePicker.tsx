"use client";

import { useId, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { Badge } from "@pulseos/ui";
import { defaultFilter, filterOptions, optionCounts, templateDetails, type PickerFilter, type TemplateOption } from "./providerTemplateForm";

const chip = "inline-flex items-center rounded-chip bg-surface-muted px-1.5 py-0.5 text-[11px] leading-4 text-ink-2 ring-1 ring-inset ring-line";
const FILTERS: { key: PickerFilter; label: string }[] = [
  { key: "suitable", label: "Suitable" },
  { key: "unsuitable", label: "Not suitable" },
  { key: "all", label: "All" },
];

/** The detail chips of one template: the facts an admin compares at a glance. */
function Facts({ option }: { option: TemplateOption }) {
  const d = Object.fromEntries(templateDetails(option.template).map((r) => [r.label, r.value]));
  const n = option.template.bodyParameterCount;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <span className={chip}>{option.template.language}</span>
      {d.Category !== "Not reported" && <span className={chip}>{d.Category}</span>}
      {d.Type !== "Not reported" && <span className={chip}>{d.Type}</span>}
      <span className={chip}>{n} variable{n === 1 ? "" : "s"}</span>
      {option.template.hasHeader && <span className={chip}>Header</span>}
      {option.template.hasButtons && <span className={chip}>Buttons</span>}
    </div>
  );
}

/**
 * Choose one of the hospital's approved WhatsNexus templates. Each row shows what matters (name, language, category, type,
 * number of variables, header, buttons) and whether it fits this message; templates that do not fit stay visible, with why,
 * but cannot be chosen. Searchable, and opens on the ones that fit.
 */
export function ProviderTemplatePicker({
  options,
  selectedValue,
  currentLabel,
  onSelect,
  variableCount,
  testId,
}: {
  options: readonly TemplateOption[];
  selectedValue: string | undefined;
  /** Shown on the button when the saved template is not in the approved list. */
  currentLabel: string | null;
  onSelect: (option: TemplateOption) => void;
  variableCount: number;
  testId: string;
}) {
  const counts = useMemo(() => optionCounts(options), [options]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PickerFilter>(() => defaultFilter(counts));
  const listId = useId();
  const rows = useMemo(() => filterOptions(options, { query, filter }), [options, query, filter]);
  const selected = options.find((o) => o.value === selectedValue);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) { setQuery(""); setFilter(defaultFilter(counts)); }
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="mt-1 flex min-h-11 w-full items-center justify-between gap-3 rounded-control border border-line-strong bg-surface px-3 py-2 text-left outline-none focus:border-primary-500 data-[state=open]:border-primary-500 sm:min-h-10"
          aria-haspopup="listbox"
          data-testid={testId}
        >
          {selected ? (
            <span className="min-w-0">
              <span className="block break-all text-sm font-medium text-ink">{selected.template.name}</span>
              <Facts option={selected} />
            </span>
          ) : (
            <span className="text-sm text-ink-2">{currentLabel ? `${currentLabel} — not an approved template` : "Choose an approved template…"}</span>
          )}
          <ChevronDown size={16} className="shrink-0 text-ink-3" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="floating z-(--z-popover) w-[min(46rem,calc(100vw-1.5rem))] rounded-[14px] p-3 text-ink outline-none"
          data-testid={`${testId}-panel`}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-control border border-line-strong bg-surface px-2.5">
              <Search size={14} className="text-ink-3" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, language or category"
                aria-label="Search approved templates"
                className="h-10 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
                data-testid={`${testId}-search`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={`rounded-chip px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${filter === f.key ? "bg-primary-100 text-primary-700 ring-primary-200" : "bg-surface text-ink-2 ring-line hover:bg-surface-muted"}`}
                  data-testid={`${testId}-filter-${f.key}`}
                >
                  {f.label} ({f.key === "all" ? counts.all : counts[f.key]})
                </button>
              ))}
              <span className="ml-auto text-[11px] text-ink-3">This message uses {variableCount} variable{variableCount === 1 ? "" : "s"}</span>
            </div>
            <ul id={listId} role="listbox" aria-label="Approved WhatsNexus templates" className="max-h-80 space-y-1 overflow-y-auto pr-0.5" data-testid={`${testId}-list`}>
              {rows.length === 0 && <li className="px-2 py-6 text-center text-xs text-ink-2">{query ? "No template matches that search." : filter === "suitable" ? "None of the approved templates fits this message. Choose All to see why." : "Nothing to show."}</li>}
              {rows.map((o) => {
                const isSelected = o.value === selectedValue;
                return (
                  <li key={o.value} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={!o.compatible}
                      onClick={() => { if (!o.compatible) return; onSelect(o); setOpen(false); }}
                      className={`flex w-full items-start gap-3 rounded-card border px-3 py-2 text-left outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-primary-500 ${isSelected ? "border-primary-300 bg-primary-50" : o.compatible ? "border-line bg-surface hover:border-primary-200 hover:bg-surface-info" : "cursor-not-allowed border-line bg-surface-muted/60"}`}
                      data-testid="template-option"
                      data-compatible={o.compatible}
                    >
                      <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${isSelected ? "bg-primary-600 text-white" : "border border-line-strong"}`} aria-hidden>{isSelected && <Check size={11} />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className={`break-all text-sm font-medium ${o.compatible ? "text-ink" : "text-ink-2"}`}>{o.template.name}</span>
                          <Badge tone={o.compatible ? "success" : "neutral"}>{o.compatible ? "Suitable" : "Not suitable"}</Badge>
                        </span>
                        <Facts option={o} />
                        {!o.compatible && o.reason && <span className="mt-1 block text-xs text-danger-700">{o.reason}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
