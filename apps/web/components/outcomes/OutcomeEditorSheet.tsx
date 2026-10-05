"use client";

import { useState } from "react";
import { api, ApiError } from "@pulseos/api-client";
import { Button, SideSheet } from "@pulseos/ui";
import type { CrmOutcomeVm, TaskType } from "@pulseos/types";
import { CheckRow, FormError, SelectInput, TextInput } from "@/components/settings/FormBits";
import { slugifyKey } from "@/components/settings/crmFieldForm";
import { formToCreateInput, formToUpdateInput, validateOutcomeForm, type OutcomeForm } from "./outcomeForm";

const SAVE_ERRORS: Record<string, string> = {
  key_exists: "An outcome with this name already exists. Choose a different label.",
  invalid_key: "The label needs some letters or numbers.",
};
const FOLLOW_UP_TYPES: { key: TaskType; label: string }[] = [
  { key: "CALLBACK", label: "Callback" },
  { key: "FOLLOW_UP", label: "Follow-up" },
];

/** Create or edit one outcome. Three plain switches are the only rules; the journey stage list itself is fixed. */
export function OutcomeEditorSheet({ mode, initial, outcomeId, onClose, onSaved }: { mode: "create" | "edit"; initial: OutcomeForm; outcomeId?: string; onClose: () => void; onSaved: (o: CrmOutcomeVm) => void }) {
  const [form, setForm] = useState<OutcomeForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = mode === "edit";
  const set = <K extends keyof OutcomeForm>(key: K, value: OutcomeForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    const problem = validateOutcomeForm(form, { editing });
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      const saved = editing && outcomeId ? await api.updateCrmOutcome(outcomeId, formToUpdateInput(form)) : await api.createCrmOutcome(formToCreateInput(form));
      onSaved(saved);
    } catch (err) {
      setError(SAVE_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save this outcome — what you entered is still here. Try again.");
      setSaving(false);
    }
  }

  const key = editing ? form.key : slugifyKey(form.label);
  return (
    <SideSheet
      title={editing ? "Edit outcome" : "Add outcome"}
      subtitle={editing ? form.label : "What staff can record after a call or follow-up"}
      onClose={onClose}
      testId="outcome-editor"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving} data-testid="outcome-save">
            {saving ? "Saving…" : editing ? "Save changes" : "Add outcome"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="outcome-editor-error" />
        <TextInput label="Label" value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Waiting for reports" autoFocus data-testid="outcome-label" hint={key ? `Stored as “${key}”. This name can't change later.` : undefined} />
        <SelectInput label="Recorded under" value={form.stage} disabled={editing} onChange={(e) => set("stage", e.target.value as OutcomeForm["stage"])} data-testid="outcome-stage" hint={editing ? "Fixed once created, so past journeys keep reading the same way. To change it, archive this outcome and add a new one." : "The journey stages are fixed by PulseOS. An outcome only chooses which of these two it belongs to; journeys never move backwards."}>
          <option value="contacted">Contacted</option>
          <option value="lost">Lost</option>
        </SelectInput>
        <div className="space-y-0.5">
          <CheckRow label="Needs a follow-up date and time" hint="Staff must choose when to follow up, and a follow-up task is created." checked={form.requiresFollowUp} onChange={(v) => set("requiresFollowUp", v)} testId="outcome-requires-follow-up" />
          <CheckRow label="Offers to book an appointment" hint="After saving, staff are offered to book one." checked={form.allowsAppointment} onChange={(v) => set("allowsAppointment", v)} testId="outcome-allows-appointment" />
          <CheckRow label="Asks why (optional)" hint="Shows a reason box, for example when the patient is not interested." checked={form.asksReason} onChange={(v) => set("asksReason", v)} testId="outcome-asks-reason" />
        </div>
        <SelectInput label="Follow-up task is a" value={form.followUpType} onChange={(e) => set("followUpType", e.target.value as TaskType)} data-testid="outcome-follow-up-type" hint="Used when a follow-up is scheduled.">
          {FOLLOW_UP_TYPES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </SelectInput>
      </div>
    </SideSheet>
  );
}
