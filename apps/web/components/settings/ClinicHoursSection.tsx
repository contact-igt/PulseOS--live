"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button, ErrorState, Skeleton } from "@pulseos/ui";
import { CheckRow, FormError } from "./FormBits";
import { WEEKDAYS, formToHours, hoursToForm, type HoursForm } from "./clinicHoursForm";

const TIME = "h-11 rounded-control border border-line-strong bg-white px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-8";

/**
 * Settings → Clinic Hours. The hospital's one weekly schedule: appointment booking, the booking forms' time limits, the Front Desk
 * and the Doctor Planner all read this same value, so a change here shows up everywhere on the next refresh. Only this hospital's.
 */
export function ClinicHoursSection() {
  const queryClient = useQueryClient();
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });
  // The form is the hospital's saved hours until the first edit; edits are kept here.
  const [edits, setEdits] = useState<HoursForm | null>(null);
  const form = edits ?? (lookups.data ? hoursToForm(lookups.data.clinicHours) : null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  if (lookups.isLoading || (!form && !lookups.isError)) return <Skeleton className="h-48" />;
  if (lookups.isError || !form) return <ErrorState message="Could not load the clinic hours." />;

  const change = (key: keyof HoursForm, patch: Partial<HoursForm[keyof HoursForm]>) => {
    setSaved(false);
    setError(null);
    setEdits({ ...form, [key]: { ...form[key], ...patch } });
  };

  async function save() {
    const built = formToHours(form!);
    if ("error" in built) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      await api.updateClinicHours(built.hours);
      // Everything that shows or enforces hours re-reads them: booking forms, planner, front desk, slot checks.
      for (const key of ["lookups", "appointments", "front-desk", "slot-check"]) queryClient.invalidateQueries({ queryKey: [key] });
      setSaved(true);
    } catch {
      setError("Couldn't save the clinic hours — what you entered is still here. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="clinic-hours-section">
      <FormError message={error} testId="clinic-hours-error" />
      <ul className="divide-y divide-line rounded-card border border-line bg-white">
        {WEEKDAYS.map(({ key, label }) => {
          const row = form[key];
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2" data-testid={`hours-row-${key}`}>
              <span className="w-24 text-sm font-medium text-ink">{label}</span>
              <CheckRow label="Open" checked={row.open} onChange={(open) => change(key, { open })} testId={`hours-open-${key}`} />
              {row.open ? (
                <span className="flex items-center gap-2 text-xs text-ink-2">
                  <input type="time" aria-label={`${label} opens`} className={TIME} value={row.from} onChange={(e) => change(key, { from: e.target.value })} data-testid={`hours-from-${key}`} />
                  to
                  <input type="time" aria-label={`${label} closes`} className={TIME} value={row.to} onChange={(e) => change(key, { to: e.target.value })} data-testid={`hours-to-${key}`} />
                </span>
              ) : (
                <span className="text-xs text-ink-2">Closed</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={save} disabled={saving} data-testid="clinic-hours-save">
          {saving ? "Saving…" : "Save clinic hours"}
        </Button>
        {saved && (
          <span className="text-xs font-medium text-success" role="status" data-testid="clinic-hours-saved">
            Saved. Booking and the Doctor Planner now use these hours.
          </span>
        )}
      </div>
    </div>
  );
}
