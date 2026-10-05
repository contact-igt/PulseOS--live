"use client";

import type { FollowUpTypeVm, LookupOption } from "@pulseos/types";
import { FOLLOW_UP_DEFAULT_LABEL } from "@/lib/followUpLabels";
import { CONTROL, FormField, TextInput } from "@/components/settings/FormBits";
import { NO_OWNER, type FollowUpFormState } from "./followUpForm";

/**
 * The follow-up fields (type, due date and time, owner, priority, note) — one form, used by Add Follow-up and by
 * "Create follow-up" when completing a consultation, so the two can never drift apart.
 */
export function FollowUpFields({
  form,
  onChange,
  types,
  owners,
  ownerName,
  testPrefix = "add-followup",
}: {
  form: FollowUpFormState;
  onChange: <K extends keyof FollowUpFormState>(key: K, value: FollowUpFormState[K]) => void;
  types: FollowUpTypeVm[];
  owners: LookupOption[];
  /** The Journey owner's name, for the default-owner hint; undefined when the caller does not know it. */
  ownerName?: string | null;
  testPrefix?: string;
}) {
  const type = types.find((t) => t.id === form.typeId) ?? null;
  const ownerHint = type ? `Default: ${type.defaultOwner === "JOURNEY_OWNER" ? (ownerName === undefined ? "the journey's assigned team member" : ownerName ? `${ownerName} (journey's team member)` : "the person adding it — this journey is unassigned") : FOLLOW_UP_DEFAULT_LABEL[type.defaultOwner].toLowerCase()}` : undefined;
  return (
    <>
      <FormField label="Type">
        <select className={CONTROL} value={form.typeId} onChange={(e) => onChange("typeId", e.target.value)} data-testid={`${testPrefix}-type`}>
          {types.map((ty) => (
            <option key={ty.id} value={ty.id}>
              {ty.label}
            </option>
          ))}
        </select>
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <TextInput label="Due date" type="date" value={form.date} onChange={(e) => onChange("date", e.target.value)} data-testid={`${testPrefix}-date`} />
        <TextInput label="Due time" type="time" value={form.time} onChange={(e) => onChange("time", e.target.value)} data-testid={`${testPrefix}-time`} />
      </div>

      <FormField label="Assigned Team Member" hint={ownerHint}>
        <select className={CONTROL} value={form.ownerId} onChange={(e) => onChange("ownerId", e.target.value)} data-testid={`${testPrefix}-owner`}>
          <option value="">Use the default</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value={NO_OWNER}>Unassigned</option>
        </select>
      </FormField>

      <FormField label="Priority" hint={type ? `Default for ${type.label}: ${type.defaultPriority === "high" ? "High" : "Normal"}` : undefined}>
        <select className={CONTROL} value={form.priority} onChange={(e) => onChange("priority", e.target.value as FollowUpFormState["priority"])} data-testid={`${testPrefix}-priority`}>
          <option value="">Use the default</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </FormField>

      <FormField label={type?.requiresNote ? "Note (required)" : "Note"} hint={type?.requiresNote ? "Say what's happening — this type always needs a reason." : "Optional. What the person needs to know."}>
        <textarea className={`${CONTROL} h-24! py-2`} maxLength={500} value={form.note} onChange={(e) => onChange("note", e.target.value)} data-testid={`${testPrefix}-note`} />
      </FormField>
    </>
  );
}
