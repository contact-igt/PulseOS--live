"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, CustomFieldInputs, ErrorState, SideSheet, Skeleton, applyFieldRules, defaultsFor } from "@pulseos/ui";
import type { CrmOutcomeVm, LogInteractionResult } from "@pulseos/types";
import { useQuickCreate } from "@/components/shell/QuickCreateProvider";
import { CheckRow, CONTROL, FormError, FormField, TextInput } from "@/components/settings/FormBits";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { InlineAppointmentFields } from "@/components/appointments/InlineAppointmentFields";
import { APPOINTMENT_SERVER_ERRORS, appointmentSaveLabel, initialInlineAppointment } from "@/components/appointments/inlineAppointment";
import { buildLogInput, defaultFollowUpLocal, outcomeHint, type LogState } from "./outcomeForm";

const SERVER_ERRORS: Record<string, string> = {
  ...APPOINTMENT_SERVER_ERRORS,
  follow_up_and_appointment: "A booked visit is the next step - clear the follow-up time or the appointment.",
  follow_up_required: "Choose when to follow up.",
  follow_up_in_past: "Pick a follow-up time in the future.",
  task_closed: "That task was already completed by someone else.",
  task_not_found: "That task no longer exists.",
  outcome_not_found: "That outcome is no longer available. Choose another.",
  missing_required_fields: "Fill in the required fields.",
  invalid_field_values: "One of the answers doesn't fit its field.",
};

/**
 * "Log outcome": what happened on a call or follow-up. Closes the task it came from, schedules the next
 * follow-up when the outcome needs one, and moves the journey forward only. A failed save keeps what was typed.
 */
export function LogOutcomeSheet({
  journeyId,
  patient,
  taskId,
  onClose,
  onLogged,
}: {
  journeyId: string;
  patient: { id: string; name: string; phone?: string };
  taskId?: string;
  onClose: () => void;
  onLogged?: (result: LogInteractionResult) => void;
}) {
  const queryClient = useQueryClient();
  const quickCreate = useQuickCreate();
  const timeZone = useHospitalTimeZone();
  const outcomes = useQuery({ queryKey: ["crm-outcomes", "active"], queryFn: () => api.crmOutcomes() });
  const fields = useQuery({ queryKey: ["crm-fields-for-journey", "followup_outcome", journeyId], queryFn: () => api.crmFieldsForJourney("followup_outcome", journeyId) });
  // "Carry this value into the next interaction": only fields marked so arrive filled in (never the outcome, dates or status).
  const carried = useQuery({ queryKey: ["field-prefill", "followup_outcome", journeyId], queryFn: () => api.fieldPrefill(journeyId, "followup_outcome") });

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Clinic hours: the hospital's own, shared with every booking form (so a time outside them is caught before saving).
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });
  const [state, setState] = useState<LogState>(() => ({ note: "", reason: "", scheduleFollowUp: false, followUpLocal: "", fieldValues: {}, bookAppointment: false, appt: initialInlineAppointment(new Date(), timeZone) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LogInteractionResult | null>(null);
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  const selected: CrmOutcomeVm | null = outcomes.data?.find((o) => o.key === selectedKey) ?? null;
  // Shown/required by the hospital's rules for the chosen outcome and the answers so far.
  const fieldList = applyFieldRules(fields.data ?? [], state.fieldValues, selectedKey);
  // Pre-fill configured defaults once the fields have loaded.
  if (fields.data && (carried.data || carried.isError) && !defaultsApplied) {
    setDefaultsApplied(true);
    const defaults = { ...defaultsFor(fields.data), ...(carried.data ?? {}) };
    if (Object.keys(defaults).length > 0) setState((s) => ({ ...s, fieldValues: { ...defaults, ...s.fieldValues } }));
  }

  const set = <K extends keyof LogState>(key: K, value: LogState[K]) => setState((s) => ({ ...s, [key]: value }));
  const choose = (o: CrmOutcomeVm) => {
    setSelectedKey(o.key);
    setError(null);
    if ((o.requiresFollowUp || state.scheduleFollowUp) && !state.followUpLocal) set("followUpLocal", defaultFollowUpLocal(new Date(), timeZone));
  };

  async function save() {
    const built = buildLogInput(selected, state, fieldList, new Date(), taskId, timeZone, lookups.data?.clinicHours ?? null);
    if ("error" in built) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      const result = await api.logInteraction(journeyId, built.input);
      // A booked visit also lands on the Front Desk day, the planner and the appointment lists: refresh them all, no reload needed.
      for (const key of ["tasks", "journey", "journeys", "leads", "leads-summary", "patient360", "dashboard", "timeline", "appointments", "front-desk", "patients"]) queryClient.invalidateQueries({ queryKey: [key] });
      onLogged?.(result);
      // Booked right here: nothing more to offer. Otherwise an outcome that allows a visit still offers to book one.
      if (result.outcome.allowsAppointment && !result.appointmentId) setDone(result);
      else onClose();
    } catch (err) {
      setError(SERVER_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save this outcome — what you entered is still here. Try again.");
      setSaving(false);
    }
  }

  if (done) {
    return (
      <SideSheet title="Outcome saved" subtitle={patient.name} onClose={onClose} testId="log-outcome-done" footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
        <div className="space-y-3">
          <p className="text-sm text-ink">
            <span className="font-medium">{done.outcome.label}</span> is on the journey{done.followUpTaskId ? ", and a follow-up is scheduled." : "."}
          </p>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              quickCreate.openNewAppointment({ patient: { id: patient.id, name: patient.name, phone: patient.phone ?? "" } });
            }}
            data-testid="log-outcome-book-appointment"
          >
            Book an appointment
          </Button>
        </div>
      </SideSheet>
    );
  }

  const booking = !!selected?.allowsAppointment && !!state.bookAppointment;
  const wantsFollowUp = !!selected && !booking && (selected.requiresFollowUp || state.scheduleFollowUp);
  return (
    <SideSheet
      title="Log outcome"
      subtitle={patient.name}
      onClose={onClose}
      testId="log-outcome"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving} data-testid="log-outcome-save">
            {saving ? "Saving…" : booking ? appointmentSaveLabel("outcome", state.appt?.apptConfirmed ?? true) : "Save outcome"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="log-outcome-error" />

        <FormField label="What happened?">
          {outcomes.isLoading && <Skeleton className="h-40" />}
          {outcomes.isError && <ErrorState message="Could not load outcomes." />}
          {outcomes.data && (
            <div role="radiogroup" aria-label="What happened?" className="space-y-1.5" data-testid="log-outcome-choices">
              {outcomes.data.map((o) => {
                const active = o.key === selectedKey;
                const hint = outcomeHint(o);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => choose(o)}
                    className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-control border px-3 py-2 text-left transition ${active ? "border-primary-500 bg-primary-50" : "border-line-strong bg-white hover:bg-primary-50/50"}`}
                    data-testid={`log-outcome-choice-${o.key}`}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{o.label}</span>
                      {hint && <span className="block text-[11px] text-ink-2">{hint}</span>}
                    </span>
                    {o.stage === "lost" && <Badge tone="warning">Closes journey</Badge>}
                  </button>
                );
              })}
            </div>
          )}
        </FormField>

        {selected && (
          <>
            <FormField label="Notes" hint="Optional. What was said, in a line or two.">
              <textarea className={`${CONTROL} h-24 py-2`} value={state.note} onChange={(e) => set("note", e.target.value)} data-testid="log-outcome-note" />
            </FormField>

            {selected.asksReason && <TextInput label="Why? (optional)" value={state.reason} onChange={(e) => set("reason", e.target.value)} placeholder="e.g. Chose another hospital" data-testid="log-outcome-reason" />}

            {selected.allowsAppointment && <CheckRow label="Book the appointment now" hint="Choose the date and time here - no second form." checked={!!state.bookAppointment} onChange={(v) => set("bookAppointment", v)} testId="log-outcome-book" />}
            {booking && state.appt && (
              <InlineAppointmentFields state={state.appt} onChange={(patch) => setState((s) => ({ ...s, appt: { ...s.appt!, ...patch } }))} timeZone={timeZone} idPrefix="log-outcome" confirmHint="The patient agreed to this slot. The WhatsApp confirmation and a 1-hour reminder are scheduled." />
            )}
            {!booking && !selected.requiresFollowUp && <CheckRow label="Schedule a follow-up" checked={state.scheduleFollowUp} onChange={(v) => { set("scheduleFollowUp", v); if (v && !state.followUpLocal) set("followUpLocal", defaultFollowUpLocal(new Date(), timeZone)); }} testId="log-outcome-schedule" />}
            {wantsFollowUp && <TextInput label="Follow up on" type="datetime-local" value={state.followUpLocal} onChange={(e) => set("followUpLocal", e.target.value)} data-testid="log-outcome-follow-up" hint="A task is created and assigned to the journey's assigned team member." />}

            {fieldList.length > 0 && <CustomFieldInputs fields={fieldList} values={state.fieldValues} onChange={(key, value) => setState((s) => ({ ...s, fieldValues: { ...s.fieldValues, [key]: value } }))} idPrefix="outcome-field" testId="log-outcome-fields" />}
          </>
        )}
      </div>
    </SideSheet>
  );
}
