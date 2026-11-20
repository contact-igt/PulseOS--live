"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Building2, Check, Eye, EyeOff, KeyRound, Link2 } from "lucide-react";
import { ApiError, api } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";
import { ROLE_HOME } from "../../components/shell/nav";

const invitationSteps = [
  { title: "Open your invitation", detail: "Use the link sent to your hospital email.", icon: Link2 },
  { title: "Set your password", detail: "Create the password for your administrator account.", icon: KeyRound },
  { title: "Open your dashboard", detail: "Your dashboard opens when your hospital is ready.", icon: Building2 },
];

function PasswordField({ name, label, describedBy }: { name: string; label: string; describedBy?: string }) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return <div>
    <label htmlFor={name} className="block text-sm font-medium text-neutral-900">{label}</label>
    <div className="relative mt-1">
      <input id={name} name={name} type={visible ? "text" : "password"} autoComplete="new-password"
        required minLength={12} maxLength={128} aria-describedby={describedBy}
        className="block w-full rounded-control border border-neutral-300 bg-white py-3 pl-3.5 pr-11 text-base hover:border-primary-400" />
      <button type="button" onClick={() => setVisible(!visible)} aria-controls={name}
        aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-control text-neutral-600 hover:text-primary-700">
        <Icon size={16} aria-hidden="true" />
      </button>
    </div>
  </div>;
}

export default function HospitalInvitationPage() {
  const [token, setToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    // The fragment is available only after hydration. Retain it in memory when scrubbing the address.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken((current) => current ?? (/^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : ""));
    if (fragment) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submitting) return;
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("confirm-password")) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.redeemHospitalInvitation(token, password);
      if (result.signedIn) {
        window.location.replace(ROLE_HOME.SUPER_ADMIN);
        return;
      }
      setAccepted(true);
      setToken("");
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 400
        ? "This invitation or password could not be accepted. Use a password different from your email, or request a fresh invitation."
        : "PulseOS could not accept your invitation right now. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const currentStep = accepted ? 2 : token ? 1 : 0;

  return (
    <main className="app-shell grid min-h-dvh place-items-center px-4 py-8 sm:px-8">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-shell border border-primary-100 bg-white shadow-xl shadow-primary-900/10 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <aside className="bg-gradient-to-br from-primary-900 via-primary-800 to-primary-600 p-6 text-white sm:p-8 lg:p-10">
          <PulseLockup tone="onBlue" size={32} showBeta={false} />
          <ol aria-label="Hospital invitation progress" className="mt-6 space-y-2.5 md:mt-10">
            {invitationSteps.map(({ title, detail, icon }, index) => {
              const complete = index < currentStep;
              const current = index === currentStep;
              const Icon = complete ? Check : icon;
              return <li key={title} aria-current={current ? "step" : undefined}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 md:p-3 ${current ? "border-white/40 bg-white/15" : "border-transparent"}`}>
                <span className={`grid size-9 shrink-0 place-items-center rounded-control ${current ? "bg-white text-primary-800" : "bg-white/10 text-primary-50"}`}>
                  <Icon size={18} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{accepted && current ? "Await hospital activation" : title}{complete && <span className="sr-only"> (completed)</span>}</p>
                  <p className="mt-0.5 hidden text-xs leading-relaxed text-primary-50 md:block">{detail}</p>
                </div>
              </li>;
            })}
          </ol>
        </aside>
        <section className="flex flex-col justify-center px-6 py-8 sm:px-10 lg:p-12">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">{accepted ? "Invitation accepted" : "Hospital administrator invitation"}</h1>
        {accepted ? (
          <>
            <p role="status" className="mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900">
              <Check size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              Your password is set. You can sign in after the PulseOS team activates your hospital.
            </p>
            <Link href="/login" className="mt-5 inline-flex w-fit items-center gap-2 text-sm font-semibold text-primary-700">Go to sign in <ArrowRight size={16} aria-hidden="true" /></Link>
          </>
        ) : token ? (
          <form onSubmit={accept} className="mt-6 space-y-4">
            <PasswordField name="password" label="New password" describedBy="password-requirements" />
            <p id="password-requirements" className="text-sm text-neutral-600">Use at least 12 characters and a password different from your email.</p>
            <PasswordField name="confirm-password" label="Confirm password" />
            {error && <p role="alert" className="rounded-control border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">{error}</p>}
            <button type="submit" disabled={submitting} className="inline-flex w-full items-center justify-center gap-2 rounded-control bg-primary-700 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-800 disabled:opacity-60">
              {submitting ? "Accepting invitation…" : "Accept invitation"}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </form>
        ) : token === "" ? (
          <p className="mt-3 text-sm text-neutral-600">Open the original invitation link from the PulseOS team to set your password.</p>
        ) : <p role="status" className="mt-3 text-sm text-neutral-600">Checking your invitation…</p>}
        </section>
      </div>
    </main>
  );
}
