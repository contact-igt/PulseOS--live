"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@pulseos/api-client";
import { DATE_PRESETS, type DemographicDimension, type PerformanceBreakdownRow, type PerformanceDashboard } from "@pulseos/types";
import { EmptyState, ErrorState, FilterBar, FilterSelect, MetricStrip, Panel, Skeleton, Table, TableBody, TableHead, TableShell, Td, Th, Toolbar, Tr, formatKey, localDayKey } from "@pulseos/ui";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { parseFilters } from "@/components/analytics/filters";
import { withFrom } from "@/components/shell/BackLink";

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Super Admin", HOSPITAL_ADMIN: "Admin", FRONT_DESK: "Front Desk", PATIENT_COORDINATOR: "Coordinator", DOCTOR: "Doctor" };

/** The funnel as horizontal bars: how many enquiries reached each step, what share of the step before, and how many stopped. */
function Funnel({ data }: { data: PerformanceDashboard }) {
  const top = Math.max(data.funnel[0]?.count ?? 0, 1);
  return (
    <Panel title="Enquiry funnel" subtitle="Enquiries opened in the period, followed through to today" data-testid="perf-funnel">
      <ol className="space-y-2.5">
        {data.funnel.map((s, i) => (
          <li key={s.key} data-testid={`perf-funnel-${s.key}`}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-ink">{s.label}</span>
              <span className="tabular-nums text-ink">
                <strong className="text-sm font-semibold">{s.count}</strong>
                {s.conversionFromPrevious !== null && <span className="ml-2 text-ink-2">{s.conversionFromPrevious}% of previous</span>}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-primary-100" aria-hidden="true">
              <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.max((s.count / top) * 100, s.count > 0 ? 2 : 0)}%` }} />
            </div>
            {i > 0 && s.droppedBefore > 0 && <p className="mt-0.5 text-[11px] text-ink-2">{s.droppedBefore} did not reach this step</p>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Who is enquiring: one small list-with-bars per dimension that really has answers (age group, then the hospital's filterable fields). */
function Demographics({ dimensions }: { dimensions: DemographicDimension[] }) {
  if (dimensions.length === 0) return null; // nothing recorded yet: no empty charts
  return (
    <Panel title="Who is enquiring" subtitle="From what was recorded for this period's enquiries. Age group is worked out from date of birth or reported age." data-testid="perf-demographics">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
        {dimensions.map((d) => (
          <section key={d.key} aria-label={d.label} data-testid={`perf-demo-${d.key}`}>
            <h3 className="flex items-baseline justify-between gap-2 text-xs font-semibold text-ink">
              {d.label}
              <span className="font-normal text-ink-2">{d.answered} answered</span>
            </h3>
            <ul className="mt-2 space-y-1.5">
              {d.rows.map((r) => (
                <li key={r.label} className="text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-ink">{r.label}</span>
                    <span className="shrink-0 tabular-nums text-ink-2">{r.count} · {r.pct}%</span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-primary-50" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary-500" style={{ width: `${r.pct}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}

function BreakdownTable({ title, subtitle, rows, testId, nameHeader }: { title: string; subtitle: string; rows: PerformanceBreakdownRow[]; testId: string; nameHeader: string }) {
  return (
    <Panel title={title} subtitle={subtitle} padded={false} data-testid={testId}>
      {rows.length === 0 ? (
        <EmptyState message="No enquiries in this period" />
      ) : (
        <TableShell className="border-0 shadow-none">
          <Table className="min-w-[600px]">
            <TableHead>
              <tr>
                <Th leading>{nameHeader}</Th>
                <Th align="right">Enquiries</Th>
                <Th align="right">Booked</Th>
                <Th align="right">Visited</Th>
                <Th align="right">Consulted</Th>
                <Th align="right">Advised</Th>
                <Th align="right">Scheduled</Th>
                <Th align="right">Done</Th>
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <Tr key={r.key} data-testid={`${testId}-row-${r.key}`}>
                  <Td leading className="font-medium text-ink">{r.label}</Td>
                  <Td align="right" className="tabular-nums">{r.enquiries}</Td>
                  <Td align="right" className="tabular-nums">{r.booked}</Td>
                  <Td align="right" className="tabular-nums">{r.attended}</Td>
                  <Td align="right" className="tabular-nums">{r.consulted}</Td>
                  <Td align="right" className="tabular-nums">{r.advised}</Td>
                  <Td align="right" className="tabular-nums">{r.scheduled}</Td>
                  <Td align="right" className="tabular-nums">{r.done}</Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        </TableShell>
      )}
    </Panel>
  );
}

/**
 * The owner's Performance view: how enquiries move through the clinic, where they stop, which source and service they came
 * from and what each team member did. Every number is counted from real rows for the chosen hospital-time period; the
 * findings and the alert are plain rules over those counts (labelled as such), not AI. No revenue appears here.
 */
export function PerformanceView() {
  const router = useRouter();
  const params = useSearchParams();
  const url = useUrlFilters();
  const tz = useHospitalTimeZone();
  const f = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);
  const todayKey = localDayKey(new Date(), tz);
  const period = { range: f.range, from: f.from, to: f.to };
  const scope = { branchId: f.branchId, journeyType: f.service };

  const branches = useQuery({ queryKey: ["branches"], queryFn: api.branches });
  const journeyTypes = useQuery({ queryKey: ["journey-types"], queryFn: api.journeyTypes });
  const perf = useQuery({ queryKey: ["dashboard", "performance", period, scope], queryFn: () => api.performance({ ...scope, ...period }) });

  const presetLabel = DATE_PRESETS.find((p) => p.key === f.range)?.label ?? "Last 30 days";
  const day = (k: string) => formatKey(k, { day: "numeric", month: "short" });
  const periodLabel = perf.data?.period ? `${presetLabel} · ${day(perf.data.period.from)} – ${day(perf.data.period.to)}` : presetLabel;

  return (
    <div className="space-y-4 lg:space-y-5" data-testid="performance-view">
      <Toolbar
        actions={
          <FilterBar data-testid="filter-bar" className="w-full sm:w-auto">
            <PeriodControls
              presets={DATE_PRESETS}
              maxSpanDays={366}
              value={period}
              today={todayKey}
              onChange={(next) => url.set({ range: next.range === "30d" ? undefined : next.range, from: next.range === "custom" ? next.from : undefined, to: next.range === "custom" ? next.to : undefined })}
              testIdPrefix="perf"
              label="Period"
            />
            {(branches.data?.length ?? 0) > 1 && (
            <FilterSelect value={f.branchId ?? ""} onChange={(e) => url.set({ branch: e.target.value || undefined })} aria-label="Branch" data-testid="perf-filter-branch" className="max-md:[&_select]:h-11">
              <option value="">All branches</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </FilterSelect>
            )}
            <FilterSelect value={f.service ?? ""} onChange={(e) => url.set({ service: e.target.value || undefined })} aria-label="Service" data-testid="perf-filter-service" className="max-md:[&_select]:h-11">
              <option value="">All services</option>
              {journeyTypes.data?.map((t) => <option key={t} value={t}>{t}</option>)}
            </FilterSelect>
          </FilterBar>
        }
      >
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-ink">Performance</h2>
          <p className="text-xs text-ink-2" data-testid="perf-period-caption">{periodLabel} · enquiries opened in the period, followed through to today</p>
        </div>
      </Toolbar>

      {perf.isLoading && <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-72" /></div>}
      {perf.isError && <ErrorState message="Could not load performance." />}

      {perf.data && (
        <>
          {perf.data.alert && (
            <div role="status" className="flex items-start gap-2 rounded-card border border-warning-500/30 bg-warning-100 px-3 py-2.5 text-xs text-warning-700" data-testid="perf-alert">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <strong className="font-semibold">{perf.data.alert.message}.</strong> <span>{perf.data.alert.detail}.</span>{" "}
                <span className="whitespace-nowrap rounded-chip bg-white/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">{perf.data.alert.label}</span>
              </span>
            </div>
          )}

          <MetricStrip
            testId="perf-kpis"
            cells={[
              { key: "enquiries", label: "Enquiries", value: perf.data.kpis.enquiries },
              { key: "booked", label: "Booked", value: perf.data.kpis.booked },
              { key: "attended", label: "Visits attended", value: perf.data.kpis.attended },
              { key: "consulted", label: "Consultations done", value: perf.data.kpis.consulted },
              { key: "noshows", label: "No-shows", value: perf.data.kpis.noShows },
              { key: "advised", label: "Procedure advised", value: perf.data.kpis.advised },
              { key: "scheduled", label: "Procedure scheduled", value: perf.data.kpis.scheduled },
              { key: "done", label: "Procedures done", value: perf.data.kpis.done },
              { key: "conversion", label: "Enquiry → procedure done", value: perf.data.kpis.conversionRate === null ? "—" : `${perf.data.kpis.conversionRate}%` },
            ]}
          />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] xl:gap-5">
            <Funnel data={perf.data} />
            <Panel title="Needs attention" subtitle="Rule-based, from the counts above" data-testid="perf-insights">
              {perf.data.insights.length === 0 ? (
                <EmptyState message="Nothing needs attention right now" />
              ) : (
                <ul className="divide-y divide-line">
                  {perf.data.insights.map((i) => (
                    <li key={i.key} data-testid={`perf-insight-${i.key}`}>
                      <button
                        type="button"
                        onClick={() => router.push(withFrom(i.href, "command-centre"))}
                        className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left text-sm text-ink hover:text-primary-700"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${i.severity === "attention" ? "bg-warning-500" : "bg-neutral-300"}`} aria-hidden="true" />
                          <span className="min-w-0">{i.message}</span>
                        </span>
                        <ArrowRight size={14} className="shrink-0 text-ink-2" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-5">
            <BreakdownTable title="By original source" subtitle="Where each enquiry first came from" rows={perf.data.sources} testId="perf-sources" nameHeader="Source" />
            <BreakdownTable title="By service" subtitle="What they enquired about" rows={perf.data.services} testId="perf-services" nameHeader="Service" />
          </div>

          <Demographics dimensions={perf.data.demographics} />

          <Panel title="Team" subtitle="Enquiries owned, calls logged and follow-ups done in the period" padded={false} data-testid="perf-team">
            <TableShell className="border-0 shadow-none">
              <Table className="min-w-[640px]">
                <TableHead>
                  <tr>
                    <Th leading>Name</Th>
                    <Th>Role</Th>
                    <Th align="right">Enquiries owned</Th>
                    <Th align="right">Reached</Th>
                    <Th align="right">Booked</Th>
                    <Th align="right">Calls logged</Th>
                    <Th align="right">Follow-ups done</Th>
                    <Th align="right">Overdue now</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {perf.data.staff.map((s) => (
                    <Tr key={s.userId} data-testid={`perf-team-row-${s.userId}`}>
                      <Td leading className="font-medium text-ink">{s.name}</Td>
                      <Td className="text-ink-2">{ROLE_LABEL[s.role] ?? s.role}</Td>
                      <Td align="right" className="tabular-nums">{s.owned}</Td>
                      <Td align="right" className="tabular-nums">{s.contacted}</Td>
                      <Td align="right" className="tabular-nums">{s.booked}</Td>
                      <Td align="right" className="tabular-nums">{s.callsLogged}</Td>
                      <Td align="right" className="tabular-nums">{s.followUpsDone}</Td>
                      <Td align="right" className={`tabular-nums ${s.overdueNow > 0 ? "font-medium text-danger-700" : ""}`}>{s.overdueNow}</Td>
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            </TableShell>
          </Panel>
          <p className="px-1 text-[11px] text-ink-2">
            Counts come from your own leads, appointments and follow-ups. Looking for a list? <Link href="/leads" className="font-medium text-primary-700 hover:underline">Open Leads</Link>.
          </p>
        </>
      )}
    </div>
  );
}
