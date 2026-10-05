"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";

/** tenants.timezone default — only used before the session has loaded. */
const FALLBACK_TIME_ZONE = "Asia/Kolkata";

/**
 * The hospital's IANA timezone from the signed-in session (tenants.timezone).
 * Every "today", day boundary and date label in the views uses it — never the
 * browser's zone. The (app) layout loads the session before rendering pages,
 * so this reads the cached ["session"] query without a new request.
 */
export function useHospitalTimeZone(): string {
  const { data } = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  return data?.user.timezone ?? FALLBACK_TIME_ZONE;
}
