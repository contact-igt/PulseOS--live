"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { LeadEditModel, LeadSourceVm, Lookups, SpecialtyTemplateVm, UpdateLeadInput, UpdateLeadResult } from "@pulseos/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { CustomFieldInputs, applyFieldRules } from "./CustomFieldInputs";
import { SideSheet } from "./SideSheet";
import { Tabs } from "./Tabs";
import { Button } from "./primitives";
import { EDIT_LEAD_ERROR_COPY, editReadiness, toEditForm, toUpdateLeadInput, type EditLeadForm } from "./editLeadModel";

const inputClass =
  "w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:bg-neutral-50 disabled:text-ink-2 max-md:min-h-11";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";
const sectionHead = "mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-600";

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function Field({ id, label, hint, children, wide }: { id: string; label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-ink-2">{hint}</p>}
    </div>
  );
}

/** What the server said, in words: its code is the ApiError message; `phone_in_use` also names the patient who holds the number. */
function explain(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  const body = (err as { body?: { patient?: { name?: string } | null } } | null)?.body;
  if (code === "phone_in_use" && body?.patient?.name) return `That phone number already belongs to ${body.patient.name}. Two patients can't share a number.`;
  return EDIT_LEAD_ERROR_COPY[code] ?? "Could not save this lead. Check the details and try again.";
}

/**
 * Edit Lead: change what the hospital holds about an existing lead — the patient's details, the enquiry, who owns it and
 * where it came from, and the configured CRM fields — beside an Insights tab that shows how the lead is doing.
 * Only what changed is sent; the server saves all of it or none, and refuses a copy that someone else changed meanwhile.
 * Stage, outcome, follow-ups and appointments are not edited here (they have their own actions).
 */
export function EditLeadDrawer({
  model,
  lookups,
  specialties,
  leadSources,
  insights,
  onClose,
  onSubmit,
  onSaved,
}: {
  model: LeadEditModel;
  lookups: Pick<Lookups, "branches" | "owners">;
  specialties: SpecialtyTemplateVm[];
  /** The sources the hospital offers (non-archived). */
  leadSources: LeadSourceVm[];
  /** The Insights tab's content (read-only analysis of this lead). */
  insights: ReactNode;
  onClose: () => void;
  onSubmit: (input: UpdateLeadInput) => Promise<UpdateLeadResult>;
  onSaved?: (result: UpdateLeadResult) => void;
}) {
  const initial = useMemo(() => toEditForm(model), [model]);
  const [form, setForm] = useState<EditLeadForm>(initial);
  const [tab, setTab] = useState<"details" | "insights">("details");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const { can } = model;
  const input = toUpdateLeadInput(model, form);
  const dirty = input !== null;
  const readiness = editReadiness(model, form);
  const sourceChanged = can.changeSource && !!form.sourceKey && form.sourceKey !== initial.sourceKey;

  const set = <K extends keyof EditLeadForm>(key: K, value: EditLeadForm[K]) => {
    setError(null);
    setForm((f) => ({ ...f, [key]: value }));
  };

  // The current source may be one the hospital no longer offers for new leads; it still has to be shown.
  const sources = leadSources.some((s) => s.key === initial.sourceKey) || !initial.sourceKey ? leadSources : [{ id: "current", key: initial.sourceKey, label: model.journey.sourceLabel } as LeadSourceVm, ...leadSources];
  const services = specialties.some((s) => s.key === initial.specialtyKey) || !initial.specialtyKey ? specialties : [{ key: initial.specialtyKey, displayName: initial.specialtyKey } as SpecialtyTemplateVm, ...specialties];

  // Configured fields as the hospital's show/require rules say, for the current answers. A read-only field that already holds a value is shown, not edited.
  const ruled = applyFieldRules(model.fields, form.customFieldValues);
  const lockedFields = ruled.filter((f) => f.readOnly && !isEmpty(initial.customFieldValues[f.key]));
  const editableFields = can.editJourney ? ruled.filter((f) => !lockedFields.includes(f)) : [];

  function requestClose() {
    if (submitting) return;
    if (dirty) setDiscarding(true);
    else onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !input) return;
    if (!readiness.ok) return setError(readiness.reasons[0]!);
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(input);
      onSaved?.(result);
      onClose();
    } catch (err) {
      setError(explain(err));
    } finally {
      setSubmitting(false);
    }
  }

  const patientName = model.patient.name?.trim() || "Unknown patient";
  const pf = !can.editPatient;
  const jf = !can.editJourney;

  return (
    <>
      <SideSheet
        title="Edit lead"
        subtitle={`${patientName} · ${model.journey.journeyType}`}
        dialogLabel={`Edit lead — ${patientName}`}
        testId="edit-lead-drawer"
        onClose={requestClose}
        footer={
          <>
            {error && (
              <p role="alert" className="mr-auto max-w-[22rem] text-xs text-danger-700" data-testid="edit-lead-error">
                {error}
              </p>
            )}
            {!error && dirty && !readiness.ok && <p className="mr-auto max-w-[22rem] text-xs text-ink-2">{readiness.reasons[0]}</p>}
            <Button type="button" variant="secondary" onClick={requestClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" form="edit-lead-form" variant="primary" disabled={!dirty || submitting} data-testid="edit-lead-save">
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <Tabs
          variant="underline"
          ariaLabel="Edit lead sections"
          value={tab}
          onChange={(k) => setTab(k as "details" | "insights")}
          items={[
            { key: "details", label: "Details", testId: "edit-lead-tab-details" },
            { key: "insights", label: "Insights", testId: "edit-lead-tab-insights" },
          ]}
          className="mb-4"
        />

        {tab === "insights" && <div data-testid="edit-lead-insights">{insights}</div>}

        <form id="edit-lead-form" onSubmit={handleSubmit} className={tab === "details" ? "space-y-6" : "hidden"} data-testid="edit-lead-form" noValidate>
          <section aria-labelledby="edit-lead-patient">
            <h3 id="edit-lead-patient" className={sectionHead}>
              Patient
            </h3>
            <p className="-mt-2 mb-3 text-[11px] text-ink-2">Patient details apply to all of this patient&apos;s journeys.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="edit-lead-name" label="Name" wide>
                <input id="edit-lead-name" value={form.name} onChange={(e) => set("name", e.target.value)} disabled={pf} className={inputClass} placeholder="Not given yet" autoComplete="off" />
              </Field>
              <Field id="edit-lead-phone" label="Phone" hint={pf ? undefined : "The phone number identifies the patient. A number another patient holds can't be used."}>
                <input id="edit-lead-phone" type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} disabled={pf} className={inputClass} autoComplete="off" />
              </Field>
              <Field id="edit-lead-email" label="Email">
                <input id="edit-lead-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} disabled={pf} className={inputClass} autoComplete="off" />
              </Field>
              <Field id="edit-lead-dob" label="Date of birth">
                <input id="edit-lead-dob" type="date" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} disabled={pf} className={inputClass} />
              </Field>
              <Field id="edit-lead-age" label="Age" hint={form.dateOfBirth ? "Worked out from the date of birth." : undefined}>
                <input id="edit-lead-age" type="number" inputMode="numeric" min={0} max={120} value={form.age} onChange={(e) => set("age", e.target.value)} disabled={pf || !!form.dateOfBirth} className={inputClass} />
              </Field>
              <Field id="edit-lead-language" label="Preferred language">
                <input id="edit-lead-language" value={form.preferredLanguage} onChange={(e) => set("preferredLanguage", e.target.value)} disabled={pf} className={inputClass} />
              </Field>
              {lookups.branches.length > 1 && (
                <Field id="edit-lead-branch" label="Branch">
                  <select id="edit-lead-branch" value={form.branchId} onChange={(e) => set("branchId", e.target.value)} disabled={pf} className={inputClass}>
                    <option value="">Not set</option>
                    {lookups.branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="sm:col-span-2">
                <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700 sm:min-h-0">
                  <input type="checkbox" checked={form.marketingConsent} onChange={(e) => set("marketingConsent", e.target.checked)} disabled={pf} className="h-4 w-4 rounded border-neutral-300 text-primary-600" />
                  Agreed to be contacted for marketing
                </label>
              </div>
            </div>
          </section>

          <section aria-labelledby="edit-lead-enquiry">
            <h3 id="edit-lead-enquiry" className={sectionHead}>
              Enquiry
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="edit-lead-journey-type" label="Enquiry">
                <input id="edit-lead-journey-type" value={form.journeyType} onChange={(e) => set("journeyType", e.target.value)} disabled={jf} className={inputClass} />
              </Field>
              <Field id="edit-lead-service" label="Service">
                <select id="edit-lead-service" value={form.specialtyKey} onChange={(e) => set("specialtyKey", e.target.value)} disabled={jf} className={inputClass}>
                  {!form.specialtyKey && <option value="">Not set</option>}
                  {services.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="edit-lead-priority" label="Priority">
                <select id="edit-lead-priority" value={form.priority} onChange={(e) => set("priority", e.target.value as EditLeadForm["priority"])} disabled={jf} className={inputClass}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </Field>
              <Field id="edit-lead-owner" label="Team member" hint={!can.changeOwner ? "Only an admin or coordinator can reassign." : undefined}>
                <select id="edit-lead-owner" value={form.ownerId} onChange={(e) => set("ownerId", e.target.value)} disabled={!can.changeOwner} className={inputClass}>
                  <option value="">Unassigned</option>
                  {lookups.owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="edit-lead-notes" label="Notes" wide>
                <textarea id="edit-lead-notes" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} disabled={jf} className={inputClass} />
              </Field>
            </div>
          </section>

          <section aria-labelledby="edit-lead-source">
            <h3 id="edit-lead-source" className={sectionHead}>
              Source
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="edit-lead-source-select" label="Original source" hint={!can.changeSource ? "The original source feeds marketing results, so only an admin can correct it." : undefined}>
                <select id="edit-lead-source-select" value={form.sourceKey} onChange={(e) => set("sourceKey", e.target.value)} disabled={!can.changeSource} className={inputClass}>
                  {!form.sourceKey && <option value="">Not set</option>}
                  {sources.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div>
                <span className={labelClass}>Campaign</span>
                <p className="py-2 text-sm text-ink-2" data-testid="edit-lead-campaign">
                  {model.journey.campaign?.name ?? "None"}
                </p>
              </div>
              {sourceChanged && (
                <Field id="edit-lead-source-reason" label="Why is the source being changed?" wide hint="Recorded on the Timeline with the old and new source.">
                  <input id="edit-lead-source-reason" value={form.sourceReason} onChange={(e) => set("sourceReason", e.target.value)} className={inputClass} maxLength={500} />
                </Field>
              )}
            </div>
          </section>

          {(editableFields.length > 0 || lockedFields.length > 0) && (
            <section aria-labelledby="edit-lead-details">
              <h3 id="edit-lead-details" className={sectionHead}>
                Additional details
              </h3>
              {lockedFields.length > 0 && (
                <dl className="mb-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2" data-testid="edit-lead-locked-fields">
                  {lockedFields.map((f) => (
                    <div key={f.id}>
                      <dt className={labelClass}>{f.label}</dt>
                      <dd className="text-sm text-ink">{Array.isArray(form.customFieldValues[f.key]) ? (form.customFieldValues[f.key] as string[]).join(", ") : String(form.customFieldValues[f.key])}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {editableFields.length > 0 && <CustomFieldInputs fields={editableFields} values={form.customFieldValues} onChange={(key, value) => set("customFieldValues", { ...form.customFieldValues, [key]: value })} idPrefix="edit-lead-field" />}
            </section>
          )}
        </form>
      </SideSheet>

      <ConfirmDialog
        open={discarding}
        title="Discard your changes?"
        description="This lead has changes that have not been saved. Closing now will lose them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscarding(false);
          onClose();
        }}
        onCancel={() => setDiscarding(false)}
      />
    </>
  );
}
