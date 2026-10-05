"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button, SOURCE_LABELS, SideSheet } from "@pulseos/ui";
import type { AllocationRuleVm, SourceChannel, SpecialtyTemplateVm } from "@pulseos/types";
import { CheckRow, FormError, FormField, SelectInput, TextInput } from "@/components/settings/FormBits";
import { formToInput, validateRuleForm, type RuleForm } from "./allocationForm";

const SAVE_ERRORS: Record<string, string> = {
  condition_required: "Choose when this rule applies.",
  pool_invalid: "Choose at least one team member to assign enquiries to (front desk, coordinator or admin).",
  branch_invalid: "That branch no longer exists.",
  specialty_invalid: "That service no longer exists.",
};

/** Create or edit one allocation rule: when it applies, and who receives the leads. */
export function AllocationRuleSheet({ mode, initial, ruleId, services, onClose, onSaved }: { mode: "create" | "edit"; initial: RuleForm; ruleId?: string; services: SpecialtyTemplateVm[]; onClose: () => void; onSaved: (r: AllocationRuleVm) => void }) {
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const [form, setForm] = useState<RuleForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const owners = lookups.data?.owners ?? [];

  async function save() {
    const problem = validateRuleForm(form);
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      const saved = mode === "edit" && ruleId ? await api.updateAllocationRule(ruleId, formToInput(form)) : await api.createAllocationRule(formToInput(form));
      onSaved(saved);
    } catch (err) {
      setError(SAVE_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save this rule — what you entered is still here. Try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title={mode === "edit" ? "Edit rule" : "Add rule"}
      subtitle="New enquiries that match go to the people you choose"
      onClose={onClose}
      testId="allocation-editor"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving} data-testid="allocation-save">
            {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="allocation-error" />
        <TextInput label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Meta cataract enquiries" autoFocus data-testid="allocation-name" />

        <fieldset className="space-y-3 rounded-card border border-line p-3">
          <legend className="px-1 text-xs font-semibold text-ink">When a new enquiry…</legend>
          <SelectInput label="Comes from" value={form.source} onChange={(e) => set("source", e.target.value as SourceChannel | "")} data-testid="allocation-source">
            <option value="">Any source</option>
            {(Object.keys(SOURCE_LABELS) as SourceChannel[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </SelectInput>
          <SelectInput label="Is for the service" value={form.specialtyKey} onChange={(e) => set("specialtyKey", e.target.value)} data-testid="allocation-service">
            <option value="">Any service</option>
            {services.map((s) => (
              <option key={s.key} value={s.key}>
                {s.displayName}
              </option>
            ))}
          </SelectInput>
          <TextInput label="Has the journey type" value={form.journeyType} onChange={(e) => set("journeyType", e.target.value)} placeholder="Any (e.g. LASIK)" data-testid="allocation-journey-type" />
          {(lookups.data?.branches.length ?? 0) > 1 && (
            <SelectInput label="At the branch" value={form.branchId} onChange={(e) => set("branchId", e.target.value)} data-testid="allocation-branch">
              <option value="">Any branch</option>
              {(lookups.data?.branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectInput>
          )}
          <p className="text-[11px] text-ink-2">Every choice you make must match. Leave a choice on “Any” to ignore it.</p>
        </fieldset>

        <FormField label="Assign to Team Member" hint="With more than one team member, enquiries are shared in turn. A journey can still be reassigned by hand afterwards.">
          <div className="space-y-0.5" data-testid="allocation-people">
            {owners.length === 0 && <p className="text-xs text-ink-2">No team members to choose from yet.</p>}
            {owners.map((o) => (
              <CheckRow key={o.id} label={o.name} checked={form.userIds.includes(o.id)} onChange={(on) => set("userIds", on ? [...form.userIds, o.id] : form.userIds.filter((x) => x !== o.id))} testId={`allocation-person-${o.id}`} />
            ))}
          </div>
        </FormField>

        <CheckRow label="Rule is on" checked={form.enabled} onChange={(v) => set("enabled", v)} testId="allocation-enabled" />
      </div>
    </SideSheet>
  );
}
