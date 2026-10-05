"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button, ErrorState, SideSheet, Skeleton } from "@pulseos/ui";
import { FormError } from "@/components/settings/FormBits";
import { FollowUpFields } from "./FollowUpFields";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { buildFollowUpInput, initialFollowUpForm, type FollowUpFormState } from "./followUpForm";


const SERVER_ERRORS: Record<string, string> = {
  due_in_past: "Pick a time in the future.",
  note_required: "This type needs a note — say what's happening.",
  type_invalid: "That follow-up type is no longer available. Choose another.",
  assignee_invalid: "That team member isn't available for this hospital. Choose someone else.",
  journey_not_found: "This journey no longer exists.",
};

/** Refresh everything that shows a journey's follow-ups: the journey, My Work, Patient 360, the dashboards. */
export function invalidateFollowUpQueries(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ["journey", "tasks", "patient360", "dashboard", "timeline", "journeys", "leads"]) queryClient.invalidateQueries({ queryKey: [key] });
}

/**
 * "Add follow-up" from a Journey: a person has something to do, by a date and time. It is an ordinary Task — the
 * same one My Work shows. Nothing is assumed about when; the owner follows the type's default (usually the
 * journey's owner). A failed save keeps everything typed; Save is locked while saving.
 */
export function AddFollowUpSheet({ journeyId, patientName, ownerName, preset, onClose }: { journeyId: string; patientName: string; ownerName: string | null; preset?: { typeKey?: string }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const timeZone = useHospitalTimeZone();
  const types = useQuery({ queryKey: ["followup-types", "journey", journeyId], queryFn: () => api.followUpTypes({ journeyId }) });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const [state, setState] = useState<FollowUpFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialise once the types arrive (the form needs a default type).
  if (types.data && state === null) setState(initialFollowUpForm(types.data, preset));
  const form = state;
  const set = <K extends keyof FollowUpFormState>(key: K, value: FollowUpFormState[K]) => setState((s) => (s ? { ...s, [key]: value } : s));

  async function save() {
    if (saving || !form || !types.data) return;
    const built = buildFollowUpInput(form, types.data, timeZone, new Date());
    if ("error" in built) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      await api.createFollowUp(journeyId, built.input);
      invalidateFollowUpQueries(queryClient);
      onClose();
    } catch (err) {
      setError(SERVER_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save this follow-up — what you entered is still here. Try again.");
      setSaving(false);
    }
  }


  return (
    <SideSheet
      title="Add follow-up"
      subtitle={patientName}
      onClose={onClose}
      testId="add-followup"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0" onClick={save} disabled={saving || !form} data-testid="add-followup-save">
            {saving ? "Saving…" : "Save follow-up"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="add-followup-error" />
        {types.isLoading && <Skeleton className="h-40" />}
        {types.isError && <ErrorState message="Could not load follow-up types." />}
        {form && types.data && (
          <>
            <FollowUpFields form={form} onChange={set} types={types.data} owners={lookups.data?.owners ?? []} ownerName={ownerName} />
          </>
        )}
      </div>
    </SideSheet>
  );
}
