"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

const OPENED = "pulseos:menu-opened";

/**
 * Only one floating menu is open at a time: opening one announces itself and every other menu that listens closes.
 * Used by the top bar's Create, account and search menus (the screenshot that started this showed two open at once).
 */
export function useExclusiveMenu(id: string, open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent(OPENED, { detail: id }));
  }, [open, id]);
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) closeRef.current();
    };
    window.addEventListener(OPENED, onOther);
    return () => window.removeEventListener(OPENED, onOther);
  }, [id]);
}

/**
 * The behaviour every menu button + panel pair shares: exclusive with other menus, closes on a click outside or on
 * Escape (Escape returns focus to the trigger), and ArrowUp/ArrowDown/Home/End move between its `role="menuitem"` rows.
 * Attach `containerRef` to the wrapper around BOTH trigger and panel, `triggerRef` to the trigger button.
 */
export function useFloatingMenu(id: string, open: boolean, setOpen: (open: boolean) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useExclusiveMenu(id, open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  function onMenuKeyDown(e: ReactKeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next]!.focus();
  }

  return { containerRef, triggerRef, onMenuKeyDown };
}
