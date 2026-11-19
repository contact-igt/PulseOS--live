"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { ApiError, platformApi } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";
import { ArrowRight } from "lucide-react";
import hospitalOperations from "./hospital-operations.png";

const input = "mt-1.5 w-full rounded-control border border-neutral-300 bg-white px-3.5 py-3 text-base text-neutral-900 hover:border-primary-400";
const button = "inline-flex w-full items-center justify-center gap-2 rounded-control bg-primary-700 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-800 disabled:opacity-60";

export default function PlatformLogin() {
  const [mode, setMode] = useState<"login" | "enroll" | "verify">("login");
  const [setup, setSetup] = useState<{ email: string; setupKey: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    function showForm() {
      if (!active) return;
      const entry = new URLSearchParams(window.location.search).get("mode");
      setMode(entry === "setup" ? "enroll" : "login");
      setUseCode(entry === "authenticator");
      setCheckingSession(false);
    }
    platformApi.me().then(
      (account) => {
        if (!active) return;
        if (account) window.location.replace("/platform");
        else showForm();
      },
      showForm,
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
    <main className="app-shell grid min-h-dvh place-items-center px-4 py-8 sm:px-8">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-shell border border-primary-100 bg-white shadow-xl shadow-primary-900/10 md:grid-cols-[0.95fr_1.05fr]">
        <div className="flex flex-col justify-between gap-4 bg-gradient-to-br from-primary-900 via-primary-800 to-primary-600 px-6 py-6 text-white sm:px-10 md:p-10">
          <PulseLockup tone="onBlue" size={32} showBeta={false} />
          <Image src={hospitalOperations} alt="" sizes="(min-width: 768px) 300px, 1px"
            className="mx-auto hidden h-auto w-full max-w-[300px] md:block" />
          <div className="hidden md:block">
            <p className="text-3xl font-semibold tracking-tight">Platform administration</p>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-primary-100">Manage hospital onboarding, administrator access, and platform operations.</p>
          </div>
        </div>
        <section className="px-6 py-8 sm:px-10 md:p-12">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">{mode === "login" ? "Platform sign in" : "Set up platform access"}</h1>
        {checkingSession ? <p role="status" className="mt-4 text-sm text-neutral-600">Checking your session…</p> : <>
        {setup && mode === "verify" && (
          <div className="mt-4 space-y-2 text-sm">
            <p>Add a time-based account in your authenticator app for {setup.email}. Enter this setup key, then enter its six-digit code below.</p>
            <code className="block break-all rounded-control bg-neutral-100 p-3">{setup.setupKey}</code>
          </div>
        )}
        <form key={mode} onSubmit={submit} className="mt-7 space-y-5">
          {mode === "login" && <label className="block text-sm">Platform email<input className={input} type="email" name="email" autoComplete="username" required /></label>}
          {mode === "enroll" && <>
            <label className="block text-sm">One-time setup token<input className={input} type="password" name="invitation" autoComplete="off" required /></label>
            <p className="text-sm text-neutral-600">For recovery, enter your current Platform password. For initial setup, choose a new password.</p>
          </>}
          {mode !== "verify" && <label className="block text-sm">Password<input className={input} type="password" name="password" autoComplete={mode === "enroll" ? "new-password" : "current-password"} minLength={mode === "enroll" ? 15 : undefined} maxLength={128} required /></label>}
          {(mode === "verify" || (mode === "login" && useCode)) && <label className="block text-sm">Authenticator code<input className={input} type="text" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>}
          {error && <p className="rounded-control border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800" role="alert">{error}</p>}
          <button type="submit" disabled={working} className={button}>
            {mode === "login" ? "Sign in" : mode === "enroll" ? "Continue to MFA setup" : "Verify and sign in"}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </form>
        {(mode !== "login" || useCode) && <button type="button" disabled={working}
          onClick={() => window.location.assign("/platform/login")}
          className="mt-4 text-sm font-semibold text-primary-700">Back to sign in</button>}
        </>}
        </section>
      </div>
    </main>
  );
}
