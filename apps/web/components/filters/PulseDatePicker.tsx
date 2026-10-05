"use client";

import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { PulseCalendar } from "./PulseCalendar";
import { POPOVER_SURFACE } from "./DateRangePicker";
import { monthOf } from "./calendarGrid";

/** A single-day PulseOS date popover. Picking a day applies it immediately; `trigger` is any button content. */
export function PulseDatePicker({
  value,
  today,
  allowFuture = true,
  onChange,
  trigger,
  triggerClassName,
  triggerLabel,
  testIdPrefix,
}: {
  value: string;
  today: string;
  allowFuture?: boolean;
  onChange: (day: string) => void;
  trigger: ReactNode;
  triggerClassName: string;
  triggerLabel: string;
  testIdPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(value));
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setMonth(monthOf(value));
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={triggerClassName} aria-label={triggerLabel} data-testid={`${testIdPrefix}-picker`} data-value={value}>
          {trigger}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={12} className={POPOVER_SURFACE} aria-label="Choose a date" data-testid={`${testIdPrefix}-popover`}>
          <PulseCalendar
            month={month}
            onMonthChange={setMonth}
            from={value}
            to={undefined}
            onPick={(day) => {
              onChange(day);
              setOpen(false);
            }}
            disabled={{ today, allowFuture }}
            testIdPrefix={testIdPrefix}
          />
          <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
            <button
              type="button"
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50 max-md:min-h-10"
              onClick={() => {
                onChange(today);
                setOpen(false);
              }}
              data-testid={`${testIdPrefix}-today`}
            >
              Today
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
