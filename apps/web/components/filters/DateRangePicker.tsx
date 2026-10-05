"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays } from "lucide-react";
import { Button, formatKey } from "@pulseos/ui";
import { PulseCalendar } from "./PulseCalendar";
import { clickRangeDay, monthOf, type DraftRange } from "./calendarGrid";

export const POPOVER_SURFACE =
  "floating z-(--z-popover) w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-[14px] p-3 text-ink outline-none";

const short = (day: string) => formatKey(day, { day: "numeric", month: "short", year: "numeric" });

/**
 * The PulseOS custom-range control: a trigger showing "27 Sep 2026 – 3 Oct 2026" that opens a calendar popover. Pick
 * the first and last day, then Apply. Days are hospital calendar days; nothing here reads the browser's timezone.
 */
export function DateRangePicker({
  from,
  to,
  today,
  allowFuture,
  maxSpanDays,
  onApply,
  disabled,
  testIdPrefix,
  label = "Custom date range",
}: {
  from: string | undefined;
  to: string | undefined;
  today: string;
  allowFuture: boolean;
  maxSpanDays?: number;
  onApply: (range: { from: string; to: string }) => void;
  disabled?: boolean;
  testIdPrefix: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftRange>({ from, to });
  const [month, setMonth] = useState(monthOf(to ?? from ?? today));

  const reset = () => {
    setDraft({ from, to });
    setMonth(monthOf(to ?? from ?? today));
  };
  const canApply = !!draft.from;
  const apply = () => {
    if (!draft.from) return;
    onApply({ from: draft.from, to: draft.to ?? draft.from });
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${label}: ${from && to ? `${short(from)} to ${short(to)}` : "choose dates"}`}
          data-testid={`${testIdPrefix}-range-picker`}
          data-from={from}
          data-to={to}
          className="glass-control inline-flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control px-2.5 text-xs font-medium text-ink outline-none transition hover:border-primary-300 focus-visible:border-primary-500 disabled:opacity-50 data-[state=open]:border-primary-500 sm:flex-none max-md:h-11"
        >
          <CalendarDays size={14} className="shrink-0 text-primary-600" aria-hidden="true" />
          <span className="truncate tabular-nums">{from && to ? (from === to ? short(from) : `${short(from)} – ${short(to)}`) : "Choose dates"}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className={POPOVER_SURFACE} aria-label={label} data-testid={`${testIdPrefix}-range-popover`}>
          <div className="mb-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs" aria-live="polite">
            <div className="rounded-lg border border-line bg-primary-50/60 px-2 py-1.5">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-2">From</span>
              <span className="font-medium tabular-nums" data-testid={`${testIdPrefix}-draft-from`}>{draft.from ? short(draft.from) : "—"}</span>
            </div>
            <span className="text-ink-2" aria-hidden="true">→</span>
            <div className="rounded-lg border border-line bg-primary-50/60 px-2 py-1.5">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-2">To</span>
              <span className="font-medium tabular-nums" data-testid={`${testIdPrefix}-draft-to`}>{draft.to ? short(draft.to) : draft.from ? "pick end" : "—"}</span>
            </div>
          </div>
          <PulseCalendar
            month={month}
            onMonthChange={setMonth}
            from={draft.from}
            to={draft.to}
            onPick={(day) => setDraft((d) => clickRangeDay(d, day))}
            disabled={{ today, allowFuture, pendingFrom: draft.from && !draft.to ? draft.from : undefined, maxSpanDays }}
            testIdPrefix={testIdPrefix}
          />
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-lg px-2 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50 max-md:min-h-10"
                onClick={() => {
                  setDraft({ from: today, to: today });
                  setMonth(monthOf(today));
                }}
                data-testid={`${testIdPrefix}-today`}
              >
                Today
              </button>
              <button type="button" className="rounded-lg px-2 py-1.5 text-xs font-medium text-ink-2 hover:bg-primary-50 max-md:min-h-10" onClick={() => setDraft({ from: undefined, to: undefined })} data-testid={`${testIdPrefix}-clear`}>
                Clear
              </button>
            </div>
            <Button variant="primary" size="sm" disabled={!canApply} onClick={apply} className="max-md:min-h-10" data-testid={`${testIdPrefix}-apply`}>
              Apply
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
