"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared focus management for a modal drawer/dialog: moves focus into it on
 * open, traps Tab/Shift+Tab within it while open, closes on Escape, and
 * restores focus to whatever triggered it once it closes. One system for
 * every drawer in the app instead of each one reinventing it.
 *
 * Attach the returned ref to the dialog's outer container (give the
 * container `tabIndex={-1}` too, as a focus target when it has no
 * focusable children of its own).
 */
export function useDialogFocus<T extends HTMLElement>(active: boolean, onClose: () => void) {
  const containerRef = useRef<T>(null);
  const triggerRef = useRef<Element | null>(null);
  // Keeps the effect below from re-running (and re-grabbing focus) just
  // because the caller passed a new onClose closure identity this render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    triggerRef.current = document.activeElement;

    const container = containerRef.current;
    const focusables = () => (container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : []);
    (focusables()[0] ?? container)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      // An action can unmount or disable the focused control (focus falls to
      // <body>); the next Tab must land back inside the dialog, not behind it.
      if (!container.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [active]);

  return containerRef;
}
