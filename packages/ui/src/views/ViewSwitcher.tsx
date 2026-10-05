"use client";

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface ViewOption<K extends string = string> {
  key: K;
  label: string;
  icon?: ReactNode;
  /** Optional id of the panel this option controls (sets aria-controls). */
  controls?: string;
}

/**
 * Compact segmented control for switching how the SAME data is shown
 * (Table | Kanban, List | Calendar | Kanban). Tab semantics with a roving
 * tabindex: one Tab stop, Left/Right/Up/Down/Home/End move and select
 * (automatic activation - switching a view is cheap and non-destructive).
 * Touch targets are 44px on phones / coarse pointers, 32px otherwise.
 */
export function ViewSwitcher<K extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
}: {
  value: K;
  onChange: (key: K) => void;
  options: ViewOption<K>[];
  ariaLabel: string;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    const target = options[next];
    onChange(target.key);
    refs.current[target.key]?.focus();
  }

  const activeIndex = Math.max(0, options.findIndex((o) => o.key === value));

  return (
    <div role="tablist" aria-label={ariaLabel} className={`glass inline-flex max-w-full gap-0.5 rounded-control p-0.5 ${className}`}>
      {options.map((o, i) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            ref={(el) => {
              refs.current[o.key] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={o.controls}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={() => onChange(o.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            data-testid={`view-switch-${o.key}`}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-medium transition sm:min-h-8 sm:px-2.5 pointer-coarse:min-h-11 ${
              active ? "bg-white text-primary-800 shadow-panel" : "text-ink-2 hover:bg-white/60 hover:text-ink"
            }`}
          >
            {o.icon && <span aria-hidden="true" className="inline-flex">{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
