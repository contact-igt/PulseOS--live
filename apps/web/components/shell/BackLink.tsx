"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";

// Every place a list page links into a detail page should append
// `?from=<key>` to that link so BackLink can send the user back to where
// they actually came from — see FROM_ROUTES below for the accepted keys.
const FROM_ROUTES: Record<string, { href: string; label: string }> = {
  patients: { href: "/patients", label: "Back to Patients" },
  leads: { href: "/leads", label: "Back to Leads" },
  journeys: { href: "/journeys", label: "Back to Journeys" },
  treatments: { href: "/treatments", label: "Back to Treatments" },
  appointments: { href: "/appointments", label: "Back to Appointments" },
  "command-centre": { href: "/command-centre", label: "Back to Command Centre" },
  inbox: { href: "/inbox", label: "Back to Inbox" },
  "my-work": { href: "/my-work", label: "Back to My Work" },
  "doctor-home": { href: "/doctor-home", label: "Back to Doctor Home" },
  campaigns: { href: "/campaigns", label: "Back to Campaigns" },
  settings: { href: "/settings", label: "Back to Settings" },
};

/** The route a `?from=` key stands for, or the fallback. Own keys only: `constructor`/`__proto__` are not routes. */
export function resolveBackTarget(from: string | null, fallback: { href: string; label: string }): { href: string; label: string } {
  return from && Object.hasOwn(FROM_ROUTES, from) ? FROM_ROUTES[from]! : fallback;
}

/**
 * Small ghost Back control for a detail/drilldown page's header — never a
 * dead control: always resolves to a real route, either the caller's
 * explicit `fallback`/`fallbackLabel`, or a same-origin route inferred from
 * the `?from=` query param a list page's row-click link set, or (when
 * neither is available) `fallback`'s own default. Deliberately a plain
 * <Link>, not router.back() — a freshly-opened tab or a direct URL visit
 * has no browser history to go back to, which would otherwise silently do
 * nothing.
 */
export function BackLink({ fallback, fallbackLabel }: { fallback: string; fallbackLabel: string }) {
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const resolved = resolveBackTarget(from, { href: fallback, label: fallbackLabel });

  return (
    <Link
      href={resolved.href}
      className="mb-1 inline-flex w-fit items-center gap-0.5 text-xs font-medium text-neutral-600 transition hover:text-primary-700"
    >
      <ChevronLeft size={14} />
      {resolved.label}
    </Link>
  );
}

/** Appends the current page's `from` key onto a detail-page href, e.g. buildDetailHref(`/patients/${id}`, "leads"). */
export function withFrom(href: string, fromKey: keyof typeof FROM_ROUTES): string {
  return `${href}${href.includes("?") ? "&" : "?"}from=${fromKey}`;
}

/**
 * A link from one detail page to another keeps the list the person originally came from (Leads > Patient > Cataract stays
 * rooted at Leads), and only falls back to `fallbackKey` when this page was opened directly. Own keys only.
 */
export function carryFrom(href: string, from: string | null, fallbackKey: keyof typeof FROM_ROUTES): string {
  return withFrom(href, from && Object.hasOwn(FROM_ROUTES, from) ? from : fallbackKey);
}
