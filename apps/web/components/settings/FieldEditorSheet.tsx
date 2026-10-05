"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { Button, SideSheet } from "@pulseos/ui";
import { ALL_SERVICES_KEY, CUSTOM_FIELD_TYPES, FIELD_GROUPS, FIELD_PLACEMENTS, FIELD_VISIBILITY, type CrmFieldVm, type CustomFieldType, type FieldPlacement, type SpecialtyTemplateVm } from "@pulseos/types";
import { CheckRow, CONTROL, FormError, FormField, SelectInput, TextInput } from "./FormBits";
import { BehaviourSettings, FieldPreview, RulesEditor, useFieldContext } from "./FieldBehaviour";
import { formToCreateInput, formToUpdateInput, isChoiceType, slugifyKey, validateFieldForm, type FieldForm } from "./crmFieldForm";

const SAVE_ERRORS: Record<string, string> = {
  key_exists: "A field with this name already exists for this service. Choose a different label.",
  field_has_values: "This field already has values, so its type can't be changed. Archive it and add a new field instead.",
  options_invalid: "Options can't be empty or repeated.",
  default_invalid: "The default value doesn't fit this type of field.",
  specialty_not_found: "That service no longer exists.",
  rule_unknown_outcome: "A rule names an outcome that doesn't exist.",
  rule_unknown_field: "A rule names a field that doesn't exist for this service.",
  rule_unknown_option: "A rule names an answer that isn't one of that field's options.",
  rule_cycle: "These rules depend on each other in a loop. Remove one.",
  rule_invalid: "A rule needs at least one answer chosen.",
  too_many_rules: "A field can have at most 5 rules.",
  field_has_dependants: "Other fields show or require themselves based on this one. Remove those rules first.",
  carry_forward_needs_entry_form: "Carrying a value forward needs the field on Add Lead or Follow-up outcome.",
};

/** Default value input that matches the field type. The value is kept as text until it is saved. */
function DefaultValueInput({ form, onChange }: { form: FieldForm; onChange: (text: string) => void }) {
  const t = form.fieldType;
  const options = form.options.map((o) => o.trim()).filter(Boolean);
  if (t === "BOOLEAN") {
    return (
      <SelectInput label="Default" value={form.defaultText} onChange={(e) => onChange(e.target.value)} data-testid="field-default">
        <option value="">No default</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </SelectInput>
    );
  }
  if (t === "SELECT") {
    return (
      <SelectInput label="Default" value={form.defaultText} onChange={(e) => onChange(e.target.value)} data-testid="field-default">
        <option value="">No default</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </SelectInput>
    );
  }
  if (t === "MULTI_SELECT") {
    const chosen = new Set(form.defaultText.split(",").map((s) => s.trim()).filter(Boolean));
    return (
      <FormField label="Default">
        {options.length === 0 ? (
          <p className="text-xs text-ink-2">Add options first.</p>
        ) : (
          <div className="space-y-0.5">
            {options.map((o) => (
              <CheckRow
                key={o}
                label={o}
                checked={chosen.has(o)}
                onChange={(on) => {
                  const next = new Set(chosen);
                  if (on) next.add(o);
                  else next.delete(o);
                  onChange(options.filter((x) => next.has(x)).join(", "));
                }}
              />
            ))}
          </div>
        )}
      </FormField>
    );
  }
  if (t === "LONG_TEXT") {
    return (
      <FormField label="Default">
        <textarea className={`${CONTROL} h-24 py-2`} value={form.defaultText} onChange={(e) => onChange(e.target.value)} data-testid="field-default" />
      </FormField>
    );
  }
  const type = t === "NUMBER" ? "number" : t === "DATE" ? "date" : t === "EMAIL" ? "email" : t === "PHONE" ? "tel" : "text";
  if (t === "DATETIME") return <p className="text-xs text-ink-2">Date and time fields have no default.</p>;
  return <TextInput label="Default" type={type} value={form.defaultText} onChange={(e) => onChange(e.target.value)} data-testid="field-default" />;
}

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (next: string[]) => void }) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <FormField label="Options" hint="Shown in this order. Blank and repeated options are dropped when you save.">
      <ul className="space-y-1.5" data-testid="field-options">
        {options.map((o, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <input
              className={CONTROL}
              value={o}
              aria-label={`Option ${i + 1}`}
              onChange={(e) => onChange(options.map((x, k) => (k === i ? e.target.value : x)))}
              data-testid={`field-option-${i}`}
            />
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move option ${i + 1} up`} className="inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-primary-50 disabled:opacity-30 sm:h-9">
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === options.length - 1} aria-label={`Move option ${i + 1} down`} className="inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-primary-50 disabled:opacity-30 sm:h-9">
              <ArrowDown size={14} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => onChange(options.filter((_, k) => k !== i))} aria-label={`Remove option ${i + 1}`} className="inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-danger-100 hover:text-danger-700 sm:h-9">
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" onClick={() => onChange([...options, ""])} data-testid="field-add-option">
        <Plus size={14} aria-hidden="true" /> Add option
      </Button>
    </FormField>
  );
}

/**
 * Create or edit one CRM field. Everything the admin needs, in plain words: no keys to invent, no JSON.
 * A failed save keeps what was typed and says why.
 */
export function FieldEditorSheet({
  mode,
  initial,
  fieldId,
  services,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial: FieldForm;
  fieldId?: string;
  services: SpecialtyTemplateVm[];
  onClose: () => void;
  onSaved: (field: CrmFieldVm) => void;
}) {
  const [form, setForm] = useState<FieldForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = mode === "edit";
  const set = <K extends keyof FieldForm>(key: K, value: FieldForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const togglePlacement = (p: FieldPlacement, on: boolean) => set("placements", on ? [...form.placements, p] : form.placements.filter((x) => x !== p));

  async function save() {
    const problem = validateFieldForm(form, { editing });
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const field = editing && fieldId ? await api.updateCrmField(fieldId, formToUpdateInput(form)) : await api.createCrmField(formToCreateInput(form));
      onSaved(field);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      setError(SAVE_ERRORS[code] ?? "Couldn't save this field — what you entered is still here. Try again.");
      setSaving(false);
    }
  }

  const keyPreview = editing ? form.key : slugifyKey(form.label);
  const { siblings, outcomes } = useFieldContext(form.specialtyKey);
  const draft: CrmFieldVm = {
    id: "preview", specialtyKey: form.specialtyKey, key: form.key ?? (slugifyKey(form.label) || "preview_field"), label: form.label || "This field", fieldType: form.fieldType, options: form.options.filter(Boolean),
    required: form.required, sortOrder: 999, archived: false, origin: "CUSTOM", groupKey: form.groupKey, placements: form.placements, defaultValue: null, visibleTo: form.visibleTo,
    readOnly: form.readOnly, filterable: form.filterable, carryForward: form.carryForward, rules: form.rules,
  };

  return (
    <SideSheet
      title={editing ? "Edit field" : "Add field"}
      subtitle={editing ? form.label : "Appears wherever you place it"}
      onClose={onClose}
      testId="field-editor"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving} data-testid="field-save">
            {saving ? "Saving…" : editing ? "Save changes" : "Add field"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="field-editor-error" />

        <TextInput label="Label" value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Preferred callback time" autoFocus data-testid="field-label" hint={keyPreview ? `Stored as “${keyPreview}”. This name can't change later.` : undefined} />

        {!editing && (
          <SelectInput label="Applies to" value={form.specialtyKey} onChange={(e) => set("specialtyKey", e.target.value)} data-testid="field-scope" hint="A shared field appears for every service; the same field can't be edited per service.">
            <option value={ALL_SERVICES_KEY}>All services (shared)</option>
            {services.map((s) => (
              <option key={s.key} value={s.key}>
                {s.displayName}
              </option>
            ))}
          </SelectInput>
        )}

        <SelectInput label="Type" value={form.fieldType} onChange={(e) => set("fieldType", e.target.value as CustomFieldType)} data-testid="field-type">
          {CUSTOM_FIELD_TYPES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </SelectInput>

        {isChoiceType(form.fieldType) && <OptionsEditor options={form.options} onChange={(next) => set("options", next)} />}

        <CheckRow label="Required" hint="Staff must fill this in wherever it appears." checked={form.required} onChange={(v) => set("required", v)} testId="field-required" />

        <SelectInput label="Section" value={form.groupKey} onChange={(e) => set("groupKey", e.target.value as FieldForm["groupKey"])} data-testid="field-group">
          {FIELD_GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </SelectInput>

        <FormField label="Where it appears">
          <div className="space-y-0.5" data-testid="field-placements">
            {/* A placement no screen renders yet is offered only to switch it off (older fields may carry it). */}
            {FIELD_PLACEMENTS.filter((p) => p.shown || form.placements.includes(p.key)).map((p) => (
              <CheckRow key={p.key} label={p.label} hint={p.where} checked={form.placements.includes(p.key)} disabled={!p.shown && !form.placements.includes(p.key)} onChange={(on) => togglePlacement(p.key, on)} testId={`field-placement-${p.key}`} />
            ))}
          </div>
        </FormField>

        <SelectInput label="Who can see it" value={form.visibleTo} onChange={(e) => set("visibleTo", e.target.value as FieldForm["visibleTo"])} data-testid="field-visibility">
          {FIELD_VISIBILITY.map((v) => (
            <option key={v.key} value={v.key}>
              {v.label}
            </option>
          ))}
        </SelectInput>

        <DefaultValueInput form={form} onChange={(text) => set("defaultText", text)} />

        <BehaviourSettings form={form} set={set} />
        <RulesEditor form={form} set={set} siblings={siblings} outcomes={outcomes} />
        <FieldPreview key={JSON.stringify([form.rules, form.required, form.fieldType, form.options, form.placements])} draft={draft} siblings={siblings} outcomes={outcomes} />
      </div>
    </SideSheet>
  );
}
