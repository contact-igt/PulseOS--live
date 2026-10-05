"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useFloatingMenu } from "./useFloatingMenu";

export interface QuickCreateItem {
  key: string;
  label: string;
  onClick: () => void;
}

export function QuickCreateMenu({ items }: { items: QuickCreateItem[] }) {
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, onMenuKeyDown } = useFloatingMenu("quick-create", open, setOpen);

  if (items.length === 0) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-1 rounded-control bg-primary-600 px-3 text-xs font-semibold text-white transition hover:bg-primary-700"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="quick-create-button"
      >
        <Plus size={14} />
        Create
      </button>
      {open && (
        <div className="floating absolute right-0 top-full z-(--z-dropdown) mt-1.5 w-44 rounded-card py-1" role="menu" onKeyDown={onMenuKeyDown} data-testid="quick-create-menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="block w-full px-3 py-2 text-left text-xs font-medium text-ink transition hover:bg-primary-50 focus-visible:bg-primary-50 focus-visible:outline-2 focus-visible:[outline-offset:-2px]"
              data-testid={`quick-create-${item.key}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
