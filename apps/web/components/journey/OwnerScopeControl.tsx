"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { replaceUrlParams } from "@/lib/urlParams";
import { FilterBar, FilterSelect, Tabs } from "@pulseos/ui";
import type { LookupOption } from "@pulseos/types";

/**
 * Owner scope stored in the URL (`?owner=`) so it is shareable and other pages
 * (e.g. the Command Centre team panel) can deep-link to one owner's work.
 * "" = everyone, "mine" | "unassigned" | <userId>.
 */
export function useOwnerScope(): [string, (next: string) => void] {
  const searchParams = useSearchParams();
  const owner = searchParams.get("owner") ?? "";
  const setOwner = useCallback((next: string) => void replaceUrlParams({ owner: next || undefined }), []);
  return [owner, setOwner];
}

/** All / Mine / Unassigned segmented control plus a specific-owner select. */
export function OwnerScopeControl({ value, onChange, owners, counts }: { value: string; onChange: (next: string) => void; owners: LookupOption[]; counts?: { all: number; mine: number; unassigned: number; byOwner: Record<string, number> } }) {
  const n = (c: number | undefined) => (counts && c !== undefined ? ` (${c})` : "");
  const segment = value === "" || value === "mine" || value === "unassigned" ? (value === "" ? "all" : value) : "owner";
  return (
    <FilterBar data-testid="owner-scope">
      <Tabs
        ariaLabel="Team member scope"
        value={segment}
        onChange={(k) => onChange(k === "all" ? "" : k)}
        items={[
          { key: "all", label: `All Team${n(counts?.all)}`, testId: "owner-scope-all" },
          { key: "mine", label: `Mine${n(counts?.mine)}`, testId: "owner-scope-mine" },
          { key: "unassigned", label: `Unassigned${n(counts?.unassigned)}`, testId: "owner-scope-unassigned" },
        ]}
      />
      {owners.length > 0 && (
        <FilterSelect aria-label="Filter by team member" value={owners.some((o) => o.id === value) ? value : ""} onChange={(e) => onChange(e.target.value)} data-testid="owner-scope-select">
          <option value="">Any team member</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.name}{n(counts?.byOwner[o.id] ?? 0)}</option>
          ))}
        </FilterSelect>
      )}
    </FilterBar>
  );
}
