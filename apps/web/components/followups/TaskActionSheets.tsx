"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button, SideSheet } from "@pulseos/ui";
import type { TaskRow } from "@pulseos/types";
import { CONTROL, FormError, FormField, TextInput } from "@/components/settings/FormBits";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { invalidateFollowUpQueries } from "./AddFollowUpSheet";
import { buildReschedule, rescheduleDefaults } from "./followUpForm";

const ERRORS: Record<string, string> = {
  due_in_past: "Pick a time in the future.",
  already_completed: "This follow-up was already completed.",
  assignee_invalid: "That team member isn't available for this hospital. Choose someone else.",
  task_not_found: "This follow-up no longer exists.",
};
const message = (err: unknown) => ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save — what you entered is still here. Try again.";

/** Move a follow-up to a new time (hospital clock), with an optional reason. Past times are refused. */
export function RescheduleSheet({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const timeZone = useHospitalTimeZone();
  const [wall, setWall] = useState(() => rescheduleDefaults(task.dueAt, timeZone, new Date()));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    const built = buildReschedule(wall.date, wall.time, note, timeZone, new Date());
    if ("error" in built) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      await api.rescheduleTask(task.id, built.dueAt, built.note);
      invalidateFollowUpQueries(queryClient);
      onClose();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title="Reschedule follow-up"
      subtitle={`${task.typeLabel} · ${task.patientName}`}
      onClose={onClose}
      testId="reschedule-followup"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0" onClick={save} disabled={saving} data-testid="reschedule-save">
            {saving ? "Saving…" : "Reschedule"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="reschedule-error" />
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="New date" type="date" value={wall.date} onChange={(e) => setWall((w) => ({ ...w, date: e.target.value }))} data-testid="reschedule-date" />
          <TextInput label="New time" type="time" value={wall.time} onChange={(e) => setWall((w) => ({ ...w, time: e.target.value }))} data-testid="reschedule-time" />
        </div>
        <TextInput label="Reason" hint="Optional — added to the follow-up's note." value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Patient asked for Monday" data-testid="reschedule-note" />
      </div>
    </SideSheet>
  );
}

/** Hand a follow-up to someone else in this hospital. The journey's owner is not changed. */
export function ReassignSheet({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const [assignee, setAssignee] = useState(task.assignedTo ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving || !assignee) return setError("Choose who should do this.");
    setSaving(true);
    setError(null);
    try {
      await api.reassignTask(task.id, assignee);
      invalidateFollowUpQueries(queryClient);
      onClose();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title="Reassign Team Member"
      subtitle={`${task.typeLabel} · ${task.patientName}`}
      onClose={onClose}
      testId="reassign-followup"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0" onClick={save} disabled={saving} data-testid="reassign-save">
            {saving ? "Saving…" : "Reassign Team Member"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="reassign-error" />
        <FormField label="Assigned Team Member" hint="Only this follow-up moves. The journey keeps its assigned team member.">
          <select className={CONTROL} value={assignee} onChange={(e) => setAssignee(e.target.value)} data-testid="reassign-owner">
            <option value="">Choose a person…</option>
            {(lookups.data?.owners ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>
    </SideSheet>
  );
}
