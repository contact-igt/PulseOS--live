"use client";

import { useEffect, useState } from "react";
import type { AppointmentRow, ClinicHours, CreateAppointmentInput, JourneyCardVm, LookupOption, PatientListRow } from "@pulseos/types";
import { clinicHoursError, clinicHoursHint } from "./clinicHours";
import { hospitalLocalInput } from "./format";
import { JOURNEY_STAGE_LABEL } from "./status";
import { useDialogFocus } from "./useDialogFocus";

type PatientRef = Pick<PatientListRow, "id" | "name" | "phone">;

const inputClass =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";

/** Tomorrow, on the hour, as the HOSPITAL reads it (the picker is hospital wall time). */
function defaultDateTime(): string {
  return `${hospitalLocalInput(new Date(Date.now() + 24 * 3600 * 1000)).slice(0, 13)}:00`;
}

// What the person should do next — never a status code, never who holds the other slot.
const PAST_COPY = "Choose a future appointment time.";
const OUTSIDE_COPY = "That time is outside the clinic's hours. Choose a time inside them.";
const BOOKING_ERROR: Record<string, string> = {
  appointment_time_in_past: PAST_COPY,
  outside_clinic_hours: OUTSIDE_COPY,
  resource_unavailable: "This doctor already has another appointment at this time. Choose a different time or doctor.",
  invalid_request: "Check the date and time, then try again.",
};

export function NewAppointmentDrawer({
  open,
  onClose,
  branches,
  doctors,
  initialPatient,
  initialJourneyId,
  toInstant,
  onSearchPatients,
  onLoadPatientJourneys,
  onSubmit,
  onCheckSlot,
  onCreated,
  onCreateLeadInstead,
  clinicHours,
}: {
  open: boolean;
  onClose: () => void;
  branches: LookupOption[];
  doctors: LookupOption[];
  initialPatient?: PatientRef | null;
  /** Preselects this journey (the one the booking is launched from). */
  initialJourneyId?: string;
  /** Converts the picked date-time (YYYY-MM-DDTHH:mm) to an instant in the HOSPITAL's timezone; defaults to the browser's. */
  toInstant?: (local: string) => string;
  onSearchPatients: (query: string) => Promise<PatientListRow[]>;
  onLoadPatientJourneys: (patientId: string) => Promise<JourneyCardVm[]>;
  onSubmit: (input: CreateAppointmentInput) => Promise<AppointmentRow>;
  /** Advisory "is this doctor free then?" as the doctor and time are picked. The server re-checks on booking. */
  onCheckSlot?: (doctorId: string, instant: string) => Promise<{ available: boolean; inPast: boolean; outsideHours?: boolean }>;
  onCreated?: (row: AppointmentRow) => void;
  onCreateLeadInstead?: () => void;
  /** The hospital's weekly hours (Lookups.clinicHours). Null/absent = no restriction. */
  clinicHours?: ClinicHours | null;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PatientListRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [patient, setPatient] = useState<PatientRef | null>(initialPatient ?? null);
  const [journeys, setJourneys] = useState<JourneyCardVm[]>([]);
  const [journeyId, setJourneyId] = useState("");
  const [pickedBranchId, setBranchId] = useState("");
  const [pickedDoctorId, setDoctorId] = useState("");
  // One branch / one doctor: nothing to choose, so it is selected for the user and the field is not shown.
  const soleBranch = branches.length === 1;
  const soleDoctor = doctors.length === 1;
  const branchId = pickedBranchId || (soleBranch ? branches[0]!.id : "");
  const doctorId = pickedDoctorId || (soleDoctor ? doctors[0]!.id : "");
  const [scheduledAt, setScheduledAt] = useState(defaultDateTime());
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotBusy, setSlotBusy] = useState(false);
  // The server's own answer (same rule as booking), for when the form has no clinic hours of its own to check.
  const [outside, setOutside] = useState(false);
  // The advisory "doctor is busy then" warning is its own state, so it can never outlive the doctor/time it was about.
  const [conflict, setConflict] = useState(false);

  const instant = (local: string) => (toInstant ? toInstant(local) : new Date(local).toISOString());
  const nowLocal = hospitalLocalInput();
  // The picked time has already passed (compared as hospital wall time strings; the server decides for real).
  const pastPicked = !!scheduledAt && scheduledAt < nowLocal;
  const [pickedDate = "", pickedTime = ""] = scheduledAt.split("T");
  const hoursError = pastPicked ? null : clinicHoursError(clinicHours, pickedDate, pickedTime);
  const hoursHint = clinicHoursHint(clinicHours);

  // Doctor + time picked: ask whether the slot is free (debounced). Any change drops the old answer at once; failing to
  // ask is silent — the booking itself still checks.
  useEffect(() => {
    setConflict(false);
    setOutside(false);
    if (!onCheckSlot || !doctorId || !scheduledAt || pastPicked || hoursError) {
      setSlotBusy(false);
      return;
    }
    setSlotBusy(true);
    let live = true;
    const t = setTimeout(() => {
      onCheckSlot(doctorId, instant(scheduledAt))
        .then((r) => { if (!live) return; setConflict(!r.available && !r.inPast && !r.outsideHours); setOutside(!!r.outsideHours); })
        .catch(() => undefined)
        .finally(() => live && setSlotBusy(false));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `instant` only wraps `toInstant`, which does not change while the drawer is open.
  }, [doctorId, scheduledAt, pastPicked, hoursError, onCheckSlot]);

  // initialPatient's active journeys aren't known synchronously at mount
  // (they're fetched), so this fetch still needs an effect — unlike the
  // rest of the form's state, which is now correct from the very first
  // render because the whole drawer only mounts while `open` is true (see
  // QuickCreateProvider), giving every field a fresh initial value without
  // a post-paint reset.
  useEffect(() => {
    if (initialPatient) {
      onLoadPatientJourneys(initialPatient.id).then((rows) => {
        setJourneys(rows);
        setJourneyId(rows.find((r) => r.id === initialJourneyId)?.id ?? rows[0]?.id ?? "");
      });
    }
  }, [initialPatient, initialJourneyId, onLoadPatientJourneys]);

  const dialogRef = useDialogFocus<HTMLFormElement>(open, onClose);

  if (!open) return null;

  async function runSearch() {
    if (!search.trim()) return;
    setSearching(true);
    try {
      setResults(await onSearchPatients(search.trim()));
    } finally {
      setSearching(false);
    }
  }

  async function selectPatient(p: PatientListRow) {
    setPatient(p);
    setResults(null);
    const rows = await onLoadPatientJourneys(p.id);
    setJourneys(rows);
    setJourneyId(rows[0]?.id ?? "");
  }

  const canSubmit = patient && journeyId && branchId && doctorId && scheduledAt && !submitting && !pastPicked && !hoursError && !outside;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !patient) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await onSubmit({ patientId: patient.id, journeyId, branchId, doctorId, scheduledAt: instant(scheduledAt), reason: reason.trim() || undefined });
      onCreated?.(row);
      onClose();
    } catch (err) {
      // Everything typed stays: the drawer only says what to change. ApiError carries the server's code as its message.
      const code = err instanceof Error ? err.message : "";
      setError(BOOKING_ERROR[code] ?? "Could not book this appointment. Check the required fields and try again.");
      // See AddPatientDrawer: disabling the submit button on `submitting`
      // blurs it to <body>, outside the dialog, which would let a failed
      // submit silently escape the Tab trap. Pull focus back in.
      dialogRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-sheet) flex justify-end" role="dialog" aria-modal="true" aria-label="New Appointment">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 drawer-backdrop bg-slate-900/30" />
      <form
        ref={dialogRef}
        tabIndex={-1}
        onSubmit={handleSubmit}
        className="relative flex h-full w-full max-w-md flex-col overflow-hidden drawer-panel focus:outline-none"
        data-testid="new-appointment-drawer"
      >
        <div className="flex items-start justify-between gap-2 border-b border-line p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">New Appointment</h2>
            <p className="mt-0.5 text-xs text-neutral-500">Book a visit for an existing patient and journey.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-slate-900" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <label className={labelClass} htmlFor="appt-patient-search">
              Patient <span className="text-danger-500">*</span>
            </label>
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm">
                <span className="text-primary-800">
                  {patient.name} <span className="text-primary-500">· {patient.phone}</span>
                </span>
                <button type="button" onClick={() => setPatient(null)} className="text-xs text-primary-600 hover:underline">
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    id="appt-patient-search"
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), runSearch())}
                    placeholder="Search by name or phone…"
                    className={inputClass}
                  />
                  <button type="button" onClick={runSearch} className="shrink-0 rounded-lg border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
                    {searching ? "…" : "Search"}
                  </button>
                </div>
                {results && (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-neutral-200">
                    {results.length === 0 ? (
                      <div className="p-3 text-center">
                        <p className="text-xs text-neutral-400">No patient found.</p>
                        {onCreateLeadInstead && (
                          <button type="button" onClick={onCreateLeadInstead} className="mt-1 text-xs font-medium text-primary-600 hover:underline">
                            Create Lead / Patient instead →
                          </button>
                        )}
                      </div>
                    ) : (
                      results.map((p) => (
                        <button key={p.id} type="button" onClick={() => selectPatient(p)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-50">
                          <span className="text-slate-900">{p.name}</span>
                          <span className="text-neutral-400">{p.phone}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {patient && (
            <div>
              <label className={labelClass} htmlFor="appt-journey">
                Journey <span className="text-danger-500">*</span>
              </label>
              <select id="appt-journey" required value={journeyId} onChange={(e) => setJourneyId(e.target.value)} className={inputClass}>
                {journeys.length === 0 && <option value="">No active journeys</option>}
                {journeys.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.journeyType} — {JOURNEY_STAGE_LABEL[j.stage] ?? j.stage}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(!soleBranch || !soleDoctor) && (
          <div className={soleBranch || soleDoctor ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
            {!soleBranch && (<div>
              <label className={labelClass} htmlFor="appt-branch">
                Branch <span className="text-danger-500">*</span>
              </label>
              <select id="appt-branch" required value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClass}>
                <option value="">Select…</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>)}
            {!soleDoctor && (<div>
              <label className={labelClass} htmlFor="appt-doctor">
                Doctor <span className="text-danger-500">*</span>
              </label>
              <select id="appt-doctor" required value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setError(null); }} className={inputClass}>
                <option value="">Select…</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>)}
          </div>
          )}

          <div>
            <label className={labelClass} htmlFor="appt-time">
              Date &amp; time <span className="text-danger-500">*</span>
            </label>
            <input id="appt-time" type="datetime-local" required value={scheduledAt} min={nowLocal} onChange={(e) => { setScheduledAt(e.target.value); setError(null); }} aria-invalid={pastPicked || !!hoursError || outside || undefined} aria-describedby={[pastPicked || hoursError || outside ? "appt-time-error" : "", hoursHint ? "appt-time-hint" : ""].filter(Boolean).join(" ") || undefined} className={inputClass} data-testid="appt-time" />
            {hoursHint && <p id="appt-time-hint" className="mt-1 text-xs text-ink-2" data-testid="appt-clinic-hours">{hoursHint}</p>}
            {(pastPicked || hoursError || outside) && (
              <p id="appt-time-error" role="alert" className="mt-1 text-xs text-danger-700" data-testid={pastPicked ? "appt-time-past" : "appt-time-clinic-hours"}>
                {pastPicked ? PAST_COPY : hoursError ?? OUTSIDE_COPY}
              </p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor="appt-reason">
              Reason
            </label>
            <input id="appt-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </div>

          {(error ?? (conflict ? BOOKING_ERROR.resource_unavailable : null)) && (
            <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-xs text-danger-700" data-testid="new-appointment-error">
              {error ?? BOOKING_ERROR.resource_unavailable}
            </p>
          )}
          <p className="text-[11px] text-ink-2" role="status" aria-live="polite">
            {slotBusy && !error && !conflict ? "Checking the doctor's availability…" : ""}
          </p>
        </div>

        <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface p-4">
          <button type="button" onClick={onClose} className="flex-1 rounded-control border border-line-strong px-3 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50">
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} className="flex-1 rounded-control bg-primary-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-primary-700 disabled:opacity-40" data-testid="new-appointment-submit">
            {submitting ? "Booking…" : "Book Appointment"}
          </button>
        </div>
      </form>
    </div>
  );
}
