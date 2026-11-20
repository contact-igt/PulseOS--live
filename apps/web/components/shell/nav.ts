import { DEFAULT_EDITION, navForRole, type NavSource, type Role } from "@pulseos/types";
export { navForRole, lockedNavItems, type NavSource, type NavItem, type NavGroup } from "@pulseos/types";

// The one shared map from role to landing page — login redirects here after
// sign-in, and the route guard below redirects here from any page outside
// the role's own nav. Previously duplicated as a local const in
// login/page.tsx; consolidated so the two can't drift.
export const ROLE_HOME: Record<Role, string> = {
  DOCTOR: "/doctor-home",
  HOSPITAL_ADMIN: "/command-centre",
  SUPER_ADMIN: "/command-centre",
  FRONT_DESK: "/front-desk",
  PATIENT_COORDINATOR: "/my-work",
};

// Legacy URLs that exist only to `redirect()` a browser straight to their
// canonical replacement (see app/(app)/treatment/page.tsx) — role-neutral by
// definition, since every role ends up at the same next page regardless of
// who followed the old link. The guard must not treat these as "not
// allowed": that redirect is a Server Component effect that runs before the
// client ever mounts, but the client route guard's own effect can still fire
// on the pre-redirect pathname in the same tick and win the race, sending
// the user to their role home instead of where the old link actually meant
// to go.
const ROLE_NEUTRAL_REDIRECT_PATHS = ["/treatment"];

// True if `pathname` is reachable from this role's own sidebar, or is a
// detail sub-route of something that is (e.g. /patients/abc123 under a nav
// entry for /patients). Driven entirely by the existing nav data — no
// separate permission list to keep in sync with it.
export function pathAllowedForRole(role: Role, pathname: string, edition: NavSource = DEFAULT_EDITION): boolean {
  if (ROLE_NEUTRAL_REDIRECT_PATHS.includes(pathname)) return true;
  const items = navForRole(role, edition).flatMap((group) => group.items);
  return items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}

/** Up to two initials for an avatar, e.g. "Meghna Kapoor" -> "MK". */
export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
