"use client";

import { addDays } from "@/components/report/reportFilters";
import { DateRangePicker } from "./DateRangePicker";
import { PeriodSelect } from "./PeriodSelect";

export interface PeriodValue {
  range: string | undefined;
  from: string | undefined;
  to: string | undefined;
}

/**
 * Date presets + a custom from/to range, shared by every list that filters by day. Days are hospital calendar days; the
 * caller passes the hospital's `today`. `allowFuture` lets a range reach ahead (follow-ups due next week).
 * `disabled` greys the control when the active view fixes its own date (and says why via `reason`).
 *
 * Both parts are PulseOS-owned UI (a Radix select and a calendar popover), never the browser's native menu or date
 * popup, so they match the product and behave the same on every device.
 */
export function PeriodControls({
  presets,
  value,
  today,
  onChange,
  noneLabel,
  allowFuture = false,
  disabled = false,
  reason,
  testIdPrefix,
  label = "Date range",
  maxSpanDays,
}: {
  presets: readonly { key: string; label: string }[];
  value: PeriodValue;
  today: string;
  onChange: (next: PeriodValue) => void;
  /** Label for "no date filter" when the page has one (Leads: "Any date"). Omit when a range is always set. */
  noneLabel?: string;
  allowFuture?: boolean;
  disabled?: boolean;
  reason?: string;
  testIdPrefix: string;
  label?: string;
  /** The API refuses a longer span; the calendar will not let a range exceed it. */
  maxSpanDays?: number;
}) {
  // An older shared link may carry a preset that is no longer offered: keep it visible instead of a blank control.
  const LEGACY: Record<string, string> = { "14d": "Last 14 days" };
  const options = value.range && LEGACY[value.range] && !presets.some((p) => p.key === value.range) ? [...presets, { key: value.range, label: LEGACY[value.range]! }] : presets;
  return (
    <>
      <PeriodSelect
        ariaLabel={label}
        title={disabled ? reason : undefined}
        value={value.range ?? ""}
        options={options}
        noneLabel={noneLabel}
        disabled={disabled}
        testId={`${testIdPrefix}-range`}
        onChange={(range) => onChange(range === "custom" ? { range, from: addDays(today, -6), to: today } : { range: range || undefined, from: undefined, to: undefined })}
      />
      {value.range === "custom" && !disabled && (
        <div className="flex w-full basis-full items-center sm:w-auto sm:basis-auto" data-testid={`${testIdPrefix}-custom-dates`}>
          <DateRangePicker
            from={value.from}
            to={value.to}
            today={today}
            allowFuture={allowFuture}
            maxSpanDays={maxSpanDays}
            testIdPrefix={testIdPrefix}
            onApply={(r) => onChange({ range: "custom", from: r.from, to: r.to })}
          />
        </div>
      )}
    </>
  );
}
