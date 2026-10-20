"use client";

import { useQuery } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { hasPlatformPermission, type PlatformPermission } from "@pulseos/types";

/** The signed-in platform staff member (already loaded by the console layout) and a permission check for hiding actions. */
export function usePlatformUser() {
  const { data } = useQuery({ queryKey: ["platform-session"], queryFn: platformApi.session, retry: false, staleTime: 60_000 });
  const user = data?.user ?? null;
  return { user, can: (p: PlatformPermission) => !!user && hasPlatformPermission(user.role, p) };
}
