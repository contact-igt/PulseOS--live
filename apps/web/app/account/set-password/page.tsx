"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { accountApi, ApiError } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";

type Info = Awaited<ReturnType<typeof accountApi.inspect>>;

/**
 * Accept an invitation or finish a password reset. The token is in the URL FRAGMENT (#token=…), which browsers never send to
 * any server; it is read here, removed from the address bar, and sent only in a request body. No password is ever chosen by,
 * or shown to, anyone but the person themself.
 */
export default function SetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "invalid" | "ready" | "done">("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [signInPath, setSignInPath] = useState("/login");

  useEffect(() => {
    function load() {
      const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
      if (!t) {
        // Nothing new in the address (e.g. the token was already read and removed): keep what is on screen.
        setState((s) => (s === "loading" ? "invalid" : s));
        return;
      }
      // Keep the token out of history and out of anything that later copies the address.
      window.history.replaceState(null, "", window.location.pathname);
      setToken(t);
      setState("loading");
      setPassword("");
      setConfirm("");
      setError(null);
      accountApi
        .inspect(t)
        .then((i) => {
          setInfo(i);
          setState("ready");
        })
        .catch(() => setState("invalid"));
    }
    load();
    // A second link opened in this same tab only changes the fragment, which does not reload the page.
    window.addEventListener("hashchange", load);
    return () => window.removeEventListener("hashchange", load);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== confirm) return setError("The two passwords do not match.");
    setSaving(true);
    try {
      const r = await accountApi.accept(token!, password);
      setSignInPath(r.signInPath);
      setState("done");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.issues.length) setError(err.issues.map((i) => i.message).join(" "));
      else if (err instanceof ApiError && err.message === "invalid_token") setState("invalid");
      else if (err instanceof ApiError && err.message === "workspace_unavailable") setError("This workspace is not available right now. Please contact your PulseOS administrator.");
      else if (err instanceof ApiError && err.message === "account_unavailable") setError("This account is not available. Please contact your administrator.");
      else setError("Could not save your password. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell flex min-h-dvh items-center justify-center p-4" data-testid="set-password">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <PulseLockup tone="onWhite" size={28} showBeta={false} />
        </div>
        <div className="rounded-panel border border-line surface-content p-6 shadow-panel">
          {state === "loading" && <p className="text-sm text-ink-2">Checking your link…</p>}
          {state === "invalid" && (
            <div role="alert" data-testid="set-password-invalid">
              <h1 className="text-base font-semibold text-ink">This link can&apos;t be used</h1>
              <p className="mt-1 text-sm text-ink-2">It may have expired, been used already, or been replaced by a newer link. Ask your administrator to send a new one.</p>
            </div>
          )}
          {state === "ready" && info && (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div>
                <h1 className="text-base font-semibold text-ink">{info.purpose === "INVITE" ? `Welcome, ${info.name}` : "Choose a new password"}</h1>
                <p className="mt-1 text-sm text-ink-2">
                  {info.purpose === "INVITE" ? "Set your password to join " : "For your account at "}
                  <span className="font-medium text-ink">{info.workspace ?? "the PulseOS Platform Console"}</span> ({info.email}).
                </p>
              </div>
              <div className="space-y-1">
                <label htmlFor="new-password" className="block text-xs font-medium text-ink">
                  New password
                </label>
                <div className="relative">
                  <input id="new-password" type={show ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 w-full rounded-control border border-line-strong bg-surface px-3 pr-12 text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25" />
                  <button type="button" onClick={() => setShow((v) => !v)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-neutral-500" aria-label={show ? "Hide password" : "Show password"}>
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="text-[11px] text-ink-2">At least 10 characters, and not your email.</p>
              </div>
              <div className="space-y-1">
                <label htmlFor="confirm-password" className="block text-xs font-medium text-ink">
                  Confirm password
                </label>
                <input id="confirm-password" type={show ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25" />
              </div>
              {error && (
                <p role="alert" className="rounded-control bg-danger-100/60 px-3 py-2 text-xs text-danger-700">
                  {error}
                </p>
              )}
              <button type="submit" disabled={saving} className="flex h-11 w-full items-center justify-center rounded-control bg-primary-600 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" data-testid="set-password-submit">
                {saving ? "Saving…" : "Save password"}
              </button>
            </form>
          )}
          {state === "done" && (
            <div role="status" data-testid="set-password-done">
              <h1 className="text-base font-semibold text-ink">Password saved</h1>
              <p className="mt-1 text-sm text-ink-2">You can sign in now.</p>
              <Link href={signInPath} className="mt-4 flex h-11 items-center justify-center rounded-control bg-primary-600 text-sm font-semibold text-white hover:bg-primary-700">
                Go to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
