"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError, api } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";

export default function HospitalInvitationPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
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
    setSubmitting(true);
    try {
      await api.redeemHospitalInvitation(token, password);
      setAccepted(true);
      setToken("");
      setPassword("");
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 400
        ? "This invitation or password could not be accepted. Use a password different from your email, or request a fresh invitation."
        : "PulseOS could not accept your invitation right now. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-neutral-50 px-4 py-10">
      <section className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <PulseLockup tone="onWhite" size={32} />
        <h1 className="mt-6 text-2xl font-semibold text-neutral-900">Hospital administrator invitation</h1>
        {accepted ? (
          <>
            <p role="status" className="mt-3 text-sm text-neutral-600">
              Your password is set. You can sign in after the PulseOS team activates your hospital.
            </p>
            <Link href="/login" className="mt-4 inline-block text-sm font-semibold text-primary-700">Go to sign in</Link>
          </>
        ) : token ? (
          <form onSubmit={accept} className="mt-5 space-y-4">
            <label className="block text-sm font-medium text-neutral-900">
              New password
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby="password-requirements"
                className="mt-1 block w-full rounded-control border border-neutral-300 px-3 py-2"
              />
            </label>
            <p id="password-requirements" className="text-sm text-neutral-600">Use at least 12 characters and a password different from your email.</p>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={submitting} className="rounded-control bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60">
              {submitting ? "Accepting invitation…" : "Accept invitation"}
            </button>
          </form>
        ) : token === "" ? (
          <p className="mt-3 text-sm text-neutral-600">Open the original invitation link from the PulseOS team to set your password.</p>
        ) : null}
      </section>
    </main>
  );
}
