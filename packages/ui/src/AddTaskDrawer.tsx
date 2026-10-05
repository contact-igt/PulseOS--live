"use client";

import { useState } from "react";
import type { CreateTaskInput, LookupOption, PatientListRow, TaskPriority, TaskRow, TaskType } from "@pulseos/types";
import { useDialogFocus } from "./useDialogFocus";

const inputClass =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";

const TASK_TYPES: TaskType[] = ["CALLBACK", "FOLLOW_UP", "APPOINTMENT_CONFIRMATION", "NO_SHOW_RECOVERY", "TREATMENT_DECISION", "POST_CARE", "RECALL", "OTHER"];

function defaultDueAt(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  return d.toISOString().slice(0, 16);
}

export function AddTaskDrawer({
  open,
  onClose,
  owners,
  initialPatient,
  initialJourneyId,
  onSearchPatients,
  onSubmit,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  owners: LookupOption[];
  initialPatient?: { id: string; name: string } | null;
  initialJourneyId?: string | null;
  onSearchPatients: (query: string) => Promise<PatientListRow[]>;
  onSubmit: (input: CreateTaskInput) => Promise<TaskRow>;
  onCreated?: (row: TaskRow) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PatientListRow[] | null>(null);
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(initialPatient ?? null);
  const [type, setType] = useState<TaskType>("CALLBACK");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueAt, setDueAt] = useState(defaultDueAt());
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useDialogFocus<HTMLFormElement>(open, onClose);

  if (!open) return null;

  async function runSearch() {
    if (!search.trim()) return;
    setResults(await onSearchPatients(search.trim()));
  }

  const canSubmit = patient && dueAt && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !patient) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await onSubmit({
        patientId: patient.id,
        journeyId: initialJourneyId ?? undefined,
        assignedTo: assignedTo || undefined,
        type,
        priority,
        notes: notes.trim() || undefined,
        dueAt: new Date(dueAt).toISOString(),
      });
      onCreated?.(row);
      onClose();
    } catch {
      setError("Could not create this task. Check the required fields and try again.");
      // See AddPatientDrawer: disabling the submit button on `submitting`
      // blurs it to <body>, outside the dialog, which would let a failed
      // submit silently escape the Tab trap. Pull focus back in.
      dialogRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-sheet) flex justify-end" role="dialog" aria-modal="true" aria-label="Add Task">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 drawer-backdrop bg-slate-900/30" />
      <form
        ref={dialogRef}
        tabIndex={-1}
        onSubmit={handleSubmit}
        className="relative flex h-full w-full max-w-md flex-col overflow-hidden drawer-panel focus:outline-none"
        data-testid="add-task-drawer"
      >
        <div className="flex items-start justify-between gap-2 border-b border-line p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Add Task</h2>
            <p className="mt-0.5 text-xs text-neutral-500">Create a follow-up, callback or other next action.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-slate-900" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <div>
            <label className={labelClass} htmlFor="task-patient-search">
              Patient <span className="text-danger-500">*</span>
            </label>
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm">
                <span className="text-primary-800">{patient.name}</span>
                {!initialPatient && (
                  <button type="button" onClick={() => setPatient(null)} className="text-xs text-primary-600 hover:underline">
                    Change
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    id="task-patient-search"
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), runSearch())}
                    placeholder="Search by name or phone…"
                    className={inputClass}
                  />
                  <button type="button" onClick={runSearch} className="shrink-0 rounded-lg border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
                    Search
                  </button>
                </div>
                {results && (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-neutral-200">
                    {results.length === 0 ? (
                      <p className="p-3 text-center text-xs text-neutral-400">No patient found.</p>
                    ) : (
                      results.map((p) => (
                        <button key={p.id} type="button" onClick={() => { setPatient(p); setResults(null); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-50">
                          <span className="text-slate-900">{p.name}</span>
                          <span className="text-neutral-400">{p.phone}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="task-type">
                Type
              </label>
              <select id="task-type" value={type} onChange={(e) => setType(e.target.value as TaskType)} className={inputClass}>
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="task-priority">
                Priority
              </label>
              <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={inputClass}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="task-due">
              Due <span className="text-danger-500">*</span>
            </label>
            <input id="task-due" type="datetime-local" required value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={inputClass} />
          </div>

          <div>
            <label className={labelClass} htmlFor="task-assignee">
              Assigned Team Member
            </label>
            <select id="task-assignee" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className={inputClass}>
              <option value="">Unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="task-notes">
              Note
            </label>
            <textarea id="task-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
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
          <button type="submit" disabled={!canSubmit} className="flex-1 rounded-control bg-primary-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-primary-700 disabled:opacity-40" data-testid="add-task-submit">
            {submitting ? "Creating…" : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
