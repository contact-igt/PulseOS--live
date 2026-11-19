"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, platformApi } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";

const input = "mt-1 w-full rounded-control border border-neutral-300 px-3 py-2";
const button = "rounded-control bg-primary-700 px-4 py-2 font-semibold text-white disabled:opacity-60";

export default function PlatformLogin() {
  const [mode, setMode] = useState<"login" | "enroll" | "verify">("login");
  const [setup, setSetup] = useState<{ email: string; setupKey: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    platformApi.me().then(
      (account) => {
        if (!active) return;
        if (account) window.location.replace("/platform");
        else setCheckingSession(false);
      },
      () => {
        if (active) setCheckingSession(false);
      },
    );
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (field: string) => String(data.get(field) ?? "");
    setError("");
    setWorking(true);
    try {
      if (mode === "enroll") {
        const result = await platformApi.enroll({ invitation: read("invitation").trim(), password: read("password") });
        setSetup(result);
        setMode("verify");
        return;
      }
      if (mode === "verify") await platformApi.verifyEnrollment(read("code"));
      else await platformApi.login({ email: read("email"), password: read("password"), ...(useCode ? { code: read("code") } : {}) });
      window.location.replace("/platform");
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 429 ? "Too many attempts. Wait before trying again."
        : failure instanceof ApiError && failure.status < 500 ? "The credentials or authenticator code could not be verified."
        : "Platform authentication is temporarily unavailable.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-neutral-50 p-4">
      <section className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <PulseLockup tone="onWhite" size={32} />
        <h1 className="mt-6 text-2xl font-semibold">{mode === "login" ? "Platform sign in" : "Set up platform access"}</h1>
        {checkingSession ? <p role="status" className="mt-4 text-sm text-neutral-600">Checking your session…</p> : <>
        {setup && mode === "verify" && (
          <div className="mt-4 space-y-2 text-sm">
            <p>Add a time-based account in your authenticator app for {setup.email}. Enter this setup key, then enter its six-digit code below.</p>
            <code className="block break-all rounded-control bg-neutral-100 p-3">{setup.setupKey}</code>
          </div>
        )}
        <form key={mode} onSubmit={submit} className="mt-5 space-y-4">
          {mode === "login" && <label className="block text-sm">Platform email<input className={input} type="email" name="email" autoComplete="username" required /></label>}
          {mode === "enroll" && <>
            <label className="block text-sm">One-time setup token<input className={input} type="password" name="invitation" autoComplete="off" required /></label>
            <p className="text-sm text-neutral-600">For recovery, enter your current Platform password. For initial setup, choose a new password.</p>
          </>}
          {mode !== "verify" && <label className="block text-sm">Password<input className={input} type="password" name="password" autoComplete={mode === "enroll" ? "new-password" : "current-password"} minLength={mode === "enroll" ? 15 : undefined} maxLength={128} required /></label>}
          {(mode === "verify" || (mode === "login" && useCode)) && <label className="block text-sm">Authenticator code<input className={input} type="text" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>}
          {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
          <button type="submit" disabled={working} className={button}>{mode === "login" ? "Sign in" : mode === "enroll" ? "Continue to MFA setup" : "Verify and sign in"}</button>
        </form>
        {mode === "login" && <button type="button" disabled={working} aria-expanded={useCode}
          onClick={() => { setUseCode(!useCode); setError(""); }} className="mr-4 mt-4 text-sm font-semibold text-primary-700">
          {useCode ? "Hide authenticator code" : "Use an authenticator code"}
        </button>}
        <button type="button" disabled={working} onClick={() => { setMode(mode === "login" ? "enroll" : "login"); setSetup(null); setError(""); }} className="mt-4 text-sm font-semibold text-primary-700">
          {mode === "login" ? "Use a setup token" : "Back to sign in"}
        </button>
        </>}
      </section>
    </main>
  );
}
