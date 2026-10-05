"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { api } from "@pulseos/api-client";
import {
  Badge, Button, EmptyState, ErrorState, FilterBar, FilterSelect, Skeleton, Table, TableBody, TableHead, TableShell, Td, Th, Toolbar, Tr,
  fmtDate, JOURNEY_STAGE_LABEL, JOURNEY_STAGE_TONE,
} from "@pulseos/ui";
import { useQuickCreate } from "../../../components/shell/QuickCreateProvider";
import { withFrom } from "@/components/shell/BackLink";
import { hasPermission } from "@pulseos/types";
import type { JourneyStage } from "@pulseos/types";

const STAGE_LABEL = JOURNEY_STAGE_LABEL;
const STAGE_TONE = JOURNEY_STAGE_TONE;
const STAGES = Object.keys(JOURNEY_STAGE_LABEL) as JourneyStage[];

export default function PatientsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const quickCreate = useQuickCreate();
  // Seeds from the global TopBar search's `?q=` — otherwise a query typed
  // there silently vanishes on arrival here.
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [stage, setStage] = useState("");

  const dashboardFilter = searchParams.get("filter") ?? undefined;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["patients", search, stage],
    queryFn: () => api.patients({ search: search || undefined, stage: stage || undefined }),
  });

  // EDIT_PATIENTS gates patient creation server-side (Doctor doesn't have
  // it) — mirrored here only to avoid showing a dead control, never as the
  // actual authorization boundary.
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const canEditPatients = !!session.data && hasPermission(session.data.user.role, "EDIT_PATIENTS");
  const filtersActive = !!(search || stage);

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="patients-page">
      <Toolbar
        actions={
          <>
            {data && <span className="text-xs text-ink-2">{data.length} patient{data.length === 1 ? "" : "s"}</span>}
            {canEditPatients && (
              <Button variant="primary" onClick={() => quickCreate.openAddPatient()} data-testid="add-patient-button">
                + Add Patient
              </Button>
            )}
          </>
        }
      >
        <FilterBar>
          <label className="glass-control relative inline-flex h-8 min-w-0 flex-1 basis-56 items-center rounded-control sm:max-w-72">
            <Search size={13} className="pointer-events-none absolute left-2.5 text-neutral-500" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search patients"
              placeholder="Search by name or phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-full w-full min-w-0 rounded-control bg-transparent pl-8 pr-2.5 text-xs text-ink outline-none placeholder:text-neutral-500 focus-visible:ring-1 focus-visible:ring-primary-500"
              data-testid="patient-search"
            />
          </label>
          <FilterSelect className="basis-[calc(50%-0.25rem)]! sm:basis-auto!" aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value)} data-testid="patient-filter-stage">
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </FilterSelect>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setStage(""); }}>
              Clear filters
            </Button>
          )}
          {dashboardFilter && <Badge tone="primary">From dashboard: {dashboardFilter.replace(/_/g, " ")}</Badge>}
        </FilterBar>
      </Toolbar>

      <TableShell>
        {isLoading && <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
        {isError && <ErrorState message="Could not load patients." />}
        {data && data.length === 0 && (
          <EmptyState
            message="No patients found."
            hint={filtersActive ? "Try a different name, phone number or stage." : undefined}
            action={
              canEditPatients ? (
                <Button size="sm" variant="primary" onClick={() => quickCreate.openAddPatient()}>
                  + Add Patient
                </Button>
              ) : undefined
            }
          />
        )}
        {data && data.length > 0 && (
          <Table className="min-w-[960px]">
            <TableHead sticky>
              <tr>
                <Th leading>Patient</Th>
                <Th>Service</Th>
                <Th>Stage</Th>
                <Th align="center">Journeys</Th>
                <Th>Source</Th>
                <Th>Team Member</Th>
                <Th>Next action</Th>
                <Th>Last interaction</Th>
                <Th>Branch</Th>
              </tr>
            </TableHead>
            <TableBody>
              {data.map((p) => (
                <Tr key={p.id} onClick={() => router.push(withFrom(`/patients/${p.id}`, "patients"))}>
                  <Td leading nowrap>
                    <Link href={withFrom(`/patients/${p.id}`, "patients")} onClick={(e) => e.stopPropagation()} className="block font-medium text-ink hover:text-primary-700 hover:underline">
                      {p.name}
                    </Link>
                    <span className="block text-[11px] text-ink-2">{p.phone}</span>
                  </Td>
                  <Td className="text-ink-2" nowrap>{p.currentJourneyType ?? "—"}</Td>
                  <Td>{p.currentStage ? <Badge tone={STAGE_TONE[p.currentStage] ?? "neutral"}>{STAGE_LABEL[p.currentStage] ?? p.currentStage}</Badge> : "—"}</Td>
                  <Td align="center">{p.activeJourneyCount}</Td>
                  <Td className="text-ink-2" nowrap>{p.source ?? "—"}</Td>
                  <Td className="text-ink-2" nowrap>{p.ownerName ?? "—"}</Td>
                  <Td className="text-ink-2" nowrap>{fmtDate(p.nextActionDueAt)}</Td>
                  <Td className="text-ink-2" nowrap>{fmtDate(p.lastInteractionAt)}</Td>
                  <Td className="text-ink-2" nowrap>{p.branchName ?? "—"}</Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        )}
      </TableShell>
    </div>
  );
}
