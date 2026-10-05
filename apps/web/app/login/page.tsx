"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@pulseos/api-client";
import type { DevEnvironment, Role } from "@pulseos/types";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { PulseLockup } from "@pulseos/ui";
import { ROLE_HOME } from "../../components/shell/nav";

// The operational loop PulseOS connects — descriptive only. No invented
// numbers or customer claims on this screen.
const JOURNEY_STEPS = ["Enquiry", "Appointment", "Consultation", "Treatment", "Follow-up"];

// Developer Access - development only. Entirely absent outside local development, not just hidden:
// /auth/dev-login/environments is a 404 (the route doesn't exist, see auth.routes.ts::devLoginEnabled) anywhere the env flag
// isn't explicitly on, so this renders nothing rather than an empty placeholder. The list comes from the database - the
// seeded demo hospitals plus every hospital that signed up in development - each with the roles that actually have an
// account, so a new sign-up appears here with no code change. Deliberately quiet: collapsed by default, secondary to the
// real Sign in button above it, never a competing CTA.
function DevLoginBlock() {
  const router = useRouter();
  const [environments, setEnvironments] = useState<DevEnvironment[] | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loggingInAs, setLoggingInAs] = useState<Role | null>(null);

  useEffect(() => {
    api
      .devLoginEnvironments()
      .then((e) => {
        setEnvironments(e);
        setEnvironment(e[0]?.key ?? null);
      })
      .catch(() => setEnvironments([]));
  }, []);

  if (!environments || environments.length === 0) return null;
  const current = environments.find((e) => e.key === environment) ?? environments[0]!;

  async function loginAs(role: Role) {
    setLoggingInAs(role);
    try {
      const { user } = await api.devLogin(role, current.key);
      router.push(ROLE_HOME[user.role]);
    } catch {
      setLoggingInAs(null);
    }
  }

  return (
    <div className="mt-6 border-t border-neutral-100 pt-4" data-testid="dev-login-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="dev-login-panel"
        className="flex min-h-11 w-full items-center justify-between rounded text-xs font-medium text-neutral-600 transition hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 lg:min-h-8"
        data-testid="dev-login-toggle"
      >
        <span>
          Developer access <span className="font-normal text-neutral-500">· development only</span>
        </span>
        <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id="dev-login-panel" className="mt-2 space-y-2">
          {environments.length > 1 && (
            <div role="group" aria-label="Demo environment" className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto" data-testid="dev-login-environments">
              {environments.map((e) => (
                <button
                  key={e.key}
                  type="button"
                  aria-pressed={current.key === e.key}
                  onClick={() => setEnvironment(e.key)}
                  className={`min-h-11 rounded-md border px-2 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 lg:min-h-8 ${
                    current.key === e.key
                      ? "border-primary-500 bg-primary-50 font-semibold text-primary-700"
                      : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
                  }`}
                  data-testid={`dev-login-env-${e.key}`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5" data-testid="dev-login-roles">
            {current.roles.map((r) => (
              <button
                key={r.role}
                type="button"
                onClick={() => loginAs(r.role)}
                disabled={loggingInAs !== null}
                aria-label={`${r.label}, ${current.label}`}
                aria-busy={loggingInAs === r.role}
                className="min-h-11 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-50 lg:min-h-8"
                data-testid={`dev-login-role-${r.role}`}
              >
                {loggingInAs === r.role ? "Signing in…" : r.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Off by default: a shared front-desk computer must not stay signed in unless the person chooses it.
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { user } = await api.login(email, password, remember);
      router.push(ROLE_HOME[user.role] ?? "/command-centre");
    } catch (err) {
      // The email stays as typed; focus goes where the user needs to act.
      if (err instanceof ApiError && err.status === 401) {
        setError("Incorrect email or password.");
        document.getElementById("password")?.focus();
      } else if (err instanceof ApiError) {
        // The API answered, so it is running — don't blame connectivity.
        setError("PulseOS couldn't sign you in right now. Please try again in a moment.");
      } else {
        setError("Could not reach PulseOS. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell flex min-h-screen">
      {/* Brand canvas — desktop only. Same blue family as the app sidebar. */}
      <div className="app-login-visual relative hidden w-[58%] overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12" data-testid="login-visual">
        {/* Quiet connective linework, low opacity: rings echo the mark's nodes. */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.10]" viewBox="0 0 800 900" fill="none" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <circle cx="700" cy="140" r="200" stroke="white" strokeWidth="1" />
          <circle cx="700" cy="140" r="300" stroke="white" strokeWidth="1" />
          <circle cx="700" cy="140" r="400" stroke="white" strokeWidth="1" />
        </svg>

        <div className="relative">
          <PulseLockup tone="onBlue" size={34} />
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-balance text-[36px] font-semibold leading-[1.12] tracking-tight text-white">Every patient, one continuous journey.</h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-primary-100">
            Know where every patient came from, what happened next, what needs attention, and what revenue was generated.
          </p>

          <ol className="relative mt-12 grid max-w-lg grid-cols-5" aria-label="The patient journey PulseOS connects">
            <span className="pointer-events-none absolute left-[10%] right-[10%] top-[7px] h-px bg-white/30" aria-hidden="true" />
            {JOURNEY_STEPS.map((step, i) => (
              <li key={step} className="relative flex flex-col items-center text-center">
                <span
                  className={`relative h-[15px] w-[15px] rounded-full ring-4 ring-primary-600 ${i === JOURNEY_STEPS.length - 1 ? "bg-accent-300" : "bg-white"}`}
                  aria-hidden="true"
                />
                <span className="mt-3 text-xs font-medium text-primary-100">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="relative text-xs text-primary-200">Patient engagement and revenue intelligence for hospitals.</p>
      </div>

      {/* Auth panel */}
      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-[400px]">
          <div className="mb-6 lg:hidden">
            <PulseLockup tone="onWhite" size={32} />
          </div>

          <div className="rounded-panel border border-line bg-white p-6 shadow-glass sm:p-8">
          <h2 className="text-xl font-semibold text-slate-900">Welcome back</h2>
          <p className="mt-1 text-sm text-neutral-500">Sign in to your PulseOS account</p>

          <form onSubmit={onSubmit} className="mt-7 space-y-4" data-testid="login-form">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-neutral-600">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-11 rounded-control border border-line-strong bg-white px-3.5 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25"
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-neutral-600">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full h-11 rounded-control border border-line-strong bg-white px-3.5 pr-11 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-neutral-500 hover:text-neutral-700"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <label className="flex min-h-11 items-start gap-2 text-xs text-neutral-600 lg:min-h-8">
              <input
                type="checkbox"
                data-testid="remember-me"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              />
              <span>
                Remember me
                <span className="block text-[11px] text-neutral-600">Stay signed in on this device for 7 days. Leave off on a shared computer.</span>
              </span>
            </label>

            {error && (
              <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-xs text-danger-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex h-11 w-full items-center justify-center rounded-control bg-primary-600 px-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:opacity-60"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="mt-6 border-t border-neutral-100 pt-5 text-center" data-testid="signup-prompt">
            <p className="text-sm text-neutral-600">New to PulseOS?</p>
            <Link
              href="/signup"
              className="mt-2 flex h-11 w-full items-center justify-center rounded-control border border-primary-200 bg-primary-50/60 px-3 text-sm font-semibold text-primary-700 transition hover:border-primary-300 hover:bg-primary-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
              data-testid="signup-link"
            >
              Create account
            </Link>
          </div>

          <DevLoginBlock />

          </div>

          <p className="mt-5 text-center text-xs text-neutral-600">Need help? Contact your administrator.</p>
        </div>
      </div>
    </main>
  );
}
