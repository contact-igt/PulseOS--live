"use client";

import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@pulseos/api-client";
import { Button, Card, EmptyState, ErrorState, Skeleton, Tabs, Toolbar, ViewSwitcher } from "@pulseos/ui";
import { LEAD_VIEWS, hasPermission, type LeadRow, type LeadsTodaySummary } from "@pulseos/types";
import { Columns3, Table2 } from "lucide-react";
import { useQuickCreate } from "../../../components/shell/QuickCreateProvider";
import { withFrom } from "@/components/shell/BackLink";
import { AssignOwnerDialog } from "@/components/journey/AssignOwnerDialog";
import { invalidateJourneyQueries } from "@/components/journey/invalidate";
import { replaceUrlParams } from "@/lib/urlParams";
import { LeadsStageBoard } from "@/components/leads/LeadsStageBoard";
import { LeadsFilterBar } from "@/components/leads/LeadsFilterBar";
import { LeadsTable } from "@/components/leads/LeadsTable";
import { LeadCards } from "@/components/leads/LeadCards";
import { ColumnPicker, PaginationBar } from "@/components/leads/LeadsListControls";
import { DEFAULT_COLUMNS, loadColumnPref, paginate, readPageSize, saveColumnPref, searchLeads, type LeadColumn, type PageSize } from "@/components/leads/leadList";
import { useIsNarrow } from "@/lib/useIsNarrow";
import { LeadsTodayStrip } from "@/components/leads/LeadsTodayStrip";
import { activeLeadChips, isDefaultLeadFilters, leadFilterPatch, readLeadFilters, resetLeadPatch, toWorkspaceQuery, type LeadFilters } from "@/components/leads/leadFilters";

type LeadsView = "table" | "board";
const VIEW_OPTIONS = [
  { key: "table" as const, label: "Table", icon: <Table2 size={14} />, controls: "leads-view-panel" },
  { key: "board" as const, label: "Board", icon: <Columns3 size={14} />, controls: "leads-view-panel" },
];

/** What the open assignment dialog is for: one row, or the current bulk selection. */
type Assigning = { kind: "one"; row: LeadRow } | { kind: "bulk" } | null;

export default function LeadsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const quickCreate = useQuickCreate();
  const searchParams = useSearchParams();
  // Every filter lives in the URL, so reload, back/forward and shared links restore exactly this list.
  const filters = useMemo(() => readLeadFilters((k) => searchParams.get(k) ?? "", ""), [searchParams]);
  const change = useCallback((patch: Partial<LeadFilters>) => void replaceUrlParams(leadFilterPatch(patch)), []);
  // Table / Board is `?layout=` (`?view=` belongs to the quick views). An older `?view=board` link still opens the board.
  const view: LeadsView = searchParams.get("layout") === "board" || (!searchParams.get("layout") && searchParams.get("view") === "board") ? "board" : "table";
  const setView = useCallback((next: LeadsView) => void replaceUrlParams({ layout: next === "table" ? undefined : next, ...(searchParams.get("view") === "board" ? { view: undefined } : {}) }), [searchParams]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState<Assigning>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const query = useMemo(() => toWorkspaceQuery(filters), [filters]);
  // One request for the rows, every tab's count, the today strip and the owner counts: they cannot disagree.
  const leads = useQuery({ queryKey: ["leads", "workspace", query], queryFn: () => api.leadsWorkspace(query), placeholderData: keepPreviousData });
  const workspace = leads.data;

  const canAssign = session.data ? hasPermission(session.data.user.role, "MANAGE_JOURNEYS") : false;
  const owners = lookups.data?.owners ?? [];
  // Search narrows the loaded list; paging only shapes how it is shown (counts above come from the server's filters).
  const found = useMemo(() => searchLeads(workspace?.rows ?? [], filters.q), [workspace, filters.q]);
  const [pageSize, setPageSizeState] = useState<PageSize>(() => readPageSize(searchParams.get("size")));
  const paged = useMemo(() => paginate(found, Number(searchParams.get("page")) || 1, pageSize), [found, searchParams, pageSize]);
  const rows = paged.rows;
  const narrow = useIsNarrow();
  // Which columns to show: a saved VIEW preference for this person on this browser.
  const userId = session.data?.user.id;
  const [chosenColumns, setChosenColumns] = useState<{ userId: string; columns: LeadColumn[] } | null>(null);
  const columns = useMemo(() => (chosenColumns && chosenColumns.userId === userId ? chosenColumns.columns : userId ? loadColumnPref(userId) : DEFAULT_COLUMNS), [chosenColumns, userId]);
  const chooseColumns = (next: LeadColumn[]) => {
    if (!userId) return;
    setChosenColumns({ userId, columns: next });
    saveColumnPref(userId, next);
  };
  const setPage = (p: number) => void replaceUrlParams({ page: p > 1 ? String(p) : undefined });
  const setPageSize = (s: PageSize) => {
    setPageSizeState(s);
    void replaceUrlParams({ size: s === 50 ? undefined : String(s), page: undefined });
  };
  // Selection only ever counts rows still on screen (filters can hide selected rows).
  const selectedIds = useMemo(() => rows.filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const chips = activeLeadChips(filters, { sources: workspace?.options.sources ?? [], owners, fields: workspace?.options.filterableFields ?? [] });
  const dirty = !isDefaultLeadFilters(filters);

  const openStrip = (key: keyof LeadsTodaySummary) => {
    setSelected(new Set());
    if (key === "appointmentsToday") change({ view: "appointments_today" });
    else if (key === "newToday") change({ view: "new_today" });
    else if (key === "followUpsDue") change({ view: "follow_up_due", due: undefined });
    else change({ view: "follow_up_due", due: "overdue" });
  };
  const stripActive: keyof LeadsTodaySummary | null =
    filters.view === "appointments_today" ? "appointmentsToday" : filters.view === "new_today" ? "newToday" : filters.view === "follow_up_due" ? (filters.due ? "overdue" : "followUpsDue") : null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const ownerName = (id: string | null) => (id ? owners.find((o) => o.id === id)?.name ?? "the selected team member" : "Unassigned");

  async function submitAssignment(ownerId: string | null) {
    if (!assigning) return;
    if (assigning.kind === "one") {
      await api.assignJourneyOwner(assigning.row.id, ownerId);
      setNotice(null);
    } else {
      const result = await api.assignJourneyOwnerBulk(selectedIds, ownerId);
      setSelected(new Set());
      setNotice(`${result.updatedCount} journey${result.updatedCount === 1 ? "" : "s"} assigned to ${ownerName(ownerId)}.`);
    }
    invalidateJourneyQueries(queryClient);
    setAssigning(null);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-3" data-testid="leads-page">
      <Toolbar
        actions={
          <>
            {view === "table" && !narrow && <ColumnPicker value={columns} onChange={chooseColumns} onReset={() => chooseColumns(DEFAULT_COLUMNS)} />}
            <ViewSwitcher ariaLabel="Leads view" value={view} onChange={setView} options={VIEW_OPTIONS} />
            <Button variant="primary" onClick={() => quickCreate.openAddLead()} className="max-md:min-h-11" data-testid="add-lead-button">
              + Add Lead
            </Button>
          </>
        }
      >
        <Tabs
          variant="underline"
          ariaLabel="Lead views"
          value={filters.view}
          onChange={(k) => {
            setSelected(new Set());
            change({ view: k as LeadFilters["view"] });
          }}
          items={LEAD_VIEWS.map((v) => ({ key: v.key, label: v.label, count: workspace?.counts[v.key], testId: `leads-tab-${v.key}` }))}
        />
      </Toolbar>

      {workspace && (
        <p className="-mt-1 px-0.5 text-[11px] text-ink-2" data-testid="leads-view-hint">
          {LEAD_VIEWS.find((v) => v.key === filters.view)?.hint}
          {filters.due ? " — overdue only" : ""}
        </p>
      )}

      {workspace && <LeadsTodayStrip summary={workspace.today} onOpen={openStrip} activeKey={stripActive} />}

      <LeadsFilterBar filters={filters} workspace={workspace} sessionUserId={session.data?.user.id} owners={owners} chips={chips} dirty={dirty} onChange={(p) => { setSelected(new Set()); change(p); }} onReset={() => { setSelected(new Set()); void replaceUrlParams(resetLeadPatch()); }} />

      {view === "table" && canAssign && selectedIds.length > 0 && (
        <Card tone="info" className="flex flex-wrap items-center gap-3 px-4 py-2" data-testid="bulk-bar" role="region" aria-label="Bulk actions">
          <span className="text-sm font-medium text-ink">{selectedIds.length} selected</span>
          <Button variant="primary" size="sm" onClick={() => { setNotice(null); setAssigning({ kind: "bulk" }); }} data-testid="bulk-assign">
            Assign Team Member
          </Button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-ink-2 hover:text-ink max-md:min-h-11 max-md:px-2" data-testid="bulk-clear">
            Clear
          </button>
        </Card>
      )}
      {notice && (
        <p role="status" className="px-1 text-xs text-primary-700" data-testid="assign-notice">
          {notice}
        </p>
      )}

      {view === "board" && found.length > 0 && (
        <div id="leads-view-panel" role="tabpanel" aria-label="Board">
          <LeadsStageBoard rows={found} onOpen={(lead) => router.push(withFrom(`/journeys/${lead.id}`, "leads"))} />
        </div>
      )}

      <Card className={`overflow-x-auto p-0 ${view === "board" && found.length > 0 ? "hidden" : ""}`} id={view === "table" ? "leads-view-panel" : undefined}>
        {leads.isLoading && <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
        {leads.isError && <div className="p-4"><ErrorState message="Could not load leads." /></div>}
        {workspace && found.length === 0 && (
          <div className="p-8" data-testid="leads-empty">
            <EmptyState message={dirty ? "No leads match these filters." : "No leads yet."} />
            <div className="mt-3 flex justify-center gap-4">
              {dirty && (
                <button type="button" onClick={() => void replaceUrlParams(resetLeadPatch())} className="text-xs font-medium text-primary-600 hover:underline" data-testid="leads-empty-reset">
                  Reset filters
                </button>
              )}
              <button type="button" onClick={() => quickCreate.openAddLead()} className="text-xs font-medium text-primary-600 hover:underline">
                + Add Lead
              </button>
            </div>
          </div>
        )}
        {rows.length > 0 && view === "table" && narrow && <LeadCards rows={rows} onOpen={(lead) => router.push(withFrom(`/journeys/${lead.id}`, "leads"))} />}
        {rows.length > 0 && view === "table" && !narrow && (
          <LeadsTable
            rows={rows}
            columns={columns}
            actions={{
              onAddFollowUp: (lead) => quickCreate.openAddTask({ patient: { id: lead.patientId, name: lead.patientName, phone: lead.phone }, journeyId: lead.id }),
              onBookAppointment: (lead) => quickCreate.openNewAppointment({ patient: { id: lead.patientId, name: lead.patientName, phone: lead.phone }, journeyId: lead.id }),
            }}
            canAssign={canAssign}
            selected={selected}
            allSelected={allSelected}
            onToggle={toggle}
            onToggleAll={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
            onOpen={(lead) => router.push(withFrom(`/journeys/${lead.id}`, "leads"))}
            onAssign={(lead) => {
              setNotice(null);
              setAssigning({ kind: "one", row: lead });
            }}
          />
        )}
        {workspace && found.length > 0 && <PaginationBar page={paged} size={pageSize} onPage={setPage} onSize={setPageSize} />}
      </Card>

      {assigning && canAssign && (
        <AssignOwnerDialog
          open
          subject={assigning.kind === "one" ? assigning.row.patientName : `${selectedIds.length} journey${selectedIds.length === 1 ? "" : "s"}`}
          owners={owners}
          initialOwnerId={assigning.kind === "one" ? assigning.row.ownerId : null}
          onClose={() => setAssigning(null)}
          onSubmit={submitAssignment}
        />
      )}
    </div>
  );
}
