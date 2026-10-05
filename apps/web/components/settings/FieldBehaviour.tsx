"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button, CustomFieldInputs, applyFieldRules, defaultsFor } from "@pulseos/ui";
import type { CrmFieldVm, CrmOutcomeVm, FieldRule } from "@pulseos/types";
import { CheckRow, CONTROL, FormField } from "./FormBits";
import { carryForwardAllowed, filterableAllowed, type FieldForm } from "./crmFieldForm";

/** Plain-words behaviour switches: nothing here is a developer term. */
export function BehaviourSettings({ form, set }: { form: FieldForm; set: <K extends keyof FieldForm>(key: K, value: FieldForm[K]) => void }) {
  return (
    <FormField label="Behaviour">
      <div className="space-y-0.5" data-testid="field-behaviour">
        <CheckRow label="Read-only" hint="Can be filled in when the enquiry is created, then staff can't change it." checked={form.readOnly} onChange={(v) => set("readOnly", v)} testId="field-readonly" />
        <CheckRow
          label="Offer as a filter on Leads"
          hint={filterableAllowed(form) ? "Staff can narrow the Leads list by this answer." : "Only choice and Yes/No fields can be used as a filter."}
          checked={form.filterable && filterableAllowed(form)}
          disabled={!filterableAllowed(form)}
          onChange={(v) => set("filterable", v)}
          testId="field-filterable"
        />
        <CheckRow
          label="Carry this value into the next interaction"
          hint={carryForwardAllowed(form) ? "The next time staff log an outcome, this starts filled in with the current answer. Earlier answers stay in the timeline as they were." : "Place the field on Add Lead or Follow-up outcome first."}
          checked={form.carryForward && carryForwardAllowed(form)}
          disabled={!carryForwardAllowed(form)}
          onChange={(v) => set("carryForward", v)}
          testId="field-carry-forward"
        />
      </div>
    </FormField>
  );
}

const blankRule = (outcomes: CrmOutcomeVm[]): FieldRule => ({ when: { outcome: outcomes[0] ? [outcomes[0].key] : [] }, then: "show" });

/** Show / require this field when an outcome is chosen or another field has a given answer. Declarative only. */
export function RulesEditor({ form, set, siblings, outcomes }: { form: FieldForm; set: <K extends keyof FieldForm>(key: K, value: FieldForm[K]) => void; siblings: CrmFieldVm[]; outcomes: CrmOutcomeVm[] }) {
  const choiceSiblings = siblings.filter((s) => s.key !== form.key && !s.archived && (s.fieldType === "SELECT" || s.fieldType === "MULTI_SELECT" || s.fieldType === "BOOLEAN"));
  const optionsOf = (key: string) => {
    const f = choiceSiblings.find((s) => s.key === key);
    return !f ? [] : f.fieldType === "BOOLEAN" ? ["true", "false"] : f.options ?? [];
  };
  const update = (i: number, next: FieldRule) => set("rules", form.rules.map((r, k) => (k === i ? next : r)));
  return (
    <FormField label="Rules" hint="Show or require this field only in some situations — for example, ask for the appointment date only when the outcome is “Appointment booked”.">
      <ul className="space-y-2" data-testid="field-rules">
        {form.rules.map((r, i) => {
          const kind = "outcome" in r.when ? "outcome" : "field";
          return (
            <li key={i} className="space-y-1.5 rounded-control border border-line bg-surface-muted p-2" data-testid={`field-rule-${i}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <select aria-label="What the rule does" className={`${CONTROL} w-auto`} value={r.then} onChange={(e) => update(i, { ...r, then: e.target.value as FieldRule["then"] })}>
                  <option value="show">Show this field</option>
                  <option value="require">Require this field</option>
                </select>
                <span className="text-xs text-ink-2">when</span>
                <select
                  aria-label="Condition type"
                  className={`${CONTROL} w-auto`}
                  value={kind}
                  onChange={(e) => update(i, { ...r, when: e.target.value === "outcome" ? { outcome: outcomes[0] ? [outcomes[0].key] : [] } : { field: choiceSiblings[0]?.key ?? "", equals: [] } })}
                >
                  <option value="outcome">the outcome is</option>
                  <option value="field" disabled={choiceSiblings.length === 0}>another field is</option>
                </select>
                <button type="button" onClick={() => set("rules", form.rules.filter((_, k) => k !== i))} aria-label={`Remove rule ${i + 1}`} className="ml-auto inline-flex h-11 w-9 items-center justify-center rounded-control text-ink-2 hover:bg-danger-100 hover:text-danger-700 sm:h-9">
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              {"outcome" in r.when ? (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {outcomes.map((o) => {
                    const chosen = (r.when as { outcome: string[] }).outcome.includes(o.key);
                    return (
                      <label key={o.key} className="flex min-h-11 items-center gap-1.5 text-xs text-ink sm:min-h-0">
                        <input type="checkbox" checked={chosen} onChange={(e) => update(i, { ...r, when: { outcome: e.target.checked ? [...(r.when as { outcome: string[] }).outcome, o.key] : (r.when as { outcome: string[] }).outcome.filter((k) => k !== o.key) } })} />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-1">
                  <select aria-label="Which field" className={CONTROL} value={r.when.field} onChange={(e) => update(i, { ...r, when: { field: e.target.value, equals: [] } })}>
                    {choiceSiblings.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {optionsOf(r.when.field).map((o) => {
                      const w = r.when as { field: string; equals: string[] };
                      return (
                        <label key={o} className="flex min-h-11 items-center gap-1.5 text-xs text-ink sm:min-h-0">
                          <input type="checkbox" checked={w.equals.includes(o)} onChange={(e) => update(i, { ...r, when: { field: w.field, equals: e.target.checked ? [...w.equals, o] : w.equals.filter((x) => x !== o) } })} />
                          {o === "true" ? "Yes" : o === "false" ? "No" : o}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="secondary" disabled={form.rules.length >= 5} onClick={() => set("rules", [...form.rules, blankRule(outcomes)])} data-testid="field-add-rule">
        <Plus size={14} aria-hidden="true" /> Add rule
      </Button>
    </FormField>
  );
}

/** A lightweight look at the result: the Add Lead form with this field in place, responding to the rules as you try them. */
export function FieldPreview({ draft, siblings, outcomes }: { draft: CrmFieldVm; siblings: CrmFieldVm[]; outcomes: CrmOutcomeVm[] }) {
  const [outcomeKey, setOutcomeKey] = useState("");
  const others = siblings.filter((s) => s.key !== draft.key && !s.archived && s.placements.includes("add_lead"));
  const all = [...others, draft];
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultsFor(all));
  const shown = applyFieldRules(all, values, outcomeKey || null);
  const hiddenNow = !shown.some((f) => f.key === draft.key);
  return (
    <FormField label="Preview on Add Lead" hint="Try the answers to see when this field appears. Nothing here is saved.">
      <div className="space-y-2 rounded-control border border-line bg-surface p-3" data-testid="field-preview">
        {outcomes.length > 0 && (
          <label className="block text-xs text-ink-2">
            Outcome
            <select className={`mt-1 ${CONTROL}`} value={outcomeKey} onChange={(e) => setOutcomeKey(e.target.value)} aria-label="Preview outcome">
              <option value="">No outcome yet</option>
              {outcomes.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
        )}
        <CustomFieldInputs fields={shown} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} idPrefix="field-preview" testId="field-preview-inputs" />
        {hiddenNow && draft.placements.includes("add_lead") && <p className="text-[11px] text-ink-2" data-testid="field-preview-hidden">This field is hidden for these answers.</p>}
        {!draft.placements.includes("add_lead") && <p className="text-[11px] text-ink-2">This field is not placed on Add Lead, so it won&apos;t appear here.</p>}
      </div>
    </FormField>
  );
}

export function useFieldContext(specialtyKey: string) {
  const siblings = useQuery({ queryKey: ["crm-fields", specialtyKey, "context"], queryFn: () => api.crmFields({ specialtyKey }) });
  const outcomes = useQuery({ queryKey: ["crm-outcomes", "active"], queryFn: () => api.crmOutcomes() });
  return { siblings: siblings.data ?? [], outcomes: outcomes.data ?? [] };
}
