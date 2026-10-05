"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface OverflowMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Ellipsis-triggered dropdown for rare/secondary row actions — the shared
 * half of the "row click + one primary action + ellipsis" rule (never a
 * wall of 4-5 buttons per row). Danger items render in the same red used
 * elsewhere for destructive actions, separated visually by a divider.
 */
export function OverflowMenu({ items, testId }: { items: OverflowMenuItem[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (items.length === 0) return null;

  const normal = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-slate-900"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        data-testid={testId ?? "overflow-menu-trigger"}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          className="floating absolute right-0 top-full z-(--z-dropdown) mt-1 w-44 rounded-card py-1"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {normal.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100"
              data-testid={`overflow-item-${item.key}`}
            >
              {item.label}
            </button>
          ))}
          {danger.length > 0 && normal.length > 0 && <div className="my-1 border-t border-neutral-100" />}
          {danger.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-danger-700 hover:bg-danger-100"
              data-testid={`overflow-item-${item.key}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
