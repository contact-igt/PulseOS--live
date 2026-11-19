"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ApiError, platformApi } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";
import { Failure, Loading, secondaryClass, usePlatformAccount } from "./platform-ui";

export default function PlatformConsole({ children }: { children: React.ReactNode }) {
  const account = usePlatformAccount();
  const path = usePathname();
  const [logoutError, setLogoutError] = useState<unknown>();
  const [working, setWorking] = useState(false);

  async function logout() {
    setWorking(true);
    setLogoutError(undefined);
    try {
      await platformApi.logout();
      window.location.replace("/platform/login");
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status) && error.message === "platform_credentials_required") {
        window.location.replace("/platform/login");
        return;
      }
      setLogoutError(error);
      setWorking(false);
    }
  }

  if (account.isPending) return <main className="p-8"><Loading /></main>;
  if (!account.data) return <main className="p-8"><h1 className="mb-3 text-xl font-semibold">Platform access</h1><Link href="/platform/login" className="text-primary-700 underline">Sign in to PulseOS Platform</Link></main>;
  const links = [
    { href: "/platform", label: "Dashboard", allowed: true },
    { href: "/platform/hospitals", label: "Hospitals", allowed: true },
    { href: "/platform/operations", label: "Operations", allowed: account.data.permissions.includes("hospital:lifecycle:read") },
    { href: "/platform/administrators", label: "Administrators", allowed: account.data.permissions.includes("team:manage") },
    { href: "/platform/audit", label: "Audit log", allowed: account.data.permissions.includes("audit:read") },
  ];
  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-8">
          <Link href="/platform" aria-label="PulseOS Platform dashboard"><PulseLockup tone="onWhite" size={28} /></Link>
          <nav aria-label="Platform" className="flex flex-wrap gap-4 text-sm font-semibold">
            {links.filter((link) => link.allowed).map((link) => {
              const active = path === link.href || (link.href !== "/platform" && path.startsWith(link.href + "/"));
              return <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined} className={active ? "text-primary-700 underline" : "text-neutral-700"}>{link.label}</Link>;
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="break-all">{account.data.email}</span>
            <button className={secondaryClass} onClick={logout} disabled={working}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl p-4 sm:p-8">
        {logoutError !== undefined && <Failure error={logoutError} />}
        {children}
      </main>
    </div>
  );
}
