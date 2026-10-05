"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@pulseos/api-client";
import { PulseMark, getDisplayTimeZone, setDisplayTimeZone } from "@pulseos/ui";
import { Sidebar } from "../../components/shell/Sidebar";
import { TopBar } from "../../components/shell/TopBar";
import { QuickCreateProvider } from "../../components/shell/QuickCreateProvider";
import { ListContextRecorder } from "../../components/shell/Breadcrumb";
import { rememberLoginPage, rememberedLoginPath } from "../../lib/loginPage";
import { pathAllowedForRole, ROLE_HOME } from "../../components/shell/nav";

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  "/command-centre": { title: "Command Centre", subtitle: "Hospital engagement operation at a glance" },
  "/my-work": { title: "My Work", subtitle: "Tasks, callbacks and follow-ups assigned to you" },
  "/journeys": { title: "Journeys", subtitle: "The operational surface behind the Command Centre's numbers" },
  "/patients": { title: "Patients", subtitle: "Every patient across every journey" },
  "/front-desk": { title: "Front Desk", subtitle: "Today's arrivals, waiting queue and confirmations" },
  "/appointments": { title: "Appointments", subtitle: "Every appointment, every state" },
  "/treatments": { title: "Treatments", subtitle: "Operational conversion tracking, not an EMR" },
  "/inbox": { title: "Inbox", subtitle: "Every patient conversation, one queue" },
  "/integrations": { title: "Integrations", subtitle: "Connected providers and their health" },
  "/leads": { title: "Leads", subtitle: "Track every enquiry from source to appointment" },
  "/campaigns": { title: "Campaigns / Sources", subtitle: "Where spend turns into treatment revenue" },
  "/analytics": { title: "Analytics", subtitle: "Historical trends, comparisons and drill-downs" },
  "/settings": { title: "Settings", subtitle: "CRM configuration: services, fields, outcomes and messaging" },
};

function greeting() {
  // The hospital's hour, not the browser's.
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: getDisplayTimeZone(), hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function doctorGreetingName(name: string) {
  const parts = name.split(" ");
  return parts[0] === "Dr." ? `${parts[0]} ${parts[1]}` : parts[0];
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data, isLoading, isError } = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);

  useEffect(() => {
    if (isError) router.replace(rememberedLoginPath());
  }, [isError, router]);
  // Remember the hospital's own sign-in page, so an expired session returns there and not to the general page.
  const loginSlug = data?.user.loginSlug;
  useEffect(() => {
    if (data) rememberLoginPage(loginSlug);
  }, [data, loginSlug]);

  // The hospital's interface style (Settings > Appearance) comes from the server with the session; it is applied as a data
  // attribute that selects one of three bounded sets of surface tokens (see globals.css). Nothing is kept in the browser:
  // another hospital signing in on the same machine gets its own.
  const surfaceStyle = data?.user.surfaceStyle;
  useEffect(() => {
    document.documentElement.dataset.surface = surfaceStyle ?? "balanced";
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, [surfaceStyle]);

  // THIS person's own readability choices (Display settings) also come with the session and are applied as two data attributes
  // that select bounded token sets (see globals.css). They are personal: another person on the same machine gets their own.
  const interfaceSize = data?.user.interfaceSize;
  const textSize = data?.user.textSize;
  useEffect(() => {
    document.documentElement.dataset.uiSize = interfaceSize ?? "comfortable";
    document.documentElement.dataset.textSize = textSize ?? "default";
    return () => {
      delete document.documentElement.dataset.uiSize;
      delete document.documentElement.dataset.textSize;
    };
  }, [interfaceSize, textSize]);

  // A role's sidebar only ever links to pages it's meant to use (see nav.ts)
  // — but nothing previously stopped a direct URL, stale bookmark, or back
  // button from landing a role on a page outside that set. The API already
  // correctly rejects those requests (401/403 per-endpoint), so this was
  // never a security gap, but the result was a broken-looking page of
  // per-panel "Could not load" errors instead of a normal redirect home.
  const role = data?.user.role;
  const edition = data?.user.capabilities;
  const allowed = role ? pathAllowedForRole(role, pathname, edition) : true;
  useEffect(() => {
    if (role && !allowed) router.replace(ROLE_HOME[role]);
  }, [role, allowed, router]);

  // Close the mobile drawer on navigation without an effect (React's
  // recommended "adjust state during render" pattern for prop-driven resets).
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setMobileNavOpen(false);
  }

  if (isLoading) {
    return (
      <div className="app-shell flex h-screen flex-col items-center justify-center gap-3 text-sm text-ink-2">
        <PulseMark size={36} />
        <span>Loading PulseOS…</span>
      </div>
    );
  }

  if (!data) return null;

  // Every date/time in the app is shown in the hospital's zone (tenants.timezone). Set before any page renders;
  // idempotent, so doing it during render is safe.
  setDisplayTimeZone(data.user.timezone);

  // Redirecting away (effect above) — render nothing rather than the
  // requested page, so its data hooks never fire the doomed requests.
  if (!allowed) return null;

  const meta =
    pathname === "/doctor-home"
      ? { title: `${greeting()}, ${doctorGreetingName(data.user.name)}`, subtitle: "Here's your schedule for today" }
      : (PAGE_META[pathname] ??
        (pathname.startsWith("/patients/")
          ? { title: "Patient 360", subtitle: "Full journey context for one patient" }
          : pathname.startsWith("/journeys/")
            ? { title: "Journey", subtitle: data.user.capabilities.REVENUE_TRACKING ? "One enquiry from source to treatment and revenue" : "One enquiry from source to treatment" }
          : pathname.startsWith("/campaigns/")
            ? { title: "Campaign Detail", subtitle: "Spend, attribution and outcomes for one campaign" }
            : { title: "PulseOS", subtitle: undefined }));

  return (
    <QuickCreateProvider role={data.user.role}>
      {/* Ambient layered-gradient environment (.app-shell) behind a floating glass
          nav rail + glass top bar. The TopBar is absolutely positioned over the
          scrolling <main>, so content passes beneath the glass. */}
      <div className="app-shell flex h-dvh overflow-hidden">
        <ListContextRecorder />
        <Sidebar user={data.user} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <TopBar user={data.user} title={meta.title} subtitle={meta.subtitle} onMenuClick={() => setMobileNavOpen((v) => !v)} />
          <main className="flex-1 overflow-x-hidden overflow-y-auto p-4 pt-20 lg:p-6 lg:pl-3 lg:pt-[6.25rem]">{children}</main>
        </div>
      </div>
    </QuickCreateProvider>
  );
}
