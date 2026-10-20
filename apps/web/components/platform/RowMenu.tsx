"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Secondary row actions. The menu is positioned against the viewport (portal + fixed), so it is never clipped by a table's
 * horizontal scroll container, and flips upward near the bottom of the screen. 44px trigger on touch screens.
 */
export function RowMenu({ items, label = "More actions", testId }: { items: RowMenuItem[]; label?: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const up = r.bottom + 220 > window.innerHeight;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: Math.max(8, Math.min(r.right - 192, window.innerWidth - 200)), up });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || trigger.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const scroll = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [open, pos]);

  if (items.length === 0) return null;
  const normal = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  const render = (i: RowMenuItem) => (
    <button
      key={i.key}
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        i.onClick();
      }}
      className={`block min-h-11 w-full px-3 py-2 text-left text-xs sm:min-h-0 sm:py-1.5 ${i.danger ? "text-danger-700 hover:bg-danger-100/60" : "text-neutral-700 hover:bg-neutral-100"} focus-visible:bg-primary-50 focus-visible:outline-none`}
      data-testid={`row-menu-${i.key}`}
    >
      {i.label}
    </button>
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-11 w-11 items-center justify-center rounded-control text-neutral-500 transition hover:bg-neutral-100 hover:text-slate-900 sm:h-7 sm:w-7"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-testid={testId ?? "row-menu"}
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="floating fixed z-(--z-dropdown) w-48 rounded-card py-1"
            style={{ left: pos.left, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
            onClick={(e) => e.stopPropagation()}
          >
            {normal.map(render)}
            {danger.length > 0 && normal.length > 0 && <div className="my-1 border-t border-neutral-100" />}
            {danger.map(render)}
          </div>,
          document.body,
        )}
    </>
  );
}
