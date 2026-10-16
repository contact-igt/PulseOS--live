"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import type { SessionUser } from "@pulseos/types";
import { pathAllowedForRole, ROLE_HOME } from "../components/shell/nav";
import { afterLoginPath } from "./authRedirect";

/** The page a signed-out person was trying to open (`?from=`), read from the address bar at the moment it is used. */
function requestedPath(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("from");
  } catch {
    return null;
  }
}

/** Where a person who is signed in goes next: the page they asked for if their role may use it, else their role's home. */
export function destinationFor(user: Pick<SessionUser, "role" | "capabilities">): string {
  const home = ROLE_HOME[user.role] ?? "/command-centre";
  return afterLoginPath(requestedPath(), home, (p) => pathAllowedForRole(user.role, p, user.capabilities));
}

/**
 * Sign-in pages: someone who already has a valid session (a bookmark, the back button, a second tab) is not shown the form
 * again, they go straight in. The session is the httpOnly cookie, asked of the server; no token is read or kept in the browser.
 */
export function useRedirectIfSignedIn(): void {
  const router = useRouter();
  const { data, isSuccess, isFetching } = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: 0 });
  // Only a session the server has just confirmed counts. A cached one can be stale (it expired while the app was open), and
  // following it would bounce the person between this page and the app.
  useEffect(() => {
    if (data && isSuccess && !isFetching) router.replace(destinationFor(data.user));
  }, [data, isSuccess, isFetching, router]);
}
