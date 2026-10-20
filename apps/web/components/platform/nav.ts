import type { PlatformPermission } from "@pulseos/types";

export interface PlatformNavItem {
  label: string;
  href: string;
  icon: string;
  /** Hidden for a role without it. The API refuses the data either way; this only avoids dead navigation. */
  permission: PlatformPermission;
}

/** The Platform Console's ten destinations. No patient-care workflow ever lives here. */
export const PLATFORM_NAV: { label: string; items: PlatformNavItem[] }[] = [
  {
    label: "Platform",
    items: [
      { label: "Overview", href: "/platform", icon: "LayoutDashboard", permission: "VIEW_PLATFORM" },
      { label: "Tenants", href: "/platform/tenants", icon: "Building2", permission: "VIEW_PLATFORM" },
      { label: "Users", href: "/platform/users", icon: "Users", permission: "VIEW_PLATFORM" },
      { label: "Access & Invitations", href: "/platform/access", icon: "MailCheck", permission: "VIEW_PLATFORM" },
      { label: "Plans & Capabilities", href: "/platform/plans", icon: "Layers", permission: "VIEW_PLATFORM" },
      { label: "Integrations", href: "/platform/integrations", icon: "Plug", permission: "VIEW_PLATFORM" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Support", href: "/platform/support", icon: "LifeBuoy", permission: "VIEW_PLATFORM" },
      { label: "Audit & Security", href: "/platform/audit", icon: "ShieldCheck", permission: "VIEW_AUDIT" },
      { label: "Platform Health", href: "/platform/health", icon: "Activity", permission: "VIEW_PLATFORM" },
      { label: "Platform Settings", href: "/platform/settings", icon: "SlidersHorizontal", permission: "VIEW_PLATFORM" },
    ],
  },
];

/** The nav item a path belongs to (longest matching prefix), for the active state and the page title. */
export function activePlatformItem(pathname: string): PlatformNavItem | undefined {
  const all = PLATFORM_NAV.flatMap((g) => g.items);
  return all.filter((i) => pathname === i.href || (i.href !== "/platform" && pathname.startsWith(`${i.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
}
