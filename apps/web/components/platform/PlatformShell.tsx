"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Building2, Layers, LayoutDashboard, LifeBuoy, LogOut, MailCheck, Menu, Plug, ShieldCheck, SlidersHorizontal, Users, X, type LucideIcon } from "lucide-react";
import { PulseLockup } from "@pulseos/ui";
import { hasPlatformPermission, platformRoleLabel, type PlatformSessionUser } from "@pulseos/types";
import { platformApi, ApiError } from "@pulseos/api-client";
import { PLATFORM_NAV, activePlatformItem } from "./nav";

const ICONS: Record<string, LucideIcon> = { LayoutDashboard, Building2, Users, MailCheck, Layers, Plug, LifeBuoy, ShieldCheck, Activity, SlidersHorizontal };

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Company-side shell: PulseOS by Invictus Global Tech. Never a hospital's branding, never hospital navigation. */
export function PlatformShell({ user, children }: { user: PlatformSessionUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }
  const active = activePlatformItem(pathname);

  async function logout() {
    setLogoutError(null);
    try {
      await platformApi.logout();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setLogoutError("Couldn't sign out. Check your connection and try again.");
        return;
      }
    }
    queryClient.clear();
    router.replace("/platform/login");
  }

  return (
    <div className="app-shell flex h-dvh overflow-hidden" data-testid="platform-shell">
      <a href="#platform-main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow-panel">
        Skip to content
      </a>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} data-testid="platform-nav-backdrop" />}
      <nav
        aria-label="Platform Console"
        className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-72 max-w-[86vw] shrink-0 flex-col app-sidebar transition-[transform,visibility] duration-200 max-lg:rounded-r-shell lg:static lg:m-3 lg:h-[calc(100dvh-1.5rem)] lg:w-56 lg:translate-x-0 lg:rounded-shell ${open ? "translate-x-0" : "-translate-x-full max-lg:invisible"}`}
        data-testid="platform-sidebar"
      >
        <div className="nav-divider flex h-16 shrink-0 items-center justify-between border-b px-4">
          <span className="min-w-0">
            <PulseLockup tone="onWhite" size={24} betaLabel="Platform" />
            <span className="nav-secondary mt-0.5 block truncate text-[10px] font-medium">by Invictus Global Tech</span>
          </span>
          <button type="button" onClick={() => setOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-control lg:hidden" aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {PLATFORM_NAV.map((group) => {
            const items = group.items.filter((i) => hasPlatformPermission(user.role, i.permission));
            if (items.length === 0) return null;
            return (
              <div key={group.label}>
                <p className="nav-group-label px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]">{group.label}</p>
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = ICONS[item.icon] ?? LayoutDashboard;
                    const isActive = active?.href === item.href;
                    return (
                      <li key={item.href}>
                        <Link href={item.href} aria-current={isActive ? "page" : undefined} className={`nav-link flex items-center gap-2.5 rounded-control px-2.5 py-3 text-[13px] lg:py-1.5 ${isActive ? "font-semibold" : "font-medium"}`} data-testid={`platform-nav-${item.href}`}>
                          <Icon size={17} strokeWidth={isActive ? 2.25 : 2} className="nav-icon shrink-0" />
                          <span className="min-w-0 truncate">{item.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="nav-divider flex shrink-0 items-center gap-2.5 border-t px-3 py-3">
          <span className="nav-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{initials(user.name)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{user.name}</span>
            <span className="nav-secondary block truncate text-xs" data-testid="platform-role">{platformRoleLabel(user.role)}</span>
          </span>
        </div>
      </nav>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="glass-strong absolute inset-x-0 top-0 z-(--z-sticky) flex h-16 items-center justify-between gap-3 px-3 max-lg:rounded-none max-lg:border-x-0 max-lg:border-t-0 sm:px-5 lg:right-3 lg:top-3 lg:rounded-panel" data-testid="platform-topbar">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={() => setOpen((v) => !v)} className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-neutral-600 hover:bg-white/70 lg:hidden" aria-label="Open navigation" data-testid="platform-menu-button">
              <Menu size={20} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold tracking-tight text-ink sm:text-base">{active?.label ?? "Platform Console"}</p>
              <p className="hidden truncate text-xs text-ink-2 sm:block">PulseOS Platform Console · company side</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {logoutError && <span role="alert" className="hidden text-xs text-danger-700 sm:inline">{logoutError}</span>}
            <span className="hidden rounded-chip border border-line bg-white/70 px-2 py-0.5 text-[11px] font-medium text-ink-2 md:inline" title={user.email}>
              {platformRoleLabel(user.role)}
            </span>
            <button type="button" onClick={logout} className="flex min-h-11 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium text-neutral-600 hover:bg-white/70 hover:text-slate-900 lg:min-h-9" data-testid="platform-logout">
              <LogOut size={15} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main id="platform-main" tabIndex={-1} className="flex-1 overflow-x-hidden overflow-y-auto p-4 pt-20 focus:outline-none lg:p-6 lg:pl-3 lg:pt-[6.25rem]">
          {children}
        </main>
      </div>
    </div>
  );
}
