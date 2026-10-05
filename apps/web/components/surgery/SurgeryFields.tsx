"use client";

import { useEffect } from "react";
import type { LookupOption, ScheduleResourceVm, TreatmentDefinitionVm } from "@pulseos/types";
import { CONTROL, FormField, TextInput } from "@/components/settings/FormBits";
import type { SurgeryFormState } from "./surgeryForm";

/** Procedure, date and time, doctor, branch and an operational note — scheduling only, nothing clinical. */
export function SurgeryFields({
  form,
  onChange,
  procedures,
  resources,
  branches,
  hideProcedure = false,
  testPrefix = "surgery",
}: {
  form: SurgeryFormState;
  onChange: <K extends keyof SurgeryFormState>(key: K, value: SurgeryFormState[K]) => void;
  procedures: TreatmentDefinitionVm[];
  resources: ScheduleResourceVm[];
  branches: LookupOption[];
  /** A reschedule keeps the procedure it already is. */
  hideProcedure?: boolean;
  testPrefix?: string;
}) {
  // One doctor / one branch: nothing to choose, so it is selected for the user and the field is hidden below.
  const soleResource = resources.length === 1 ? resources[0]!.id : "";
  const soleBranch = branches.length === 1 ? branches[0]!.id : "";
  useEffect(() => {
    if (soleResource && !form.resourceId) onChange("resourceId", soleResource);
    if (soleBranch && !form.branchId) onChange("branchId", soleBranch);
  }, [soleResource, soleBranch, form.resourceId, form.branchId, onChange]);
  return (
    <>
      {!hideProcedure && (
        <FormField label="Procedure">
          <select className={CONTROL} value={form.treatmentDefinitionId} onChange={(e) => onChange("treatmentDefinitionId", e.target.value)} data-testid={`${testPrefix}-procedure`}>
            <option value="">Choose a procedure…</option>
            {procedures.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </FormField>
      )}
      <div className="grid grid-cols-2 gap-3">
        <TextInput label="Surgery date" type="date" value={form.date} onChange={(e) => onChange("date", e.target.value)} data-testid={`${testPrefix}-date`} />
        <TextInput label="Surgery time" type="time" value={form.time} onChange={(e) => onChange("time", e.target.value)} data-testid={`${testPrefix}-time`} />
      </div>
      {resources.length !== 1 && (
      <FormField label="Doctor">
        <select className={CONTROL} value={form.resourceId} onChange={(e) => onChange("resourceId", e.target.value)} data-testid={`${testPrefix}-doctor`}>
          <option value="">Choose a doctor…</option>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </FormField>
      )}
      {branches.length !== 1 && (
      <FormField label="Branch">
        <select className={CONTROL} value={form.branchId} onChange={(e) => onChange("branchId", e.target.value)} data-testid={`${testPrefix}-branch`}>
          <option value="">Choose a branch…</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </FormField>
      )}
      <FormField label="Note" hint="Optional. Scheduling details the team needs — not clinical notes.">
        <textarea className={`${CONTROL} h-20! py-2`} maxLength={500} value={form.note} onChange={(e) => onChange("note", e.target.value)} data-testid={`${testPrefix}-note`} />
      </FormField>
    </>
  );
}
