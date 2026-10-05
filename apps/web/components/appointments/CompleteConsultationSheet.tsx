"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button, SideSheet, Skeleton } from "@pulseos/ui";
import { hasPermission, type AppointmentRow, type CompleteAppointmentInput } from "@pulseos/types";
import { CONTROL, FormError, FormField } from "@/components/settings/FormBits";
import { FollowUpFields } from "@/components/followups/FollowUpFields";
import { buildFollowUpInput, initialFollowUpForm, type FollowUpFormState } from "@/components/followups/followUpForm";
import { SurgeryFields } from "@/components/surgery/SurgeryFields";
import { buildSurgeryInput, initialSurgeryForm, proceduresFor, type SurgeryFormState } from "@/components/surgery/surgeryForm";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

type Choice = "none" | "follow_up" | "surgery";

const SERVER_ERRORS: Record<string, string> = {
  due_in_past: "Pick a follow-up time in the future.",
  note_required: "This follow-up type needs a note — say what's happening.",
  type_invalid: "That follow-up type is no longer available. Choose another.",
  assignee_invalid: "That team member isn't available for this hospital. Choose someone else.",
  scheduled_in_past: "Pick a surgery time in the future.",
  treatment_invalid: "That procedure is no longer offered. Choose another.",
  resource_invalid: "That doctor is no longer available. Choose another.",
  branch_invalid: "That branch isn't available. Choose another.",
  surgery_already_scheduled: "This procedure is already scheduled for this patient — find it on their journey.",
  forbidden: "You don't have permission to schedule a surgery. Choose another option or ask an Admin.",
  not_with_doctor: "This patient is no longer with the doctor — it may already be completed. The list has been refreshed.",
};

/** Everything that shows an appointment, a journey's follow-ups or a procedure refreshes after a completion. */
export function invalidateAppointmentQueries(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ["appointments", "front-desk", "timeline", "patient360", "dashboard", "journey", "tasks", "treatments", "journeys", "leads"]) queryClient.invalidateQueries({ queryKey: [key] });
}

const OPTIONS: { key: Choice; label: string; hint: string }[] = [
  { key: "none", label: "No follow-up", hint: "Nothing more to schedule right now." },
  { key: "follow_up", label: "Create follow-up", hint: "Someone needs to reach the patient again by a date." },
  { key: "surgery", label: "Schedule surgery", hint: "Book the procedure date, doctor and branch." },
];

/**
 * "What happens next?" — the last step of a consultation. Completing the visit and the chosen next step are saved
 * together by the server: if the follow-up or surgery is refused the visit stays With doctor and everything typed is
 * still here. Only the chosen branch reveals its fields. No diagnosis, prescription or clinical summary is asked for.
 */
export function CompleteConsultationSheet({ appointment, onClose, onDone }: { appointment: AppointmentRow; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const timeZone = useHospitalTimeZone();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const canSchedule = !!session.data && hasPermission(session.data.user.role, "MANAGE_TREATMENT");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState<FollowUpFormState | null>(null);
  const [surgery, setSurgery] = useState<SurgeryFormState>(() => initialSurgeryForm({ resourceId: appointment.doctorId, branchId: appointment.branchId }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const types = useQuery({ queryKey: ["followup-types", "journey", appointment.journeyId], queryFn: () => api.followUpTypes({ journeyId: appointment.journeyId }), enabled: choice === "follow_up" });
  const resources = useQuery({ queryKey: ["resources"], queryFn: () => api.resources(), enabled: choice === "surgery", staleTime: 60_000 });
  const catalog = useQuery({ queryKey: ["treatment-catalog"], queryFn: () => api.treatmentCatalog(), enabled: choice === "surgery", staleTime: 60_000 });

  // The follow-up form needs its types before it can pick a default.
  if (choice === "follow_up" && types.data && followUp === null) setFollowUp(initialFollowUpForm(types.data, { typeKey: "appointment_followup" }));
  const setF = <K extends keyof FollowUpFormState>(k: K, v: FollowUpFormState[K]) => setFollowUp((s) => (s ? { ...s, [k]: v } : s));
  const setS = <K extends keyof SurgeryFormState>(k: K, v: SurgeryFormState[K]) => setSurgery((s) => ({ ...s, [k]: v }));

  async function save() {
    if (saving || !choice) return;
    let input: CompleteAppointmentInput;
    const trimmed = note.trim();
    if (choice === "follow_up") {
      if (!followUp || !types.data) return;
      const built = buildFollowUpInput(followUp, types.data, timeZone, new Date());
      if ("error" in built) return setError(built.error);
      input = { next: { kind: "follow_up", followUp: built.input } };
    } else if (choice === "surgery") {
      const built = buildSurgeryInput(surgery, timeZone, new Date());
      if ("error" in built) return setError(built.error);
      input = { next: { kind: "surgery", surgery: built.input } };
    } else {
      input = { next: { kind: "none" }, ...(trimmed ? { note: trimmed } : {}) };
    }
    setSaving(true);
    setError(null);
    try {
      await api.completeAppointment(appointment.id, input);
      invalidateAppointmentQueries(queryClient);
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      setError(SERVER_ERRORS[code] ?? "Couldn't complete the consultation — what you entered is still here. Try again.");
      if (code === "not_with_doctor") invalidateAppointmentQueries(queryClient);
      setSaving(false);
    }
  }

  const options = OPTIONS.filter((o) => o.key !== "surgery" || canSchedule);
  const owners = lookups.data?.owners ?? [];

  return (
    <SideSheet
      title="Consultation done"
      subtitle={appointment.patientName}
      onClose={onClose}
      testId="complete-consultation"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0" onClick={save} disabled={saving || !choice} data-testid="complete-consultation-save">
            {saving ? "Saving…" : "Consultation done"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="complete-consultation-error" />

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-ink">What happens next?</legend>
          {options.map((o) => (
            <label
              key={o.key}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-control border p-3 text-sm transition ${choice === o.key ? "border-primary-500 bg-primary-50" : "border-line-strong bg-surface hover:bg-primary-50/50"}`}
            >
              <input type="radio" name="completion-next" value={o.key} checked={choice === o.key} onChange={() => { setChoice(o.key); setError(null); }} className="mt-0.5 h-4 w-4 shrink-0 accent-primary-600" data-testid={`complete-next-${o.key}`} />
              <span>
                <span className="block font-medium text-ink">{o.label}</span>
                <span className="block text-xs text-ink-2">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {choice === "follow_up" && (
          <div className="space-y-5" data-testid="complete-followup-fields">
            {types.isLoading && <Skeleton className="h-40" />}
            {types.isError && <FormError message="Could not load follow-up types." />}
            {followUp && types.data && <FollowUpFields form={followUp} onChange={setF} types={types.data} owners={owners} testPrefix="complete-followup" />}
          </div>
        )}

        {choice === "surgery" && (
          <div className="space-y-5" data-testid="complete-surgery-fields">
            {(resources.isLoading || catalog.isLoading) && <Skeleton className="h-40" />}
            {(resources.isError || catalog.isError) && <FormError message="Could not load procedures and doctors." />}
            {resources.data && catalog.data && (
              <SurgeryFields form={surgery} onChange={setS} procedures={proceduresFor(catalog.data, appointment.serviceKey)} resources={resources.data} branches={lookups.data?.branches ?? []} testPrefix="complete-surgery" />
            )}
          </div>
        )}

        {choice === "none" && (
          <FormField label="Note" hint="Optional. Anything the team should know about this visit — not clinical notes.">
            <textarea className={`${CONTROL} h-20! py-2`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="complete-note" />
          </FormField>
        )}
      </div>
    </SideSheet>
  );
}
