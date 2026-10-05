"use client";

import { treatmentDateLine, treatmentDoctorLabel } from "@/components/treatments/treatmentDates";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, CircleAlert, Columns3, Table2, X } from "lucide-react";
import { api } from "@pulseos/api-client";
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorState, FilterBar, FilterSelect, MetricStrip, OverflowMenu, Skeleton,
  Table, TableBody, TableHead, TableShell, Td, Th, Toolbar, Tr, ViewSwitcher,
  formatInr, fmtDate, localDayKey, TREATMENT_STATUS_LABEL, TREATMENT_STATUS_TONE,
} from "@pulseos/ui";
import { withFrom } from "@/components/shell/BackLink";
import { useViewState } from "@/lib/useViewState";
import { replaceUrlParams } from "@/lib/urlParams";
import { ProcedureCalendar } from "@/components/treatments/ProcedureCalendar";
import { TreatmentPipelineBoard } from "@/components/treatments/TreatmentPipelineBoard";
import { ALL_STATUSES, TREATMENT_VIEWS, moveErrorMessage, readTreatmentFilters, treatmentFilterPatch } from "@/components/treatments/pipeline";
import type { TreatmentUrlFilters, TreatmentView } from "@/components/treatments/pipeline";
import { DATE_PRESETS, hasPermission, resolveDatePreset } from "@pulseos/types";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { PeriodSelect } from "@/components/filters/PeriodSelect";
import { periodPatch, readPeriodChoice } from "@/components/filters/periodFilter";
import { addDays } from "@/components/report/reportFilters";
import type { TreatmentDateField, TreatmentFilters, TreatmentRow, TreatmentStatus } from "@pulseos/types";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { useCapability } from "@/lib/useEdition";

const STATUS_LABEL = TREATMENT_STATUS_LABEL;
const STATUS_TONE = TREATMENT_STATUS_TONE;

// Two selects per row on a phone (so labels are never cut to "All s"), natural width from sm up.
const FILTER_CLASS = "basis-[calc(50%-0.25rem)]! sm:basis-auto!";

const PIPELINE_STATUSES: TreatmentStatus[] = ["ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED", "COMPLETED"];

// One clear forward action per status (rendered as a real button) plus any
// rare/secondary transitions tucked into an overflow menu — never a wall of
// 3 buttons in one row (the Table Action Rule).
const NEXT_STEPS: Partial<Record<TreatmentStatus, { primary: { status: TreatmentStatus; label: string }; secondary: { status: TreatmentStatus; label: string; danger?: boolean }[] }>> = {
  ADVISED: {
    primary: { status: "ACCEPTED", label: "Accept" },
    secondary: [
      { status: "DECISION_PENDING", label: "Awaiting decision" },
      { status: "DECLINED", label: "Decline", danger: true },
    ],
  },
  DECISION_PENDING: {
    primary: { status: "ACCEPTED", label: "Accept" },
    secondary: [{ status: "DECLINED", label: "Decline", danger: true }],
  },
  ACCEPTED: { primary: { status: "SCHEDULED", label: "Schedule" }, secondary: [] },
  SCHEDULED: { primary: { status: "COMPLETED", label: "Complete" }, secondary: [] },
};

const VIEW_OPTIONS: { key: TreatmentView; label: string; icon: ReactNode }[] = [
  { key: "table", label: "Table", icon: <Table2 size={14} /> },
  { key: "pipeline", label: "Pipeline", icon: <Columns3 size={14} /> },
  { key: "calendar", label: "Calendar", icon: <CalendarDays size={14} /> },
];

export default function TreatmentPage() {
  const showValue = useCapability("REVENUE_TRACKING");
  const timeZone = useHospitalTimeZone();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<{ row: TreatmentRow; status: TreatmentStatus; label: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // View + date + range and every filter live in the URL: refresh, back/forward
  // and shared links restore the same records in the same view.
  const viewState = useViewState<TreatmentView>({ views: TREATMENT_VIEWS, defaultView: "table", defaultRange: "month", timeZone });
  const { view, date, setView, setDate, calendarMode, setCalendarMode } = viewState;
  const { status, service, doctorId, ownerId, procedureId } = useMemo(() => readTreatmentFilters(new URLSearchParams(params.toString())), [params]);
  const setFilters = useCallback((patch: Partial<TreatmentUrlFilters>) => void replaceUrlParams(treatmentFilterPatch(patch)), []);

  // service / doctor / owner / procedure are applied by the API; the state
  // filter is applied to the same result client-side so the pipeline counts
  // above the table always describe the other four filters, not the state.
  // The date filter always names its dimension - the day a procedure is SCHEDULED for, or the day it was COMPLETED - and
  // never "a date". It lives in the URL (tdate + trange/tfrom/tto) and resolves in the hospital's calendar.
  const today = localDayKey(new Date(), timeZone);
  const searchParams = useMemo(() => new URLSearchParams(params.toString()), [params]);
  const rawDimension = searchParams.get("tdate");
  const dimension: TreatmentDateField | "" = rawDimension === "scheduled" || rawDimension === "completed" ? rawDimension : "";
  const chosen = readPeriodChoice(searchParams, { prefix: "t", presets: DATE_PRESETS });
  // Choosing a dimension starts from a sensible window: look ahead for Scheduled, look back for Completed.
  const period = chosen.range ? chosen : dimension === "scheduled" ? { range: "custom", from: today, to: addDays(today, 30) } : { range: "30d", from: undefined, to: undefined };
  const dateSpan = dimension
    ? period.range === "custom" && period.from && period.to ? { from: period.from, to: period.to } : resolveDatePreset((period.range ?? "30d") as Parameters<typeof resolveDatePreset>[0], today)
    : null;

  const serverFilters: TreatmentFilters = {
    ...(dimension && dateSpan ? { dateField: dimension, from: dateSpan.from, to: dateSpan.to } : {}),
    ...(service ? { service } : {}),
    ...(doctorId ? { doctorId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(procedureId ? { treatmentDefinitionId: procedureId } : {}),
  };
  const treatments = useQuery({
    queryKey: ["treatments", serverFilters],
    queryFn: () => api.treatments(serverFilters),
  });

  // Unfiltered list only feeds the option lists (which services / procedures actually have treatments).
  const allTreatments = useQuery({ queryKey: ["treatments", "all"], queryFn: () => api.treatments({}) });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });
  const catalog = useQuery({ queryKey: ["treatment-catalog"], queryFn: () => api.treatmentCatalog() });

  const services = useMemo(() => [...new Set((allTreatments.data ?? []).map((t) => t.service).filter((s): s is string => !!s))].sort(), [allTreatments.data]);
  const procedures = useMemo(() => {
    const inScope = (allTreatments.data ?? []).filter((t) => !service || t.service === service);
    const usedIds = new Set(inScope.map((t) => t.treatmentDefinitionId).filter((id): id is string => !!id));
    return (catalog.data ?? []).filter((d) => usedIds.has(d.id));
  }, [allTreatments.data, catalog.data, service]);

  const rows = useMemo(() => (treatments.data ?? []).filter((t) => !status || t.status === status), [treatments.data, status]);
  const pipelineCounts = useMemo(
    () => (treatments.data ?? []).reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {} as Partial<Record<TreatmentStatus, number>>),
    [treatments.data],
  );
  const totalValue = rows.reduce((sum, t) => sum + t.estimatedValue, 0);
  const filtersActive = !!(status || service || doctorId || ownerId || procedureId || dimension);

  function clearFilters() {
    setFilters({ status: "", service: "", doctorId: "", ownerId: "", procedureId: "" });
    void replaceUrlParams({ tdate: undefined, ...periodPatch({ range: undefined, from: undefined, to: undefined }, { prefix: "t", defaultRange: "" }) });
  }

  // MANAGE_TREATMENT gates the status-transition endpoint server-side
  // (Doctor has VIEW_TREATMENT but advises via RECORD_CONSULTATION_OUTCOME,
  // not by driving the funnel here) — mirrored here only to avoid showing
  // dead controls, never as the actual authorization boundary.
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const canManage = !!session.data && hasPermission(session.data.user.role, "MANAGE_TREATMENT");

  /**
   * One write path for the table buttons and the board. Resolves only once the
   * treatments list has refetched (the board keeps its optimistic position
   * until then); a rejection refetches too — so a stale card snaps to the
   * server's real state — and rethrows a specific, human message.
   */
  async function saveStatus(row: TreatmentRow, next: TreatmentStatus) {
    try {
      await api.updateTreatmentStatus(row.id, next);
    } catch (err) {
      await queryClient.invalidateQueries({ queryKey: ["treatments"] });
      throw new Error(moveErrorMessage(err, STATUS_LABEL[next]));
    }
    // A treatment reaching e.g. COMPLETED also advances the underlying
    // Journey's stage server-side — keep the dashboard's revenue/decision
    // KPIs and Patient 360/Journeys' stage badges from going stale.
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["journeys"] });
    queryClient.invalidateQueries({ queryKey: ["journey"] });
    queryClient.invalidateQueries({ queryKey: ["patients"] });
    queryClient.invalidateQueries({ queryKey: ["patient360"] });
    await queryClient.invalidateQueries({ queryKey: ["treatments"] });
  }

  // Table buttons: same write path, error shown inline above the table (never an unhandled rejection).
  async function transition(row: TreatmentRow, next: TreatmentStatus) {
    setActionError(null);
    try {
      await saveStatus(row, next);
    } catch (err) {
      setActionError(`${row.patientName} — ${err instanceof Error ? err.message : "Could not save the change."}`);
    }
  }

  const openJourney = useCallback((row: TreatmentRow) => router.push(withFrom(`/journeys/${row.journeyId}`, "treatments")), [router]);

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="treatments-page">
      <Toolbar>
        <FilterBar data-testid="treatment-filters">
          <FilterSelect className={FILTER_CLASS} aria-label="Service" value={service} onChange={(e) => setFilters({ service: e.target.value, procedureId: "" })} data-testid="treatment-filter-service">
            <option value="">All services</option>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </FilterSelect>
          <FilterSelect className={FILTER_CLASS} aria-label="Procedure" value={procedureId} onChange={(e) => setFilters({ procedureId: e.target.value })} data-testid="treatment-filter-procedure">
            <option value="">All procedures</option>
            {procedures.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </FilterSelect>
          <FilterSelect className={FILTER_CLASS} aria-label="State" value={status} onChange={(e) => setFilters({ status: e.target.value as TreatmentStatus | "" })} data-testid="treatment-filter-state">
            <option value="">All states</option>
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </FilterSelect>
          {(lookups.data?.doctors.length ?? 0) > 1 && (
          <FilterSelect className={FILTER_CLASS} aria-label="Doctor" value={doctorId} onChange={(e) => setFilters({ doctorId: e.target.value })} data-testid="treatment-filter-doctor">
            <option value="">All doctors</option>
            {(lookups.data?.doctors ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </FilterSelect>
          )}
          <PeriodSelect
            ariaLabel="Treatment date"
            value={dimension}
            options={[{ key: "scheduled", label: "Scheduled date" }, { key: "completed", label: "Completed date" }]}
            noneLabel="Any date"
            testId="treatment-date-dimension"
            onChange={(next) => void replaceUrlParams({ tdate: next || undefined, ...periodPatch({ range: undefined, from: undefined, to: undefined }, { prefix: "t", defaultRange: "" }) })}
          />
          {dimension && (
            <PeriodControls
              presets={DATE_PRESETS}
              value={{ range: period.range, from: dateSpan?.from, to: dateSpan?.to }}
              today={today}
              allowFuture={dimension === "scheduled"}
              maxSpanDays={366}
              label={dimension === "scheduled" ? "Scheduled in" : "Completed in"}
              testIdPrefix="treatment-date"
              onChange={(next) => void replaceUrlParams(periodPatch(next, { prefix: "t", defaultRange: "" }))}
            />
          )}
          <FilterSelect className={FILTER_CLASS} aria-label="Team Member" value={ownerId} onChange={(e) => setFilters({ ownerId: e.target.value })} data-testid="treatment-filter-owner">
            <option value="">All team members</option>
            {(lookups.data?.owners ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </FilterSelect>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clearFilters} data-testid="treatment-filters-clear">
              Clear filters
            </Button>
          )}
        </FilterBar>
      </Toolbar>

      {/* Summary + view switcher on their own row so the switcher never clips on a phone. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-2" data-testid="treatments-summary">
          {treatments.data ? `${rows.length} treatment${rows.length === 1 ? "" : "s"}${showValue ? ` · ${formatInr(totalValue)} est. value` : ""}` : "\u00a0"}
        </span>
        <ViewSwitcher<TreatmentView> ariaLabel="Treatments view" value={view} onChange={setView} options={VIEW_OPTIONS} />
      </div>

      {actionError && (
        <p role="alert" className="flex items-start gap-2 rounded-card border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs font-medium text-danger-700" data-testid="treatment-action-error">
          <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">Not saved: {actionError}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setActionError(null)} className="-m-1 rounded p-1 hover:bg-danger-100">
            <X size={14} aria-hidden="true" />
          </button>
        </p>
      )}

      {treatments.data && view === "table" && (
        <MetricStrip
          testId="treatment-pipeline-strip"
          anchorKey={status || undefined}
          cells={PIPELINE_STATUSES.map((s) => ({
            key: s,
            label: STATUS_LABEL[s],
            value: pipelineCounts[s] ?? 0,
            // Clicking the active state again clears it.
            onClick: () => setFilters({ status: status === s ? "" : s }),
            testId: `treatment-pipeline-${s}`,
          }))}
        />
      )}

      {view !== "table" && treatments.isLoading && <Skeleton className="h-96" />}
      {view !== "table" && treatments.isError && <ErrorState message="Could not load treatments." />}
      {view === "pipeline" && treatments.data && (
        <TreatmentPipelineBoard rows={rows} showValue={showValue} timeZone={timeZone} onOpen={openJourney} onMove={canManage ? saveStatus : undefined} />
      )}
      {view === "calendar" && treatments.data && (
        <ProcedureCalendar
          rows={rows}
          stateFilter={status}
          mode={calendarMode}
          date={date}
          onDateChange={setDate}
          onModeChange={setCalendarMode}
          onOpen={openJourney}
        />
      )}

      {view === "table" && (
      <TableShell maxHeight="40rem">
        {treatments.isLoading && <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
        {treatments.isError && <ErrorState message="Could not load treatments." />}
        {treatments.data && rows.length === 0 && (
          <EmptyState
            message="No treatments match these filters."
            hint="Treatments appear here when a consultation outcome advises one."
            action={filtersActive ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
          />
        )}
        {rows.length > 0 && (
          <Table className="min-w-[1000px]">
            <TableHead sticky>
              <tr>
                <Th leading>Patient</Th>
                <Th>Journey / service</Th>
                <Th>Treatment</Th>
                {showValue && <Th align="right">Value</Th>}
                <Th>Doctor</Th>
                <Th>Team Member</Th>
                <Th>State</Th>
                <Th>Next action</Th>
                <Th>Actions</Th>
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const steps = NEXT_STEPS[row.status];
                return (
                  <Tr key={row.id} onClick={() => openJourney(row)} data-testid={`treatment-row-${row.id}`}>
                    <Td leading nowrap>
                      <Link
                        href={withFrom(`/patients/${row.patientId}`, "treatments")}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-ink hover:text-primary-700 hover:underline"
                      >
                        {row.patientName}
                      </Link>
                    </Td>
                    <Td nowrap>
                      <Link
                        href={withFrom(`/journeys/${row.journeyId}`, "treatments")}
                        onClick={(e) => e.stopPropagation()}
                        className="text-ink-2 hover:text-primary-700 hover:underline"
                        data-testid={`treatment-journey-link-${row.id}`}
                      >
                        {row.service ?? "Journey"}
                      </Link>
                    </Td>
                    <Td className="text-ink" nowrap>{row.treatmentLabel}</Td>
                    {showValue && <Td align="right" className="text-ink">{formatInr(row.estimatedValue)}</Td>}
                    <Td className="text-ink-2" nowrap>{treatmentDoctorLabel(row)}</Td>
                    <Td className="text-ink-2" nowrap>{row.ownerName ?? "—"}</Td>
                    <Td nowrap>
                      <span className="flex flex-col items-start gap-0.5">
                        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                        {(() => {
                          const line = treatmentDateLine(row, fmtDate);
                          return line && <span className={`text-[11px] ${line.recorded ? "text-ink-2" : "text-ink-2/80 italic"}`} data-testid={`treatment-date-${row.id}`}>{line.label} {line.text}</span>;
                        })()}
                      </span>
                    </Td>
                    <Td className="text-ink-2" nowrap>{fmtDate(row.nextActionDueAt)}</Td>
                    <Td onClick={(e) => e.stopPropagation()}>
                      {canManage && steps && (
                        <div className="flex items-center gap-1">
                          <Button size="sm" onClick={() => transition(row, steps.primary.status)} data-testid={`treatment-${row.id}-${steps.primary.status}`}>
                            {steps.primary.label}
                          </Button>
                          <OverflowMenu
                            testId={`treatment-${row.id}-more`}
                            items={steps.secondary.map((s) => ({
                              key: s.status,
                              label: s.label,
                              danger: s.danger,
                              onClick: () => (s.danger ? setConfirming({ row, status: s.status, label: s.label }) : transition(row, s.status)),
                            }))}
                          />
                        </div>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableShell>
      )}

      <ConfirmDialog
        open={!!confirming}
        title={confirming ? `${confirming.label} this treatment?` : ""}
        description={
          confirming
            ? `${confirming.row.patientName}'s "${confirming.row.treatmentLabel}" ${showValue ? `(${formatInr(confirming.row.estimatedValue)}) ` : ""}moves out of the active pipeline and off every conversion count. This can't be undone from here — a declined treatment isn't re-offered automatically.`
            : ""
        }
        confirmLabel={confirming?.label ?? "Confirm"}
        onConfirm={() => {
          if (confirming) transition(confirming.row, confirming.status);
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
