"use client";

import { useState } from "react";
import type { CreatePatientInput, CreatePatientResult, LookupOption } from "@pulseos/types";
import { useDialogFocus } from "./useDialogFocus";

const inputClass =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";

export function AddPatientDrawer({
  open,
  onClose,
  branches,
  onSubmit,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  branches: LookupOption[];
  onSubmit: (input: CreatePatientInput) => Promise<CreatePatientResult>;
  onCreated?: (result: CreatePatientResult) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState("English");
  const [pickedBranchId, setBranchId] = useState("");
  // One branch: nothing to choose, so it is used for the user and the field is not shown.
  const soleBranch = branches.length === 1;
  const branchId = pickedBranchId || (soleBranch ? branches[0]!.id : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useDialogFocus<HTMLFormElement>(open, onClose);

  if (!open) return null;

  const canSubmit = name.trim() && phone.trim() && branchId && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit({ name: name.trim(), phone: phone.trim(), email: email.trim() || undefined, preferredLanguage, branchId });
      onCreated?.(result);
      onClose();
    } catch {
      setError("Could not add this patient. Check the required fields and try again.");
      // The submit button is disabled the instant `submitting` flips true
      // (see `disabled={!canSubmit}` below), and a browser blurs whatever
      // element it just disabled — sending focus to <body>, outside this
      // dialog, where the Tab trap's boundary check never engages. Pull
      // focus back into the dialog so a failed submit can't silently
      // escape the trap.
      dialogRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-sheet) flex justify-end" role="dialog" aria-modal="true" aria-label="Add Patient">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 drawer-backdrop bg-slate-900/30" />
      <form
        ref={dialogRef}
        tabIndex={-1}
        onSubmit={handleSubmit}
        className="relative flex h-full w-full max-w-md flex-col overflow-hidden drawer-panel focus:outline-none"
        data-testid="add-patient-drawer"
      >
        <div className="flex items-start justify-between gap-2 border-b border-line p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Add Patient</h2>
            <p className="mt-0.5 text-xs text-neutral-500">Register a patient identity directly, without an enquiry.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-slate-900" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <div>
            <label className={labelClass} htmlFor="patient-name">
              Name <span className="text-danger-500">*</span>
            </label>
            <input id="patient-name" type="text" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="patient-phone">
              Phone <span className="text-danger-500">*</span>
            </label>
            <input id="patient-phone" type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder="+91 98765 43210" />
          </div>
          <div>
            <label className={labelClass} htmlFor="patient-email">
              Email
            </label>
            <input id="patient-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </div>
          {!soleBranch && (
          <div>
            <label className={labelClass} htmlFor="patient-branch">
              Branch <span className="text-danger-500">*</span>
            </label>
            <select id="patient-branch" required value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClass}>
              <option value="">Select branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          )}
          <div>
            <label className={labelClass} htmlFor="patient-language">
              Preferred language
            </label>
            <input id="patient-language" type="text" value={preferredLanguage} onChange={(e) => setPreferredLanguage(e.target.value)} className={inputClass} />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-xs text-danger-700">
              {error}
            </p>
          )}
        </div>

        <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface p-4">
          <button type="button" onClick={onClose} className="flex-1 rounded-control border border-line-strong px-3 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50">
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} className="flex-1 rounded-control bg-primary-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-primary-700 disabled:opacity-40" data-testid="add-patient-submit">
            {submitting ? "Adding…" : "Add Patient"}
          </button>
        </div>
      </form>
    </div>
  );
}
