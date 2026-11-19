"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Activity, Building2, ClipboardList, LayoutDashboard, LogOut, Menu, ShieldCheck, X } from "lucide-react";
import { ApiError, platformApi } from "@pulseos/api-client";
import { PulseLockup } from "@pulseos/ui";
import { Failure, Loading, secondaryClass, usePlatformAccount } from "./platform-ui";

export default function PlatformConsole({ children }: { children: React.ReactNode }) {
  const account = usePlatformAccount();
  const path = usePathname();
  const [logoutError, setLogoutError] = useState<unknown>();
  const [working, setWorking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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
    { href: "/platform", label: "Dashboard", icon: LayoutDashboard, allowed: true },
    { href: "/platform/hospitals", label: "Hospitals", icon: Building2, allowed: true },
    { href: "/platform/operations", label: "Operations", icon: Activity, allowed: account.data.permissions.includes("hospital:lifecycle:read") },
    { href: "/platform/administrators", label: "Administrators", icon: ShieldCheck, allowed: account.data.permissions.includes("team:manage") },
    { href: "/platform/audit", label: "Audit log", icon: ClipboardList, allowed: account.data.permissions.includes("audit:read") },
  ];
  const role = account.data.role === "PLATFORM_SUPER_ADMIN" ? "Platform Super Admin" : "Platform Operations Admin";
  return (
    <div className="app-shell min-h-dvh text-neutral-900 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="app-sidebar lg:sticky lg:top-3 lg:my-3 lg:ml-3 lg:flex lg:h-[calc(100dvh-1.5rem)] lg:flex-col lg:self-start lg:overflow-hidden lg:rounded-shell">
        <div className="nav-divider flex min-h-16 shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <Link href="/platform" onClick={() => setMenuOpen(false)} aria-label="PulseOS Platform dashboard">
            <PulseLockup tone="onWhite" size={28} />
          </Link>
          <button
            type="button"
            className={secondaryClass + " items-center justify-center lg:hidden"}
            aria-label={menuOpen ? "Close Platform menu" : "Open Platform menu"}
            aria-expanded={menuOpen}
            aria-controls="platform-sidebar-content"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
        <div id="platform-sidebar-content" className={`${menuOpen ? "flex" : "hidden"} flex-col lg:flex lg:min-h-0 lg:flex-1`}>
          <nav aria-label="Platform" className="px-3 py-4 lg:flex-1 lg:overflow-y-auto">
            <p className="nav-group-label px-3 pb-2 text-xs font-semibold uppercase tracking-wider">Platform</p>
            <ul className="space-y-1">
              {links.filter((link) => link.allowed).map(({ href, label, icon: Icon }) => {
                const active = path === href || (href !== "/platform" && path.startsWith(href + "/"));
                return <li key={href}>
                  <Link href={href} onClick={() => setMenuOpen(false)} aria-current={active ? "page" : undefined}
                    className={`nav-link flex items-center gap-3 rounded-control px-3 py-2.5 text-sm ${active ? "font-semibold" : "font-medium"}`}>
                    <Icon size={19} aria-hidden="true" className="nav-icon shrink-0" />
                    {label}
                  </Link>
                </li>;
              })}
            </ul>
          </nav>
          <div className="nav-divider shrink-0 space-y-3 border-t p-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className="nav-avatar flex size-9 shrink-0 items-center justify-center rounded-full">
                <ShieldCheck size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{role}</p>
                <p className="nav-secondary break-all text-xs">{account.data.email}</p>
              </div>
            </div>
            <button type="button" className={secondaryClass + " w-full items-center justify-center gap-2"} onClick={logout} disabled={working}>
              <LogOut size={16} aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="mx-auto w-full min-w-0 max-w-screen-2xl p-4 sm:p-8">
        {logoutError !== undefined && <Failure error={logoutError} />}
        {children}
      </main>
    </div>
  );
}
