"use client";

import { useState } from "react";
import { useDialogFocus } from "@pulseos/ui";
import type { LookupOption } from "@pulseos/types";

/**
 * Small centered dialog for (re)assigning journey ownership: a single owner
 * select plus Assign / Cancel. Used for one journey (Journey page, Leads row)
 * and for a bulk selection (`subject` describes what is being assigned).
 * Focus is trapped, Escape and backdrop cancel, and focus returns to the
 * trigger (useDialogFocus). The caller owns the mutation: `onSubmit` receives
 * the chosen owner id (null = unassign) and may reject to show an inline error.
 */
export function AssignOwnerDialog({
  open,
  subject,
  owners,
  initialOwnerId,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** e.g. "Geetha Bhat" or "2 journeys". */
  subject: string;
  owners: LookupOption[];
  initialOwnerId: string | null;
  onSubmit: (ownerId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(open, onClose);
  const [value, setValue] = useState<string>(initialOwnerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value === "" ? null : value);
    } catch {
      setError("Could not update the team member. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-dialog) flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="assign-owner-title">
      <button type="button" aria-label="Cancel" tabIndex={-1} onClick={onClose} className="drawer-backdrop absolute inset-0 bg-slate-900/40" />
      <div ref={dialogRef} tabIndex={-1} className="dialog-panel relative w-full max-w-sm rounded-panel p-5 focus:outline-none" data-testid="assign-owner-dialog">
        <h2 id="assign-owner-title" className="text-sm font-semibold text-ink">Assign Team Member</h2>
        <p className="mt-1 text-xs text-ink-2">Choose who follows up {subject}.</p>
        <label htmlFor="assign-owner-select" className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-ink-2">Team Member</label>
        <select
          id="assign-owner-select"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 h-9 w-full rounded-control border border-line-strong bg-white px-2.5 text-sm text-ink outline-none focus-visible:border-primary-500"
          data-testid="assign-owner-select"
        >
          <option value="">Unassigned</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        {error && <p role="alert" className="mt-2 text-xs text-danger-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-control border border-line-strong bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50" data-testid="assign-owner-cancel">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy} className="rounded-control bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50" data-testid="assign-owner-submit">
            {busy ? "Saving…" : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}
