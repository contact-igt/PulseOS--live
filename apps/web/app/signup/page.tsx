import Link from "next/link";
import { PulseLockup } from "@pulseos/ui";

export default function HospitalOnboardingInfoPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-neutral-50 px-4 py-10">
      <section className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <PulseLockup tone="onWhite" size={32} />
        <h1 className="mt-6 text-2xl font-semibold text-neutral-900">Get PulseOS for your hospital</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600">
          The PulseOS team sets up each hospital workspace. Contact your PulseOS representative to get started.
          If your hospital already uses PulseOS, ask your hospital administrator for sign-in access.
        </p>
        <Link href="/login" className="mt-6 inline-flex rounded-control bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">
          Back to sign in
        </Link>
      </section>
    </main>
  );
}
