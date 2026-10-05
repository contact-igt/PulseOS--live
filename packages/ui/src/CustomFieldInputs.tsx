"use client";

import { FIELD_GROUPS, evaluateFieldRules, type CustomFieldDefinitionVm, type FieldGroupKey, type FieldRule } from "@pulseos/types";

// One renderer for every place a configured CRM field is captured (Add Lead, follow-up outcome,
// appointment...). The definition says what to draw; the caller owns the values.

const inputClass = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25 min-h-11 sm:min-h-0";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";
const GROUP_LABEL = new Map<string, string>(FIELD_GROUPS.map((g) => [g.key, g.label]));
const GROUP_ORDER = new Map<string, number>(FIELD_GROUPS.map((g, i) => [g.key, i]));

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Initial values from each field's configured default. */
export function defaultsFor(fields: CustomFieldDefinitionVm[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (!isEmpty(f.defaultValue)) out[f.key] = f.defaultValue;
  return out;
}

type RuledField = CustomFieldDefinitionVm & { rules?: FieldRule[]; readOnly?: boolean };

/**
 * The fields a form should show RIGHT NOW, with their effective "required": the same rules the server applies, so what the
 * person sees is exactly what will be accepted. A hidden field is left out (its answer is not sent).
 */
export function applyFieldRules<T extends CustomFieldDefinitionVm>(fields: T[], values: Record<string, unknown>, outcomeKey?: string | null): T[] {
  const state = evaluateFieldRules(fields as RuledField[], { outcomeKey, values });
  return fields.filter((f) => state[f.key]?.visible !== false).map((f) => (state[f.key]!.required === f.required ? f : { ...f, required: state[f.key]!.required }));
}

/** What to submit: empty values dropped, date-times turned into instants. `undefined` when nothing is filled in. */
export function normalizeFieldValues(fields: CustomFieldDefinitionVm[], values: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isEmpty(v)) continue;
    out[f.key] = f.fieldType === "DATETIME" && typeof v === "string" ? new Date(v).toISOString() : v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function FieldControl({ field, value, onChange, id }: { field: CustomFieldDefinitionVm; value: unknown; onChange: (v: unknown) => void; id: string }) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (field.fieldType) {
    case "LONG_TEXT":
      return <textarea id={id} required={field.required} value={text} onChange={(e) => onChange(e.target.value)} rows={3} className={inputClass} />;
    case "BOOLEAN":
      return (
        <label className="flex min-h-11 items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-slate-700 sm:min-h-0">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 text-primary-600" />
          Yes
        </label>
      );
    case "SELECT":
      return (
        <select id={id} required={field.required} value={text} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "MULTI_SELECT": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="space-y-0.5" role="group" aria-labelledby={`${id}-label`}>
          {(field.options ?? []).map((o) => (
            <label key={o} className="flex min-h-11 items-center gap-2 text-sm text-slate-700 sm:min-h-0">
              <input
                type="checkbox"
                checked={chosen.includes(o)}
                onChange={(e) => {
                  const next = e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o);
                  onChange((field.options ?? []).filter((x) => next.includes(x)));
                }}
                className="h-4 w-4 rounded border-neutral-300 text-primary-600"
              />
              {o}
            </label>
          ))}
        </div>
      );
    }
    default: {
      const type = { NUMBER: "number", PHONE: "tel", EMAIL: "email", DATE: "date", DATETIME: "datetime-local" }[field.fieldType as string] ?? "text";
      return <input id={id} type={type} required={field.required} value={text} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
    }
  }
}

/**
 * Configured fields, in their configured order. When fields belong to more than one section, each section
 * gets a heading; otherwise the caller's own heading is enough.
 */
export function CustomFieldInputs({
  fields,
  values,
  onChange,
  idPrefix,
  testId = "custom-field-inputs",
}: {
  fields: CustomFieldDefinitionVm[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  idPrefix: string;
  testId?: string;
}) {
  const groups: { key: FieldGroupKey | "other"; fields: CustomFieldDefinitionVm[] }[] = [];
  for (const f of fields) {
    const key = (f.groupKey ?? "other") as FieldGroupKey | "other";
    const g = groups.find((x) => x.key === key);
    if (g) g.fields.push(f);
    else groups.push({ key, fields: [f] });
  }
  groups.sort((a, b) => (GROUP_ORDER.get(a.key) ?? 99) - (GROUP_ORDER.get(b.key) ?? 99));
  const showHeadings = groups.length > 1;

  return (
    <div className="space-y-4" data-testid={testId}>
      {groups.map((g) => (
        <div key={g.key} data-testid={`${testId}-group-${g.key}`}>
          {showHeadings && <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{GROUP_LABEL.get(g.key) ?? "Other"}</h4>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {g.fields.map((field) => {
              const id = `${idPrefix}-${field.id}`;
              const wide = field.fieldType === "LONG_TEXT" || field.fieldType === "TEXT" || field.fieldType === "MULTI_SELECT";
              return (
                <div key={field.id} className={wide ? "sm:col-span-2" : ""}>
                  <label id={`${id}-label`} className={labelClass} htmlFor={field.fieldType === "MULTI_SELECT" ? undefined : id}>
                    {field.label} {field.required && <span className="text-danger-500">*</span>}
                  </label>
                  <FieldControl field={field} id={id} value={values[field.key]} onChange={(v) => onChange(field.key, v)} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
