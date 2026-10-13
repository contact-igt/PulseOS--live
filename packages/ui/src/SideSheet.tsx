"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "./useDialogFocus";

/**
 * A right-hand sheet for quick create / edit (full width on a phone). One dialog system for every
 * configuration editor: focus moves in on open, Tab is trapped, Escape / the close button / the
 * backdrop close it and focus returns to what opened it. It can also present one editor as a centered dialog.
 * The body scrolls; the footer stays pinned.
 */
export function SideSheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testId = "side-sheet",
  dialogLabel,
  presentation = "sheet",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  /** Accessible name of the dialog when it should differ from the visible title (e.g. a person's name as the title). */
  dialogLabel?: string;
  /** Use a centered dialog for detail-heavy content; sheets remain the default for editors. */
  presentation?: "sheet" | "dialog";
}) {
  const ref = useDialogFocus<HTMLDivElement>(true, onClose);
  const centered = presentation === "dialog";
  return (
    <div className={`fixed inset-0 z-(--z-sheet) flex ${centered ? "items-center justify-center p-4" : "justify-end"}`} role="dialog" aria-modal="true" aria-label={dialogLabel ?? title}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 drawer-backdrop bg-slate-900/30" data-testid="side-sheet-backdrop" />
      <div ref={ref} tabIndex={-1} className={`relative flex w-full flex-col overflow-hidden focus:outline-none ${centered ? "max-h-[calc(100dvh-2rem)] max-w-4xl rounded-panel dialog-panel" : "h-full max-w-lg drawer-panel"}`} data-testid={testId}>
        <div className="flex items-start justify-between gap-2 border-b border-line p-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-xs text-ink-2">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-primary-50 hover:text-ink sm:h-8 sm:w-8">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5" data-testid="side-sheet-body">
          {children}
        </div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface p-4">{footer}</div>}
      </div>
    </div>
  );
}
