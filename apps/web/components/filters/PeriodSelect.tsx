"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

/** Radix needs a non-empty item value, so "no period" (Leads: "Any date") travels as this sentinel. */
const NONE = "__none__";

/**
 * The PulseOS period dropdown: a white/icy-blue menu with a soft shadow instead of the browser's native list. Arrow
 * keys, Enter, Escape and type-ahead come from Radix. `data-value` carries the active preset key ("" = none).
 */
export function PeriodSelect({
  value,
  options,
  noneLabel,
  onChange,
  disabled,
  title,
  ariaLabel,
  testId,
}: {
  value: string;
  options: readonly { key: string; label: string }[];
  noneLabel?: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  testId: string;
}) {
  const items = noneLabel ? [{ key: NONE, label: noneLabel }, ...options] : [...options];
  const current = value === "" ? NONE : value;
  return (
    <Select.Root value={current} onValueChange={(k) => onChange(k === NONE ? "" : k)} disabled={disabled}>
      <Select.Trigger
        aria-label={ariaLabel}
        title={title}
        data-testid={testId}
        data-value={value}
        className="glass-control inline-flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-control pl-2.5 pr-2 text-xs font-medium text-neutral-700 outline-none transition hover:border-primary-300 focus-visible:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-primary-500 sm:flex-none max-md:h-11 max-md:text-sm"
      >
        <span className="truncate">
          <Select.Value />
        </span>
        <Select.Icon>
          <ChevronDown size={13} className="shrink-0 text-neutral-500" aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="floating z-(--z-popover) min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[12px] text-ink"
          data-testid={`${testId}-menu`}
        >
          <Select.Viewport className="max-h-[min(20rem,var(--radix-select-content-available-height))] p-1">
            {items.map((o) => (
              <Select.Item
                key={o.key}
                value={o.key}
                data-testid={`${testId}-option-${o.key === NONE ? "none" : o.key}`}
                className="relative flex cursor-pointer select-none items-center rounded-lg py-1.5 pl-7 pr-3 text-xs outline-none data-[highlighted]:bg-primary-50 data-[state=checked]:bg-primary-100/70 data-[state=checked]:font-semibold data-[state=checked]:text-primary-800 max-md:min-h-11 max-md:text-sm"
              >
                <Select.ItemIndicator className="absolute left-2 inline-flex items-center text-primary-600">
                  <Check size={13} aria-hidden="true" />
                </Select.ItemIndicator>
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
