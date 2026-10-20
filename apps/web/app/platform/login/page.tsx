"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { PulseLockup } from "@pulseos/ui";
import { platformApi, ApiError } from "@pulseos/api-client";

/** Only a plain /platform path is ever followed after sign-in. */
function safePlatformReturn(raw: string | null): string {
  if (!raw || raw.length > 256 || !raw.startsWith("/platform") || raw.startsWith("/platform/login") || raw.includes("//") || raw.includes("\\")) return "/platform";
  return raw;
}

function PlatformLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { user } = await platformApi.login(email, password);
      queryClient.setQueryData(["platform-session"], { user });
      router.replace(safePlatformReturn(params.get("from")));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Identical for an unknown email, a wrong password and an account without platform access.
        setError("Incorrect email or password, or this account has no platform access.");
        document.getElementById("platform-password")?.focus();
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many sign-in attempts. Please wait a few minutes and try again.");
      } else if (err instanceof ApiError) {
        setError("The Platform Console couldn't sign you in right now. Please try again.");
      } else {
        setError("Could not reach PulseOS. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="platform-login-form">
      <div className="space-y-1">
        <label htmlFor="platform-email" className="block text-xs font-medium text-ink">
          Work email
        </label>
        <input id="platform-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25" />
      </div>
      <div className="space-y-1">
        <label htmlFor="platform-password" className="block text-xs font-medium text-ink">
          Password
        </label>
        <div className="relative">
          <input id="platform-password" type={show ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 w-full rounded-control border border-line-strong bg-surface px-3 pr-12 text-sm text-ink outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25" />
          <button type="button" onClick={() => setShow((v) => !v)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-neutral-500 hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-control bg-danger-100/60 px-3 py-2 text-xs text-danger-700" data-testid="platform-login-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={loading || !email || !password} className="flex h-11 w-full items-center justify-center rounded-control bg-primary-600 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:opacity-50" data-testid="platform-login-submit">
        {loading ? "Signing in…" : "Sign in to Platform Console"}
      </button>
    </form>
  );
}

/**
 * The company-side sign-in. Deliberately separate from every hospital sign-in page: no hospital branding, no Developer Access,
 * no demo shortcuts. A hospital account (any tenant role, Super Admin included) is refused here.
 */
export default function PlatformLoginPage() {
  return (
    <main className="app-shell flex min-h-dvh items-center justify-center p-4" data-testid="platform-login">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-1 text-center">
          <PulseLockup tone="onWhite" size={30} betaLabel="Platform" />
          <p className="text-xs text-ink-2">by Invictus Global Tech</p>
        </div>
        <div className="rounded-panel border border-line surface-content p-6 shadow-panel">
          <div className="mb-5 flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-primary-100 text-primary-700">
              <ShieldCheck size={17} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-base font-semibold text-ink">Platform Console</h1>
              <p className="text-xs text-ink-2">For PulseOS staff only. Hospital teams sign in at their own hospital page.</p>
            </div>
          </div>
          <Suspense fallback={null}>
            <PlatformLoginForm />
          </Suspense>
        </div>
        <p className="mt-4 text-center text-[11px] text-ink-2">Every sign-in and action in this console is recorded.</p>
      </div>
    </main>
  );
}
