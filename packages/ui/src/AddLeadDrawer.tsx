"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  UNKNOWN_PATIENT_NAME,
  type ClinicHours,
  type CreateLeadInput,
  type CreateLeadResult,
  type CrmOutcomeVm,
  type CustomFieldDefinitionVm,
  type LeadPhoneLookupResult,
  type LeadSourceVm,
  type Lookups,
  type SourceChannel,
  type SpecialtyTemplateVm,
  type TaskPriority,
} from "@pulseos/types";
import { X } from "lucide-react";
import { useDialogFocus } from "./useDialogFocus";
import { CustomFieldInputs, applyFieldRules, defaultsFor, normalizeFieldValues } from "./CustomFieldInputs";
import { clinicHoursError, clinicHoursHint, clinicTimeBounds } from "./clinicHours";
import { hospitalLocalInput } from "./format";
import { LEAD_CHANNEL_OPTIONS, LEAD_ERROR_COPY, nextStepAvailability, reconcileNextStep, saveReadiness, toCreateLeadInput, type LeadFormValues, type NextStepKind } from "./addLeadModel";

const inputClass =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500 max-md:min-h-11";
const labelClass = "mb-1 block text-xs font-medium text-neutral-600";
const sectionHead = "mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-600";

/** Tomorrow's date in the HOSPITAL's calendar (pickers are hospital wall time). */
const tomorrow = () => hospitalLocalInput(new Date(Date.now() + 24 * 3600 * 1000)).slice(0, 10);

function emptyForm(sourceKey: string, branchId: string, doctorId = ""): LeadFormValues {
  const d = tomorrow();
  return {
    patientId: undefined, phone: "", name: "", age: "", dateOfBirth: "", specialtyKey: "", journeyType: "", branchId, sourceKey, channel: "", outcomeKey: "", outcomeReason: "",
    nextStep: "none", callbackDate: d, callbackTime: "11:00", callbackOwner: "", callbackNote: "", apptDate: d, apptTime: "10:00", apptDoctorId: doctorId, apptBranchId: "", apptNote: "",
    followUpDate: d, followUpTime: "10:00", followUpNote: "", callEnabled: false, callDirection: "inbound", callConnected: true, callMinutes: "", callNote: "",
    email: "", preferredLanguage: "English", doctorId: "", campaignId: "", ownerId: "", priority: "normal" as TaskPriority, notes: "", customFieldValues: {},
  };
}

const NEXT_STEPS: { key: NextStepKind; label: string; hint?: string }[] = [
  { key: "callback", label: "Callback" },
  { key: "appointment", label: "Appointment" },
  { key: "follow_up", label: "General follow-up", hint: "Not decided yet" },
  { key: "none", label: "No follow-up" },
];

/**
 * Add Lead: the short path — phone, name, what they asked about, where they came from, what happens next — with the
 * date/time/doctor fields appearing only for the next step chosen. Everything else sits under "Additional details";
 * required tenant fields are shown up front. One Save: the server creates the patient, journey, outcome and the
 * follow-up or appointment together, or none of them.
 */
export function AddLeadDrawer({
  open,
  onClose,
  specialties,
  lookups,
  clinicHours,
  leadSources,
  outcomes = [],
  defaultSource,
  onPhoneLookup,
  onLoadCustomFields,
  onCheckSlot,
  onSubmit,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  specialties: SpecialtyTemplateVm[];
  lookups: Lookups;
  /** Overrides lookups.clinicHours; null = no restriction. */
  clinicHours?: ClinicHours | null;
  /** The sources the hospital offers for a new lead (non-archived). */
  leadSources: LeadSourceVm[];
  /** The hospital's configured outcomes (active), in their configured order. */
  outcomes?: CrmOutcomeVm[];
  /** Preselects the first offered source whose coarse bucket matches (e.g. from a campaign page). */
  defaultSource?: SourceChannel;
  onPhoneLookup: (phone: string) => Promise<LeadPhoneLookupResult>;
  onLoadCustomFields: (specialtyKey: string) => Promise<CustomFieldDefinitionVm[]>;
  /** Advisory: is this doctor free at this hospital wall time? */
  onCheckSlot?: (doctorId: string, scheduledAt: string) => Promise<{ available: boolean; inPast: boolean; outsideHours?: boolean }>;
  onSubmit: (input: CreateLeadInput) => Promise<CreateLeadResult>;
  onCreated?: (result: CreateLeadResult) => void;
}) {
  const [form, setForm] = useState<LeadFormValues>(() => emptyForm((defaultSource && leadSources.find((s) => s.bucket === defaultSource)?.key) || leadSources[0]?.key || "", lookups.branches.length === 1 ? lookups.branches[0]!.id : "", lookups.doctors.length === 1 ? lookups.doctors[0]!.id : ""));
  // One branch / one doctor: nothing to choose, so it is pre-selected above and the field is not shown.
  const soleBranch = lookups.branches.length === 1;
  const soleDoctor = lookups.doctors.length === 1;
  const [existingPatient, setExistingPatient] = useState<{ id: string; name: string; activeJourneyCount: number } | null>(null);
  const [phoneChecked, setPhoneChecked] = useState(false);
  const [fields, setFields] = useState<CustomFieldDefinitionVm[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const additionalRef = useRef<HTMLDetailsElement>(null);

  const dialogRef = useDialogFocus<HTMLFormElement>(open, onClose);
  const set = <K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) => {
    setError(null);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const outcome = outcomes.find((o) => o.key === form.outcomeKey);
  const avail = nextStepAvailability(outcome);
  // The hospital's show/require rules, evaluated for the current answers and chosen outcome (same rules as the server).
  const ruledFields = applyFieldRules(fields, form.customFieldValues, form.outcomeKey || null);
  const requiredFields = ruledFields.filter((f) => f.required);
  const optionalFields = ruledFields.filter((f) => !f.required);
  const nowLocal = hospitalLocalInput();
  const apptAt = form.apptDate && form.apptTime ? `${form.apptDate}T${form.apptTime}` : "";
  const apptPast = form.nextStep === "appointment" && !!apptAt && apptAt < nowLocal;
  const hours = clinicHours === undefined ? lookups.clinicHours : clinicHours;
  const apptHoursError = form.nextStep === "appointment" && !apptPast ? clinicHoursError(hours, form.apptDate, form.apptTime) : null;
  const apptHoursHint = clinicHoursHint(hours);
  const apptBounds = clinicTimeBounds(hours, form.apptDate);
  const callbackPast = form.nextStep === "callback" && !!form.callbackDate && !!form.callbackTime && `${form.callbackDate}T${form.callbackTime}` < nowLocal;
  const followUpPast = form.nextStep === "follow_up" && !!form.followUpDate && !!form.followUpTime && `${form.followUpDate}T${form.followUpTime}` < nowLocal;
  const selectedService = specialties.find((s) => s.key === form.specialtyKey);
  const selectedBucket = leadSources.find((s) => s.key === form.sourceKey)?.bucket;
  const campaignsForSource = lookups.campaigns.filter((c) => c.source === selectedBucket);

  // Appointment: ask whether the doctor is free then (debounced, advisory — the save itself decides).
  useEffect(() => {
    setConflict(false);
    if (!onCheckSlot || form.nextStep !== "appointment" || !form.apptDoctorId || !apptAt || apptPast || apptHoursError) return;
    let live = true;
    const t = setTimeout(() => {
      onCheckSlot(form.apptDoctorId, apptAt).then((r) => live && setConflict(!r.available && !r.inPast && !r.outsideHours)).catch(() => undefined);
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [onCheckSlot, form.nextStep, form.apptDoctorId, apptAt, apptPast, apptHoursError]);

  if (!open) return null;

  async function checkPhone() {
    if (form.phone.replace(/\D/g, "").length < 10) return;
    const result = await onPhoneLookup(form.phone);
    setPhoneChecked(true);
    if (result.patient) {
      setExistingPatient(result.patient);
      // A patient whose name is not known yet has nothing to prefill — the name stays editable so it can be added.
      const known = result.patient.name !== UNKNOWN_PATIENT_NAME;
      setForm((f) => ({ ...f, patientId: result.patient!.id, name: known ? result.patient!.name : "" }));
    } else {
      setExistingPatient(null);
      setForm((f) => ({ ...f, patientId: undefined }));
    }
  }

  async function onSpecialtyChange(key: string) {
    const template = specialties.find((s) => s.key === key);
    setError(null);
    setForm((f) => ({ ...f, specialtyKey: key, journeyType: template?.defaultJourneyType ?? f.journeyType, customFieldValues: {} }));
    const activeFields = key ? await onLoadCustomFields(key) : [];
    setFields(activeFields);
    // Pre-fill the defaults configured for these fields (Settings → CRM Fields).
    setForm((f) => (f.specialtyKey === key ? { ...f, customFieldValues: defaultsFor(activeFields) } : f));
  }

  function onOutcomeChange(key: string) {
    const next = outcomes.find((o) => o.key === key);
    setError(null);
    setForm((f) => ({ ...f, outcomeKey: key, outcomeReason: "", nextStep: reconcileNextStep(f.nextStep, next) }));
  }

  function fail(code: string, text?: string) {
    // A refusal about a field that lives under "Additional details" must not be about something the person cannot see.
    if (["invalid_field_values", "missing_required_fields", "invalid_request"].includes(code) && additionalRef.current) additionalRef.current.open = true;
    setError({ code, text: text ?? LEAD_ERROR_COPY[code] ?? "Could not save this lead. Check the details and try again." });
    // Everything typed stays. Pull focus back inside the dialog (a disabled submit button would blur it to <body>).
    requestAnimationFrame(() => (errorRef.current ?? dialogRef.current)?.focus());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const readiness = saveReadiness(form, { nowLocal, outcome, requiredFieldKeys: requiredFields.map((f) => f.key), hasAppointmentDoctors: lookups.doctors.length > 0 });
    if (!readiness.ok) return fail("client", readiness.reasons[0]);
    if (apptHoursError) return fail("client", apptHoursError);
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(toCreateLeadInput(form, { normalizeFields: (v) => normalizeFieldValues(ruledFields, v) }));
      onCreated?.(result);
      onClose();
    } catch (err) {
      // ApiError carries the server's code as its message; the form keeps everything that was typed.
      const code = err instanceof Error ? err.message : "";
      fail(code, LEAD_ERROR_COPY[code]);
    } finally {
      setSubmitting(false);
    }
  }

  const doctorBusy = form.nextStep === "appointment" && conflict;
  const stepHint = avail.hint;

  return (
    <div className="fixed inset-0 z-(--z-sheet) flex justify-end" role="dialog" aria-modal="true" aria-label="Add Lead">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 drawer-backdrop bg-slate-900/30" />
      <form ref={dialogRef} tabIndex={-1} onSubmit={handleSubmit} className="relative flex h-full w-full max-w-lg flex-col overflow-hidden drawer-panel focus:outline-none" data-testid="add-lead-drawer">
        <div className="flex items-start justify-between gap-2 border-b border-line p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Add Lead</h2>
            <p className="mt-0.5 text-xs text-neutral-500">Who called, what they need, and what happens next.</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded text-ink-2 hover:bg-neutral-100 hover:text-slate-900 sm:h-8 sm:w-8" aria-label="Close" data-testid="add-lead-drawer-close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {/* Patient */}
          <section>
            <h3 className={sectionHead}>Patient</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass} htmlFor="lead-phone">
                  Phone <span className="text-danger-500">*</span>
                </label>
                <input
                  id="lead-phone"
                  type="tel"
                  required
                  value={form.phone}
                  onChange={(e) => {
                    set("phone", e.target.value);
                    setPhoneChecked(false);
                  }}
                  onBlur={checkPhone}
                  className={inputClass}
                  placeholder="+91 98765 43210"
                  autoComplete="off"
                  data-testid="lead-phone-input"
                />
                {phoneChecked && existingPatient && (
                  <p className="mt-1.5 rounded-lg bg-primary-50 px-2.5 py-1.5 text-xs text-primary-700" data-testid="existing-patient-banner">
                    Existing patient found — {existingPatient.name} ({existingPatient.activeJourneyCount} active journey{existingPatient.activeJourneyCount === 1 ? "" : "s"}). This will create a new journey, not a duplicate patient.
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor="lead-name">
                  Name
                </label>
                <input
                  id="lead-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  disabled={!!existingPatient && form.name !== "" && existingPatient.name !== UNKNOWN_PATIENT_NAME}
                  placeholder="Add when you have it"
                  className={`${inputClass} disabled:bg-neutral-50 disabled:text-neutral-500`}
                  data-testid="lead-name-input"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass} htmlFor="lead-age">
                    Age
                  </label>
                  <input id="lead-age" type="number" inputMode="numeric" min={0} max={120} step={1} value={form.age} onChange={(e) => set("age", e.target.value)} className={inputClass} placeholder="Years" data-testid="lead-age-input" />
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-dob">
                    Date of birth
                  </label>
                  <input id="lead-dob" type="date" value={form.dateOfBirth} max={hospitalLocalInput().slice(0, 10)} onChange={(e) => set("dateOfBirth", e.target.value)} className={inputClass} data-testid="lead-dob-input" />
                </div>
              </div>
            </div>
          </section>

          {/* Enquiry */}
          <section>
            <h3 className={sectionHead}>Enquiry</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass} htmlFor="lead-specialty">
                  Service / enquiry <span className="text-danger-500">*</span>
                </label>
                <select id="lead-specialty" required value={form.specialtyKey} onChange={(e) => onSpecialtyChange(e.target.value)} className={inputClass} data-testid="lead-specialty-select">
                  <option value="">Select service…</option>
                  {specialties.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
                {selectedService?.departmentName && (
                  <p className="mt-1 text-[11px] text-neutral-500" data-testid="lead-department">
                    Department: {selectedService.departmentName}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="lead-source">
                    Original source <span className="text-danger-500">*</span>
                  </label>
                  <select id="lead-source" required value={form.sourceKey} onChange={(e) => setForm((f) => ({ ...f, sourceKey: e.target.value, campaignId: "" }))} className={inputClass} data-testid="lead-source-select">
                    {leadSources.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-channel">
                    How did they reach us?
                  </label>
                  <select id="lead-channel" value={form.channel} onChange={(e) => set("channel", e.target.value as LeadFormValues["channel"])} className={inputClass} data-testid="lead-channel-select">
                    <option value="">Not specified</option>
                    {LEAD_CHANNEL_OPTIONS.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="-mt-1 text-[11px] text-neutral-500">Source is where the patient first came from; it stays with them. Channel is how this contact happened.</p>
              {!soleBranch && (<div>
                <label className={labelClass} htmlFor="lead-branch">
                  Branch <span className="text-danger-500">*</span>
                </label>
                <select id="lead-branch" required value={form.branchId} onChange={(e) => set("branchId", e.target.value)} className={inputClass}>
                  <option value="">Select branch…</option>
                  {lookups.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>)}

              {form.channel === "MANUAL_CALL" && (
                <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-3" data-testid="lead-call-details">
                  <label className="flex min-h-6 items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={form.callEnabled} onChange={(e) => set("callEnabled", e.target.checked)} className="h-4 w-4" data-testid="lead-call-toggle" />
                    Add call details
                  </label>
                  {form.callEnabled && (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelClass} htmlFor="lead-call-direction">Call</label>
                        <select id="lead-call-direction" value={form.callDirection} onChange={(e) => set("callDirection", e.target.value as "inbound" | "outbound")} className={inputClass} data-testid="lead-call-direction">
                          <option value="inbound">Incoming</option>
                          <option value="outbound">Outgoing</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="lead-call-minutes">Minutes talked</label>
                        <input id="lead-call-minutes" type="number" min={0} max={600} step={0.5} inputMode="decimal" value={form.callMinutes} disabled={!form.callConnected} onChange={(e) => set("callMinutes", e.target.value)} className={`${inputClass} disabled:bg-neutral-100`} data-testid="lead-call-minutes" />
                      </div>
                      <label className="col-span-2 flex min-h-6 items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={form.callConnected} onChange={(e) => set("callConnected", e.target.checked)} className="h-4 w-4" data-testid="lead-call-connected" />
                        The call connected
                      </label>
                      <div className="col-span-2">
                        <label className={labelClass} htmlFor="lead-call-note">Call note</label>
                        <input id="lead-call-note" type="text" maxLength={500} value={form.callNote} onChange={(e) => set("callNote", e.target.value)} className={inputClass} data-testid="lead-call-note" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Required tenant fields, surfaced up front */}
          {requiredFields.length > 0 && (
            <section data-testid="lead-required-fields">
              <h3 className={sectionHead}>{selectedService?.displayName ?? "Service"} — required details</h3>
              <CustomFieldInputs fields={requiredFields} values={form.customFieldValues} onChange={(k, v) => set("customFieldValues", { ...form.customFieldValues, [k]: v })} idPrefix="lead-field" testId="lead-custom-field-inputs" />
            </section>
          )}

          {/* Outcome */}
          {outcomes.length > 0 && (
            <section>
              <h3 className={sectionHead}>What happened?</h3>
              <label className={labelClass} htmlFor="lead-outcome">
                Outcome of this contact
              </label>
              <select id="lead-outcome" value={form.outcomeKey} onChange={(e) => onOutcomeChange(e.target.value)} className={inputClass} data-testid="lead-outcome-select">
                <option value="">Not recorded yet</option>
                {outcomes.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              {outcome?.asksReason && (
                <div className="mt-3">
                  <label className={labelClass} htmlFor="lead-outcome-reason">
                    Reason (optional)
                  </label>
                  <input id="lead-outcome-reason" type="text" maxLength={500} value={form.outcomeReason} onChange={(e) => set("outcomeReason", e.target.value)} className={inputClass} data-testid="lead-outcome-reason" />
                </div>
              )}
            </section>
          )}

          {/* Next step */}
          <section>
            <h3 className={sectionHead}>Next step</h3>
            <fieldset>
              <legend className="sr-only">Next step</legend>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {NEXT_STEPS.map((s) => {
                  const allowed = avail[s.key];
                  const on = form.nextStep === s.key;
                  return (
                    <label key={s.key} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${on ? "border-primary-500 bg-primary-50 text-primary-800" : "border-neutral-200 text-slate-700 hover:bg-neutral-50"} ${allowed ? "" : "cursor-not-allowed opacity-45"}`}>
                      <input type="radio" name="lead-next-step" value={s.key} checked={on} disabled={!allowed} onChange={() => set("nextStep", s.key)} className="h-4 w-4 text-primary-600" data-testid={`lead-next-${s.key}`} />
                      <span>
                        {s.label}
                        {s.hint && <span className="ml-1 text-[11px] text-neutral-500">· {s.hint}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {stepHint && <p className="mt-2 text-[11px] text-neutral-600" data-testid="lead-next-hint">{stepHint}</p>}

            {form.nextStep === "callback" && (
              <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-neutral-100 bg-neutral-50 p-3" data-testid="lead-callback-fields">
                <div>
                  <label className={labelClass} htmlFor="lead-callback-date">Date</label>
                  <input id="lead-callback-date" type="date" required value={form.callbackDate} min={nowLocal.slice(0, 10)} onChange={(e) => set("callbackDate", e.target.value)} aria-invalid={callbackPast || undefined} className={inputClass} data-testid="lead-callback-date" />
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-callback-time">Time</label>
                  <input id="lead-callback-time" type="time" required value={form.callbackTime} onChange={(e) => set("callbackTime", e.target.value)} aria-invalid={callbackPast || undefined} className={inputClass} data-testid="lead-callback-time" />
                </div>
                <div className="col-span-2">
                  <label className={labelClass} htmlFor="lead-callback-owner">Who calls back</label>
                  <select id="lead-callback-owner" value={form.callbackOwner} onChange={(e) => set("callbackOwner", e.target.value)} className={inputClass} data-testid="lead-callback-owner">
                    <option value="">Assigned Team Member (default)</option>
                    {lookups.owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className={labelClass} htmlFor="lead-callback-note">Note (optional)</label>
                  <input id="lead-callback-note" type="text" maxLength={500} value={form.callbackNote} onChange={(e) => set("callbackNote", e.target.value)} className={inputClass} data-testid="lead-callback-note" />
                </div>
                {callbackPast && <p className="col-span-2 text-xs text-danger-700" role="status" data-testid="lead-callback-past">Choose a future callback time.</p>}
              </div>
            )}

            {form.nextStep === "follow_up" && (
              <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-neutral-100 bg-neutral-50 p-3" data-testid="lead-followup-fields">
                <div>
                  <label className={labelClass} htmlFor="lead-followup-date">Follow up on</label>
                  <input id="lead-followup-date" type="date" required value={form.followUpDate} min={nowLocal.slice(0, 10)} onChange={(e) => set("followUpDate", e.target.value)} className={inputClass} data-testid="lead-followup-date" />
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-followup-time">Time</label>
                  <input id="lead-followup-time" type="time" required value={form.followUpTime} onChange={(e) => set("followUpTime", e.target.value)} className={inputClass} data-testid="lead-followup-time" />
                </div>
                <div className="col-span-2">
                  <label className={labelClass} htmlFor="lead-followup-note">Note (optional)</label>
                  <input id="lead-followup-note" type="text" maxLength={500} value={form.followUpNote} onChange={(e) => set("followUpNote", e.target.value)} className={inputClass} data-testid="lead-followup-note" />
                </div>
                {followUpPast && <p className="col-span-2 text-xs text-danger-700" role="status">Choose a future follow-up time.</p>}
              </div>
            )}

            {form.nextStep === "appointment" && (
              <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-neutral-100 bg-neutral-50 p-3" data-testid="lead-appt-fields">
                <div>
                  <label className={labelClass} htmlFor="lead-appt-date">Date</label>
                  <input id="lead-appt-date" type="date" required value={form.apptDate} min={nowLocal.slice(0, 10)} onChange={(e) => set("apptDate", e.target.value)} aria-invalid={apptPast || !!apptHoursError || undefined} aria-describedby={apptHoursHint ? "lead-appt-hours-hint" : undefined} className={inputClass} data-testid="lead-appt-date" />
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-appt-time">Time</label>
                  <input id="lead-appt-time" type="time" required value={form.apptTime} onChange={(e) => set("apptTime", e.target.value)} min={apptBounds?.min} max={apptBounds?.max} aria-invalid={apptPast || !!apptHoursError || undefined} aria-describedby={apptHoursHint ? "lead-appt-hours-hint" : undefined} className={inputClass} data-testid="lead-appt-time" />
                </div>
                {!soleDoctor && (<div className="col-span-2 sm:col-span-1">
                  <label className={labelClass} htmlFor="lead-appt-doctor">Doctor <span className="text-danger-500">*</span></label>
                  <select id="lead-appt-doctor" required value={form.apptDoctorId} onChange={(e) => set("apptDoctorId", e.target.value)} className={inputClass} data-testid="lead-appt-doctor">
                    <option value="">Select doctor…</option>
                    {lookups.doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>)}
                {!soleBranch && (<div className="col-span-2 sm:col-span-1">
                  <label className={labelClass} htmlFor="lead-appt-branch">Branch</label>
                  <select id="lead-appt-branch" value={form.apptBranchId || form.branchId} onChange={(e) => set("apptBranchId", e.target.value)} className={inputClass} data-testid="lead-appt-branch">
                    {lookups.branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>)}
                <div className="col-span-2">
                  <label className={labelClass} htmlFor="lead-appt-note">Note (optional)</label>
                  <input id="lead-appt-note" type="text" maxLength={500} value={form.apptNote} onChange={(e) => set("apptNote", e.target.value)} className={inputClass} data-testid="lead-appt-note" />
                </div>
                {apptHoursHint && <p id="lead-appt-hours-hint" className="col-span-2 -mt-1 text-xs text-ink-2" data-testid="lead-appt-clinic-hours">{apptHoursHint}</p>}
                {apptHoursError && <p className="col-span-2 text-xs text-danger-700" role="alert" data-testid="lead-appt-clinic-hours-error">{apptHoursError}</p>}
                {(apptPast || doctorBusy) && (
                  <p className="col-span-2 text-xs text-danger-700" role="status" data-testid="lead-appt-warning">
                    {apptPast ? LEAD_ERROR_COPY.appointment_time_in_past : LEAD_ERROR_COPY.resource_unavailable}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Everything else, out of the way */}
          <details ref={additionalRef} className="group rounded-lg border border-neutral-100" data-testid="lead-additional">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-slate-700" data-testid="lead-additional-toggle">
              Additional details
              <span className="text-xs font-normal text-neutral-500 group-open:hidden">Email, team member, notes, more…</span>
            </summary>
            <div className="space-y-3 border-t border-neutral-100 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="lead-email">Email</label>
                  <input id="lead-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-language">Preferred language</label>
                  <input id="lead-language" type="text" value={form.preferredLanguage} onChange={(e) => set("preferredLanguage", e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-journey-type">Journey type</label>
                  <input id="lead-journey-type" type="text" value={form.journeyType} onChange={(e) => set("journeyType", e.target.value)} className={inputClass} />
                </div>
                {!soleDoctor && (<div>
                  <label className={labelClass} htmlFor="lead-doctor">Preferred doctor</label>
                  <select id="lead-doctor" value={form.doctorId} onChange={(e) => set("doctorId", e.target.value)} className={inputClass}>
                    <option value="">No preference</option>
                    {lookups.doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>)}
                <div>
                  <label className={labelClass} htmlFor="lead-owner">Assigned Team Member</label>
                  <select id="lead-owner" value={form.ownerId} onChange={(e) => set("ownerId", e.target.value)} className={inputClass}>
                    <option value="">Unassigned</option>
                    {lookups.owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="lead-priority">Priority</label>
                  <select id="lead-priority" value={form.priority} onChange={(e) => set("priority", e.target.value as TaskPriority)} className={inputClass}>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass} htmlFor="lead-campaign">Campaign</label>
                  <select id="lead-campaign" value={form.campaignId} onChange={(e) => set("campaignId", e.target.value)} className={inputClass} disabled={campaignsForSource.length === 0}>
                    <option value="">{campaignsForSource.length === 0 ? "No campaigns for this source" : "None"}</option>
                    {campaignsForSource.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="lead-notes">Notes</label>
                <textarea id="lead-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={inputClass} />
              </div>
              {optionalFields.length > 0 && (
                <div data-testid="lead-custom-fields">
                  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{selectedService?.displayName} details</h4>
                  <CustomFieldInputs fields={optionalFields} values={form.customFieldValues} onChange={(k, v) => set("customFieldValues", { ...form.customFieldValues, [k]: v })} idPrefix="lead-field" testId="lead-optional-field-inputs" />
                </div>
              )}
            </div>
          </details>

          {error && (
            <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-xs text-danger-700 outline-none" data-testid="add-lead-error" data-code={error.code}>
              {error.text}
            </p>
          )}
        </div>

        <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface p-4">
          <button type="button" onClick={onClose} className="flex-1 rounded-control border border-line-strong px-3 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50 max-md:min-h-11">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="flex-1 rounded-control bg-primary-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-primary-700 disabled:opacity-40 max-md:min-h-11" data-testid="add-lead-submit">
            {submitting ? "Saving…" : "Save Lead"}
          </button>
        </div>
      </form>
    </div>
  );
}
