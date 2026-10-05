"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { replaceUrlParams } from "./urlParams";

/**
 * Page filters (branch, doctor, tab, search...) kept in the URL next to the
 * view/date that useViewState owns. Reads follow the router (so the page
 * re-renders); writes go through `replaceUrlParams` — instant, no history
 * entry, and never clobbering another writer. Refresh and shared links
 * restore the same filtered view.
 */
export function useUrlFilters() {
  const params = useSearchParams();
  const get = useCallback((key: string) => params.get(key) ?? "", [params]);
  const set = useCallback((patch: Record<string, string | undefined>) => void replaceUrlParams(patch), []);
  return { get, set };
}
