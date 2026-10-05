"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { clinicHoursHint, clinicTimeBounds } from "@pulseos/ui";
import { CheckRow, SelectInput, TextInput } from "@/components/settings/FormBits";
import { wallTimeToInstant } from "@/lib/hospitalTime";
import type { InlineAppointmentState } from "./inlineAppointment";

/**
 * Date, time and "confirmed with patient" for a visit booked from inside another form. Clinic hours, doctors and branches come from
 * the hospital's own configuration (the same lookups the booking form and the Doctor Planner use). A hospital with one doctor and
 * one branch is never asked for them. `idPrefix` keeps each form's test ids distinct ("log-call", "log-outcome").
 */
export function InlineAppointmentFields({
  state,
  onChange,
  timeZone,
  idPrefix,
  confirmHint,
}: {
  state: InlineAppointmentState;
  onChange: (patch: Partial<InlineAppointmentState>) => void;
  timeZone: string;
  idPrefix: string;
  /** Wording for the on-state of the confirmation switch (what "confirmed" means in this form). */
  confirmHint: string;
}) {
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });
  const doctors = lookups.data?.doctors ?? [];
  const branches = lookups.data?.branches ?? [];
  const hours = lookups.data?.clinicHours ?? null;
  const hoursHint = clinicHoursHint(hours);
  const bounds = clinicTimeBounds(hours, state.apptDate);
  const today = new Date().toLocaleDateString("en-CA", { timeZone });

  // Advisory only (debounced): the save itself decides. Tells staff at once that the doctor is taken at that time.
  // The answer is remembered with the slot it was for, so a changed time never shows the previous time's answer.
  const slotDoctor = state.apptDoctorId || (doctors.length === 1 ? doctors[0]!.id : "");
  const slotAt = state.apptDate && state.apptTime ? wallTimeToInstant(state.apptDate, state.apptTime, timeZone) : null;
  const slotKey = slotDoctor && slotAt ? `${slotDoctor}|${slotAt.getTime()}` : "";
  const [slotAnswer, setSlotAnswer] = useState<{ key: string; busy: boolean } | null>(null);
  const slotBusy = !!slotKey && slotAnswer?.key === slotKey && slotAnswer.busy;
  useEffect(() => {
    if (!slotDoctor || !slotAt) return;
    let live = true;
    const t = setTimeout(() => {
      api.appointmentSlotCheck(slotDoctor, slotAt.toISOString()).then((r) => live && setSlotAnswer({ key: slotKey, busy: !r.available && !r.inPast && !r.outsideHours })).catch(() => undefined);
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [slotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3 rounded-card border border-line bg-surface-info/60 p-3.5" data-testid={`${idPrefix}-appointment-fields`}>
      <div className="grid grid-cols-2 gap-3">
        <TextInput label="Appointment date" type="date" min={today} value={state.apptDate} onChange={(e) => onChange({ apptDate: e.target.value })} data-testid={`${idPrefix}-appt-date`} />
        <TextInput label="Appointment time" type="time" {...(bounds ? { min: bounds.min, max: bounds.max } : {})} value={state.apptTime} onChange={(e) => onChange({ apptTime: e.target.value })} data-testid={`${idPrefix}-appt-time`} />
      </div>
      {hoursHint && (
        <p className="text-[11px] text-ink-2" data-testid={`${idPrefix}-appt-hours`}>
          {hoursHint}
        </p>
      )}
      {doctors.length > 1 && (
        <SelectInput label="Doctor" value={state.apptDoctorId} onChange={(e) => onChange({ apptDoctorId: e.target.value })} data-testid={`${idPrefix}-appt-doctor`}>
          <option value="">Choose a doctor…</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectInput>
      )}
      {branches.length > 1 && (
        <SelectInput label="Branch" value={state.apptBranchId} onChange={(e) => onChange({ apptBranchId: e.target.value })} data-testid={`${idPrefix}-appt-branch`}>
          <option value="">Choose a branch…</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </SelectInput>
      )}
      {slotBusy && (
        <p className="text-xs font-medium text-warning" role="status" data-testid={`${idPrefix}-appt-busy`}>
          The doctor already has a patient at this time. Choose another time.
        </p>
      )}
      <CheckRow
        label="Appointment confirmed with patient"
        hint={state.apptConfirmed ? confirmHint : "Only booked for now. No message goes to the patient until you confirm the appointment."}
        checked={state.apptConfirmed}
        onChange={(v) => onChange({ apptConfirmed: v })}
        testId={`${idPrefix}-appt-confirmed`}
      />
    </div>
  );
}
