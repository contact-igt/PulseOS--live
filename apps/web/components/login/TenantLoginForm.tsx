"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@pulseos/api-client";
import { Eye, EyeOff } from "lucide-react";
import { ROLE_HOME } from "../shell/nav";

/**
 * The interactive part of the tenant sign-in: email, password, Remember me, Sign in. The hospital is fixed by the page's address on
 * the server (the slug is all that is sent); nothing here can name another hospital. Remember me is the same two-state rule as
 * everywhere: ON = a 7-day server session, OFF = the standard session; no token is ever kept in browser storage.
 */
export function TenantLoginForm({ slug }: { slug: string }) {
  const router = useRouter();
  const ids = { email: useId(), password: useId(), error: useId(), remember: useId() };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { user } = await api.tenantLogin(slug, email, password, remember);
      router.push(ROLE_HOME[user.role] ?? "/command-centre");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Incorrect email or password.");
        document.getElementById(ids.password)?.focus();
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many sign-in attempts. Please wait a few minutes and try again.");
      } else if (err instanceof ApiError) {
        setError("PulseOS couldn't sign you in right now. Please try again in a moment.");
      } else {
        setError("Could not reach PulseOS. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  const field = "h-11 w-full rounded-control border border-line-strong bg-white px-3.5 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25 focus-visible:ring-2 focus-visible:ring-primary-500/40";
  const described = error ? ids.error : undefined;

  return (
    <form onSubmit={onSubmit} className="mt-7 space-y-4" data-testid="login-form" noValidate={false}>
      <div>
        <label htmlFor={ids.email} className="mb-1.5 block text-xs font-medium text-neutral-700">Email address</label>
        <input id={ids.email} name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} autoComplete="email" aria-invalid={error ? true : undefined} aria-describedby={described} />
      </div>
      <div>
        <label htmlFor={ids.password} className="mb-1.5 block text-xs font-medium text-neutral-700">Password</label>
        <div className="relative">
          <input id={ids.password} name="password" type={showPassword ? "text" : "password"} required value={password} onChange={(e) => setPassword(e.target.value)} className={`${field} pr-12`} autoComplete="current-password" aria-invalid={error ? true : undefined} aria-describedby={described} />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-neutral-600 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary-500"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
          >
            {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="flex min-h-11 items-start gap-2 text-xs text-neutral-700 lg:min-h-8">
        <input id={ids.remember} type="checkbox" data-testid="remember-me" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 rounded border-neutral-400 text-primary-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500" aria-describedby={`${ids.remember}-hint`} />
        <label htmlFor={ids.remember} className="cursor-pointer">
          Remember me
          <span id={`${ids.remember}-hint`} className="block text-[11px] text-neutral-600">Stay signed in on this device for 7 days. Leave off on a shared computer.</span>
        </label>
      </div>

      {error && (
        <p id={ids.error} role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-xs text-danger-700">
          {error}
        </p>
      )}

      <button type="submit" disabled={loading} className="flex h-11 w-full items-center justify-center rounded-control bg-primary-600 px-3 text-sm font-semibold text-white transition hover:bg-primary-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-60">
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
