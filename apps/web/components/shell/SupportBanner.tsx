"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LifeBuoy } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import type { SessionUser } from "@pulseos/types";

function remaining(iso: string, now: number): string {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/**
 * Support Mode banner. Always visible while PulseOS platform staff are viewing this hospital: it names the hospital and the
 * staff member, says whether edits are possible, and how long the session has left. It cannot be dismissed.
 */
export function SupportBanner({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient();
  const s = user.support!;
  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function end() {
    setEnding(true);
    try {
      await platformApi.endSupport(s.sessionId);
    } finally {
      queryClient.clear();
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load resets the app's session state when entering or leaving Support Mode
      window.location.assign("/platform/support");
    }
  }

  return (
    <div role="status" aria-live="polite" className={`z-(--z-sticky) flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 text-xs text-white ${s.writeEnabled ? "bg-warning-700" : "bg-primary-700"}`} data-testid="support-banner">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <LifeBuoy size={15} aria-hidden="true" className="shrink-0" />
        <span className="font-semibold">Support Mode — {user.tenantName}</span>
        <span className="basis-full pl-[23px] opacity-90 sm:basis-auto sm:pl-0" data-testid="support-banner-detail">
          {s.staffName} (PulseOS) · {s.writeEnabled ? `EDITS ENABLED, ${remaining(s.writeExpiresAt!, now)} left` : "read-only"} · ends in {remaining(s.expiresAt, now)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <a href="/platform/support" className="flex min-h-9 items-center rounded-control px-2 font-medium underline-offset-2 hover:underline">
          Console
        </a>
        <button type="button" onClick={end} disabled={ending} className="flex min-h-9 items-center rounded-control bg-white/15 px-2.5 font-semibold hover:bg-white/25 disabled:opacity-60" data-testid="end-support">
          {ending ? "Ending…" : "End support session"}
        </button>
      </span>
    </div>
  );
}
