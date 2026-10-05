"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarCheck,
  GitBranch,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Plug,
  Radio,
  Settings,
  Stethoscope,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PulseLockup } from "@pulseos/ui";
import type { SessionUser } from "@pulseos/types";
import { initials, lockedNavItems, navForRole } from "./nav";
import { TruncatedText } from "./TruncatedText";
import { roleGroupLabel } from "@pulseos/types";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  ListChecks,
  Users,
  GitBranch,
  CalendarCheck,
  Stethoscope,
  Inbox,
  Megaphone,
  Plug,
  Radio,
  Settings,
  UserPlus,
};


export function Sidebar({ user, open = false, onClose }: { user: SessionUser; open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  // Unbuilt destinations are hidden, not shown greyed out: no dead navigation.
  const groups = navForRole(user.role, user.capabilities)
    .map((group) => ({ ...group, items: group.items.filter((item) => item.implemented) }))
    .filter((group) => group.items.length > 0);

  const locked = lockedNavItems(user.role, user.capabilities);

  return (
    <>
      {open && (
        <div
          className="fixed inset-y-0 right-0 left-[min(18rem,86vw)] z-30 bg-slate-900/30 lg:hidden"
          onClick={onClose}
          data-testid="sidebar-backdrop"
        />
      )}
      <nav
        className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-72 max-w-[86vw] shrink-0 flex-col app-sidebar transition-[transform,visibility] duration-200 max-lg:rounded-r-shell lg:static lg:m-3 lg:h-[calc(100dvh-1.5rem)] lg:w-56 lg:translate-x-0 lg:rounded-shell ${
          // Closed on small screens: off-canvas AND out of the tab order / a11y tree.
          open ? "translate-x-0" : "-translate-x-full max-lg:invisible"
        }`}
        data-testid="sidebar"
      >
        <div className="nav-divider flex h-16 shrink-0 items-center border-b px-4" data-testid="sidebar-brand">
          <PulseLockup tone="onWhite" size={28} betaLabel={user.edition === "BETA_V2_GROWTH" ? "Beta V2" : "Beta V1"} />
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="nav-group-label px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.href;
                  const Icon = ICONS[item.icon] ?? LayoutDashboard;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        aria-current={active ? "page" : undefined}
                        className={`nav-link flex items-center gap-2.5 rounded-control px-2.5 py-3 text-[13px] lg:py-1.5 ${active ? "font-semibold" : "font-medium"}`}
                        data-testid={`nav-${item.href}`}
                      >
                        <Icon size={17} strokeWidth={active ? 2.25 : 2} className="nav-icon shrink-0" />
                        <TruncatedText className="min-w-0">{item.label}</TruncatedText>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {locked.length > 0 && (
            <div data-testid="nav-locked">
              <p className="nav-group-label px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]">Not switched on</p>
              <ul className="space-y-0.5">
                {locked.map((item) => {
                  const Icon = ICONS[item.icon] ?? LayoutDashboard;
                  return (
                    <li key={item.href}>
                      <span aria-disabled="true" title="Not switched on for this hospital. A Super Admin can turn it on in Settings → Features." className="nav-secondary flex cursor-not-allowed items-center gap-2.5 rounded-control px-2.5 py-3 text-[13px] font-medium opacity-60 lg:py-1.5" data-testid={`nav-locked-${item.href}`}>
                        <Icon size={17} strokeWidth={2} className="shrink-0" />
                        <TruncatedText className="min-w-0 flex-1">{item.label}</TruncatedText>
                        <span className="rounded-chip border border-line px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide">Beta V2</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="nav-divider flex shrink-0 items-center gap-2.5 border-t px-3 py-3">
          <span className="nav-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{initials(user.name)}</span>
          <span className="min-w-0 flex-1">
            <TruncatedText className="block text-[13px] font-medium">{user.name}</TruncatedText>
            <TruncatedText className="nav-secondary block text-xs">
              {roleGroupLabel(user.role)}
              {user.branchName ? ` · ${user.branchName}` : ""}
            </TruncatedText>
          </span>
        </div>
      </nav>
    </>
  );
}
