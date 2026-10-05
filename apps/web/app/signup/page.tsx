"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";
import { ChoiceGroup, TextField } from "@/components/signup/Fields";
import {
  SIGNUP_DEPARTMENTS,
  SIGNUP_DISCOVERY_SOURCES,
  SIGNUP_INDUSTRIES,
  SIGNUP_ORGANIZATION_TYPES,
  buildPayload,
  emptyForm,
  firstStepWithError,
  validateStep,
  type FieldErrors,
  type SignupForm,
  type SignupStep,
} from "@/components/signup/signupForm";

const STEPS: { n: SignupStep; title: string; blurb: string }[] = [
  { n: 1, title: "Your account", blurb: "Who will manage PulseOS for your hospital?" },
  { n: 2, title: "Your organization", blurb: "Tell us about the hospital or clinic." },
  { n: 3, title: "Address", blurb: "Where is the main centre?" },
  { n: 4, title: "How did you hear about us?", blurb: "This helps us understand what is working." },
  { n: 5, title: "Choose your setup", blurb: "You can change this later with your administrator." },
];

const EDITIONS = [
  { key: "V1" as const, name: "PulseOS V1", line: "Core CRM and analytics", detail: "Leads, follow-ups, appointments, front desk, treatments and operational analytics." },
  { key: "V2" as const, name: "PulseOS V2", line: "Growth edition", detail: "Everything in V1, plus marketing analytics, ad accounts, campaigns and the WhatsApp inbox." },
];

const TEMPLATE_HINT: Record<string, string> = {
  Ophthalmology: "Ready-made services, fields and treatment catalogue are installed for you.",
  Gynaecology: "Ready-made services, fields and treatment catalogue are installed for you.",
  "ENT / Rhinology": "We will note this. Your workspace starts with the core CRM; a ready-made ENT template is coming.",
  Other: "We will note this. Your workspace starts with the core CRM.",
};

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<SignupStep>(1);
  const [form, setForm] = useState<SignupForm>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; template: "installed" | "none" | "failed" } | null>(null);

  const set = <K extends keyof SignupForm>(key: K, value: SignupForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setFormError(null);
  };
  const meta = STEPS[step - 1]!;

  function next() {
    const problems = validateStep(step, form);
    setErrors(problems);
    if (Object.keys(problems).length === 0 && step < 5) setStep((step + 1) as SignupStep);
  }

  async function submit() {
    // Re-check every step: the person may have walked back and changed something.
    for (const n of [1, 2, 3, 4] as const) {
      const problems = validateStep(n, form);
      if (Object.keys(problems).length) {
        setErrors(problems);
        setStep(n);
        return;
      }
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const { workspace } = await api.signup(buildPayload(form));
      setDone({ name: form.organizationName.trim(), template: workspace.template });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStep(1);
        setErrors({ email: "An account with this email already exists. Sign in instead, or use a different email." });
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError("Too many sign-ups from this connection. Please try again later.");
      } else if (err instanceof ApiError && err.status === 400) {
        const fields = err.issues.map((i) => i.path);
        const fieldErrors: FieldErrors = {};
        for (const i of err.issues) fieldErrors[i.path as keyof SignupForm] = i.message;
        setErrors(fieldErrors);
        setStep(firstStepWithError(fields));
        setFormError(fields.length ? "Please check the highlighted details." : "Please check your details and try again.");
      } else {
        setFormError("Could not reach PulseOS. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-[520px] rounded-panel border border-line bg-white p-6 shadow-glass sm:p-8" data-testid="signup-success">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-100 text-accent-700">
            <Check size={22} aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-slate-900">Your PulseOS workspace is ready.</h1>
          <p className="mt-1.5 text-sm text-neutral-600">
            {done.name} is set up and you are signed in as its administrator.
            {done.template === "installed" && " Your department's services, fields and treatment catalogue are installed."}
            {done.template === "failed" && " We could not install the department template just now; you can add it from Settings."}
          </p>
          <button
            type="button"
            onClick={() => router.push("/command-centre")}
            className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-control bg-primary-600 px-3 text-sm font-semibold text-white transition hover:bg-primary-700"
            data-testid="signup-go-dashboard"
          >
            Go to Dashboard <ArrowRight size={16} aria-hidden="true" />
          </button>
          <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-neutral-500">When you are ready</p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {[
              { href: "/settings", label: "Configure your CRM" },
              { href: "/settings", label: "Invite staff" },
              { href: "/integrations", label: "Connect calling" },
              { href: "/integrations", label: "Connect WhatsApp" },
            ].map((l) => (
              <li key={l.label}>
                <Link href={l.href} className="flex min-h-11 items-center rounded-control border border-line px-3 text-sm text-neutral-700 transition hover:border-primary-300 hover:bg-primary-50/60 hover:text-primary-800">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-5 flex items-center justify-between">
          <PulseLockup tone="onWhite" size={30} />
          <Link href="/login" className="text-xs font-medium text-primary-700 hover:underline" data-testid="signup-signin-link">
            Already have an account? Sign in
          </Link>
        </div>

        <div className="rounded-panel border border-line bg-white p-6 shadow-glass sm:p-8" data-testid={`signup-step-${step}`}>
          <p className="text-xs font-medium text-neutral-500" data-testid="signup-progress">
            Step {step} of 5
          </p>
          <div className="mt-1.5 flex gap-1" aria-hidden="true">
            {STEPS.map((s) => (
              <span key={s.n} className={`h-1 flex-1 rounded-full ${s.n <= step ? "bg-primary-500" : "bg-primary-100"}`} />
            ))}
          </div>
          <h1 className="mt-4 text-xl font-semibold text-slate-900">{meta.title}</h1>
          <p className="mt-1 text-sm text-neutral-500">{meta.blurb}</p>

          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (step === 5) void submit();
              else next();
            }}
            noValidate
          >
            {step === 1 && (
              <>
                <TextField id="fullName" label="Full name" value={form.fullName} onChange={(v) => set("fullName", v)} error={errors.fullName} autoComplete="name" />
                <TextField id="email" label="Work email" type="email" value={form.email} onChange={(v) => set("email", v)} error={errors.email} autoComplete="email" inputMode="email" />
                <TextField id="phone" label="Phone" type="tel" value={form.phone} onChange={(v) => set("phone", v)} error={errors.phone} autoComplete="tel" inputMode="tel" hint="We use this only to reach you about your workspace." />
                <TextField
                  id="password"
                  label="Password"
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(v) => set("password", v)}
                  error={errors.password}
                  hint="At least 10 characters."
                  autoComplete="new-password"
                  right={
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-neutral-500 hover:text-neutral-700"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  }
                />
              </>
            )}

            {step === 2 && (
              <>
                <TextField id="organizationName" label="Hospital / organization name" value={form.organizationName} onChange={(v) => set("organizationName", v)} error={errors.organizationName} autoComplete="organization" />
                <ChoiceGroup label="Industry" value={form.industry} options={SIGNUP_INDUSTRIES} onChange={(v) => set("industry", v)} testId="signup-industry" />
                {form.industry === "Healthcare" && (
                  <>
                    <ChoiceGroup label="Organization type" value={form.organizationType} options={SIGNUP_ORGANIZATION_TYPES} onChange={(v) => set("organizationType", v)} error={errors.organizationType} testId="signup-orgtype" />
                    <div>
                      <ChoiceGroup label="Department / specialty" value={form.department} options={SIGNUP_DEPARTMENTS} onChange={(v) => set("department", v)} error={errors.department} testId="signup-department" />
                      {form.department && <p className="mt-1.5 text-xs text-neutral-500">{TEMPLATE_HINT[form.department]}</p>}
                    </div>
                  </>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <TextField id="addressLine" label="Address" value={form.addressLine} onChange={(v) => set("addressLine", v)} error={errors.addressLine} autoComplete="address-line1" />
                <TextField id="locality" label="Locality" optional value={form.locality} onChange={(v) => set("locality", v)} autoComplete="address-line2" />
                <div className="grid grid-cols-2 gap-3">
                  <TextField id="city" label="City" value={form.city} onChange={(v) => set("city", v)} error={errors.city} autoComplete="address-level2" />
                  <TextField id="state" label="State" value={form.state} onChange={(v) => set("state", v)} error={errors.state} autoComplete="address-level1" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextField id="pinCode" label="PIN code" value={form.pinCode} onChange={(v) => set("pinCode", v.replace(/\D/g, "").slice(0, 6))} error={errors.pinCode} inputMode="numeric" maxLength={6} autoComplete="postal-code" />
                  <TextField id="country" label="Country" value={form.country} onChange={(v) => set("country", v)} autoComplete="country-name" />
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <ChoiceGroup label="How did you hear about PulseOS?" value={form.discoverySource} options={SIGNUP_DISCOVERY_SOURCES} onChange={(v) => set("discoverySource", v)} error={errors.discoverySource} testId="signup-discovery" />
                {(form.discoverySource === "Referral" || form.discoverySource === "Event / Conference" || form.discoverySource === "Other") && (
                  <TextField
                    id="discoveryNotes"
                    label={form.discoverySource === "Referral" ? "Who referred you?" : form.discoverySource === "Event / Conference" ? "Which event?" : "Tell us more"}
                    optional
                    value={form.discoveryNotes}
                    onChange={(v) => set("discoveryNotes", v.slice(0, 300))}
                  />
                )}
              </>
            )}

            {step === 5 && (
              <>
                <div role="radiogroup" aria-label="Edition" className="grid gap-2" data-testid="signup-edition">
                  {EDITIONS.map((ed) => (
                    <button
                      key={ed.key}
                      type="button"
                      role="radio"
                      aria-checked={form.edition === ed.key}
                      onClick={() => set("edition", ed.key)}
                      className={`rounded-control border p-3.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 ${
                        form.edition === ed.key ? "border-primary-500 bg-primary-50" : "border-line-strong bg-white hover:border-primary-300"
                      }`}
                      data-testid={`signup-edition-${ed.key}`}
                    >
                      <span className="flex items-center justify-between text-sm font-semibold text-slate-900">
                        {ed.name}
                        {form.edition === ed.key && <Check size={16} className="text-primary-600" aria-hidden="true" />}
                      </span>
                      <span className="mt-0.5 block text-xs font-medium text-primary-700">{ed.line}</span>
                      <span className="mt-1 block text-xs text-neutral-600">{ed.detail}</span>
                    </button>
                  ))}
                </div>
                <dl className="rounded-control border border-line bg-primary-50/40 p-3 text-xs text-neutral-600" data-testid="signup-summary">
                  <div className="flex justify-between gap-3"><dt>Workspace</dt><dd className="font-medium text-slate-900">{form.organizationName}</dd></div>
                  {form.industry === "Healthcare" && <div className="mt-1 flex justify-between gap-3"><dt>Department</dt><dd className="font-medium text-slate-900">{form.department}</dd></div>}
                  <div className="mt-1 flex justify-between gap-3"><dt>Administrator</dt><dd className="font-medium text-slate-900">{form.email}</dd></div>
                </dl>
              </>
            )}

            {formError && (
              <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-xs text-danger-700" data-testid="signup-error">
                {formError}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              {step > 1 && (
                <button
                  type="button"
                  onClick={() => setStep((step - 1) as SignupStep)}
                  className="flex h-11 items-center gap-1.5 rounded-control border border-line-strong bg-white px-3.5 text-sm font-medium text-neutral-700 transition hover:border-primary-300"
                  data-testid="signup-back"
                >
                  <ArrowLeft size={15} aria-hidden="true" /> Back
                </button>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-control bg-primary-600 px-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:opacity-60"
                data-testid={step === 5 ? "signup-submit" : "signup-next"}
              >
                {step === 5 ? (submitting ? "Creating your workspace…" : "Create workspace") : (<>Continue <ArrowRight size={15} aria-hidden="true" /></>)}
              </button>
            </div>
          </form>
        </div>
        <p className="mt-5 text-center text-xs text-neutral-600">Your details create a new PulseOS workspace for your hospital.</p>
      </div>
    </main>
  );
}
