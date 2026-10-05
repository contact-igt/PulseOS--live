"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { Button, Card, ConfirmDialog, SideSheet, Skeleton } from "@pulseos/ui";
import type { TreatmentRow } from "@pulseos/types";
import { FormError } from "@/components/settings/FormBits";
import { invalidateAppointmentQueries } from "@/components/appointments/CompleteConsultationSheet";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { SurgeryFields } from "./SurgeryFields";
import { buildSurgeryReschedule, initialSurgeryForm, rescheduleSurgeryDefaults, type SurgeryFormState } from "./surgeryForm";

function when(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

/** Procedures scheduled and still ahead (the same treatment records the Treatments views show), soonest first. */
export function upcomingSurgeries(treatments: TreatmentRow[] | null, now: Date): TreatmentRow[] {
  return (treatments ?? [])
    .filter((t) => t.status === "SCHEDULED" && t.plannedDate && new Date(t.plannedDate).getTime() >= now.getTime() - 24 * 3_600_000)
    .sort((a, b) => new Date(a.plannedDate!).getTime() - new Date(b.plannedDate!).getTime());
}

/**
 * Compact upcoming-procedure context on a Journey: what, when, with whom, where — and, for people who manage
 * treatments, Reschedule and Cancel. It shows the treatment record itself; nothing is copied.
 */
export function SurgeryCard({ treatments, canManage }: { treatments: TreatmentRow[] | null; canManage: boolean }) {
  const queryClient = useQueryClient();
  const timeZone = useHospitalTimeZone();
  const [rescheduling, setRescheduling] = useState<TreatmentRow | null>(null);
  const [cancelling, setCancelling] = useState<TreatmentRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const surgeries = upcomingSurgeries(treatments, new Date());
  if (surgeries.length === 0) return null;

  async function cancel(t: TreatmentRow) {
    setCancelling(null);
    setError(null);
    try {
      await api.updateTreatmentStatus(t.id, "CANCELLED");
    } catch (err) {
      setError(err instanceof ApiError && err.message === "invalid_transition" ? "That surgery has already changed — refreshed." : "Couldn't cancel the surgery — try again.");
    } finally {
      invalidateAppointmentQueries(queryClient);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="surgery-card">
      <FormError message={error} testId="surgery-card-error" />
      {surgeries.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center justify-between gap-3" data-testid={`surgery-${t.id}`}>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Surgery scheduled</p>
            <p className="mt-1 text-sm font-semibold text-ink" data-testid="surgery-label">{t.treatmentLabel}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-2" data-testid="surgery-when">
              <CalendarClock size={13} aria-hidden="true" className="text-primary-600" />
              {when(t.plannedDate!, timeZone)}
            </p>
            <p className="mt-0.5 text-xs text-ink-2" data-testid="surgery-where">{[t.resourceName ?? t.doctorName, t.branchName].filter(Boolean).join(" · ") || "Doctor not recorded"}</p>
            {t.scheduleNote && <p className="mt-0.5 text-xs text-ink-2">{t.scheduleNote}</p>}
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-0" onClick={() => setRescheduling(t)} data-testid={`surgery-reschedule-${t.id}`}>
                Reschedule
              </Button>
              <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-0" onClick={() => setCancelling(t)} data-testid={`surgery-cancel-${t.id}`}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      ))}
      {rescheduling && <RescheduleSurgerySheet treatment={rescheduling} onClose={() => setRescheduling(null)} />}
      <ConfirmDialog
        open={!!cancelling}
        title="Cancel this surgery?"
        description={cancelling ? `${cancelling.treatmentLabel} on ${when(cancelling.plannedDate!, timeZone)} will be cancelled and removed from the schedule. PulseOS does not notify the patient automatically.` : ""}
        confirmLabel="Cancel surgery"
        cancelLabel="Keep surgery"
        onConfirm={() => cancelling && cancel(cancelling)}
        onCancel={() => setCancelling(null)}
      />
    </Card>
  );
}

const SERVER_ERRORS: Record<string, string> = {
  scheduled_in_past: "Pick a surgery time in the future.",
  resource_invalid: "That doctor is no longer available. Choose another.",
  branch_invalid: "That branch isn't available. Choose another.",
  invalid_transition: "This surgery is no longer scheduled — it may have just changed.",
};

function RescheduleSurgerySheet({ treatment, onClose }: { treatment: TreatmentRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const timeZone = useHospitalTimeZone();
  const resources = useQuery({ queryKey: ["resources"], queryFn: () => api.resources(), staleTime: 60_000 });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const [form, setForm] = useState<SurgeryFormState>(() => ({
    ...initialSurgeryForm({ resourceId: treatment.resourceId, branchId: treatment.branchId }),
    ...rescheduleSurgeryDefaults(treatment.plannedDate, timeZone),
    note: treatment.scheduleNote ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof SurgeryFormState>(k: K, v: SurgeryFormState[K]) => setForm((s) => ({ ...s, [k]: v }));

  async function save() {
    if (saving) return;
    const built = buildSurgeryReschedule(form, timeZone, new Date());
    if ("error" in built) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      await api.rescheduleSurgery(treatment.id, built.input);
      invalidateAppointmentQueries(queryClient);
      onClose();
    } catch (err) {
      setError(SERVER_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't reschedule the surgery — what you entered is still here. Try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title="Reschedule surgery"
      subtitle={`${treatment.patientName} · ${treatment.treatmentLabel}`}
      onClose={onClose}
      testId="reschedule-surgery"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0" onClick={save} disabled={saving} data-testid="reschedule-surgery-save">
            {saving ? "Saving…" : "Save new schedule"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="reschedule-surgery-error" />
        {(resources.isLoading || lookups.isLoading) && <Skeleton className="h-40" />}
        {resources.data && lookups.data && <SurgeryFields form={form} onChange={set} procedures={[]} resources={resources.data} branches={lookups.data.branches} hideProcedure testPrefix="reschedule-surgery" />}
      </div>
    </SideSheet>
  );
}
