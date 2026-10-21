"use client";

import { Fragment, Suspense, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, EmptyState, FilterSelect, Table, TableBody, TableHead, Tabs, Td, Th, Tr } from "@pulseos/ui";
import { useUrlFilters } from "../../../../lib/useUrlFilters";
import { ErrorPanel, NoAccess, Pager, PlatformFilters, PlatformPage, SearchBox, TableSkeleton, fmtWhen } from "../../../../components/platform/ui";
import { usePlatformUser } from "../../../../components/platform/usePlatformUser";

const OUTCOME = { SUCCESS: { label: "Success", tone: "neutral" }, DENIED: { label: "Denied", tone: "danger" }, FAILURE: { label: "Failed", tone: "warning" } } as const;
const CONTEXT = { PLATFORM: "Console", SUPPORT_MODE: "Support Mode", SYSTEM: "System" } as const;

/** Every company-side action, append-only. Secret values are never recorded; the metadata shown is already scrubbed. */
function Audit() {
  const { can } = usePlatformUser();
  const { get, set } = useUrlFilters();
  const security = get("security") === "1";
  const q = {
    q: get("q") || undefined,
    outcome: (get("outcome") || undefined) as "SUCCESS" | "DENIED" | "FAILURE" | undefined,
    context: (get("context") || undefined) as "PLATFORM" | "SUPPORT_MODE" | "SYSTEM" | undefined,
    tenantId: get("tenant") || undefined,
    from: get("from") || undefined,
    to: get("to") || undefined,
    security: security ? ("true" as const) : undefined,
    page: Number(get("page")) || 1,
    pageSize: 50,
  };
  const list = useQuery({ queryKey: ["platform", "audit", q], queryFn: () => platformApi.audit(q), placeholderData: keepPreviousData, enabled: can("VIEW_AUDIT") });
  const [open, setOpen] = useState<string | null>(null);
  const filtered = !!(q.q || q.outcome || q.context || q.tenantId || q.from || q.to);

  if (!can("VIEW_AUDIT"))
    return (
      <PlatformPage title="Audit & Security">
        <NoAccess what="the audit trail" />
      </PlatformPage>
    );

  return (
    <PlatformPage title="Audit & Security" subtitle="Every company-side action, in order. Append-only: nobody can edit or delete an entry. Secret values are never recorded." testId="platform-audit">
      <Tabs
        variant="underline"
        ariaLabel="Audit view"
        value={security ? "security" : "all"}
        onChange={(k) => set({ security: k === "security" ? "1" : undefined, page: undefined })}
        items={[
          { key: "all", label: "All events" },
          { key: "security", label: "Security events", testId: "tab-security" },
        ]}
      />
      <PlatformFilters>
        <SearchBox value={q.q ?? ""} onChange={(v) => set({ q: v || undefined, page: undefined })} placeholder="Action, person or summary" label="Search the audit trail" testId="audit-search" />
        <FilterSelect aria-label="Outcome" value={q.outcome ?? ""} onChange={(e) => set({ outcome: e.target.value || undefined, page: undefined })}>
          <option value="">Any outcome</option>
          <option value="SUCCESS">Success</option>
          <option value="DENIED">Denied</option>
          <option value="FAILURE">Failed</option>
        </FilterSelect>
        <FilterSelect aria-label="Context" value={q.context ?? ""} onChange={(e) => set({ context: e.target.value || undefined, page: undefined })}>
          <option value="">Any context</option>
          <option value="PLATFORM">Console</option>
          <option value="SUPPORT_MODE">Support Mode</option>
          <option value="SYSTEM">System</option>
        </FilterSelect>
        <div className="col-span-2 flex min-w-0 items-center gap-1 text-xs text-ink-2">
          <span className="shrink-0">From</span>
          <input type="date" aria-label="From" value={q.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined, page: undefined })} className="glass-control h-11 min-w-0 flex-1 rounded-control px-2 text-xs sm:h-8 sm:w-36 sm:flex-none" />
          <span>to</span>
          <input type="date" aria-label="To" value={q.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined, page: undefined })} className="glass-control h-11 min-w-0 flex-1 rounded-control px-2 text-xs sm:h-8 sm:w-36 sm:flex-none" />
        </div>
      </PlatformFilters>
      {list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line surface-content shadow-panel" data-testid="audit-table">
          {!list.data ? (
            <TableSkeleton cols={5} />
          ) : list.data.rows.length === 0 ? (
            <EmptyState message={filtered ? "No audit events match these filters" : security ? "No security events" : "No audit events yet"} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[900px]">
                  <TableHead>
                    <tr>
                      <Th leading>When (IST)</Th>
                      <Th>What</Th>
                      <Th>Who</Th>
                      <Th>Context</Th>
                      <Th>Outcome</Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {list.data.rows.map((e) => (
                      <Fragment key={e.id}>
                        <Tr onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id} data-testid={`audit-row-${e.action}`}>
                          <Td leading>
                            <span className="flex items-center gap-1">
                              {open === e.id ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                              {fmtWhen(e.at)}
                            </span>
                          </Td>
                          <Td nowrap={false} className="min-w-[260px]">
                            <span className="block text-ink">{e.summary}</span>
                            <span className="block font-mono text-[11px] text-ink-2">{e.action}</span>
                          </Td>
                          <Td nowrap={false}>
                            <span className="block max-w-[220px] truncate" title={e.actor}>
                              {e.actor}
                            </span>
                          </Td>
                          <Td>{e.context === "SUPPORT_MODE" ? <Badge tone="primary">Support Mode</Badge> : CONTEXT[e.context]}</Td>
                          <Td>
                            <Badge tone={OUTCOME[e.outcome].tone}>{OUTCOME[e.outcome].label}</Badge>
                          </Td>
                        </Tr>
                        {open === e.id && (
                          <tr className="bg-surface-muted/60">
                            <td colSpan={5} className="px-4 py-3 text-xs">
                              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                                {e.reason && (
                                  <div className="sm:col-span-2">
                                    <dt className="font-medium text-ink">Reason</dt>
                                    <dd className="text-ink-2">{e.reason}</dd>
                                  </div>
                                )}
                                <div>
                                  <dt className="font-medium text-ink">Target</dt>
                                  <dd className="break-all text-ink-2">
                                    {e.targetType ?? "—"} {e.targetId ?? ""}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="font-medium text-ink">Tenant</dt>
                                  <dd className="text-ink-2">{e.tenantId ? <Link href={`/platform/tenants/${e.tenantId}`} className="text-primary-700 hover:underline">Open tenant</Link> : "—"}</dd>
                                </div>
                                <div>
                                  <dt className="font-medium text-ink">Request</dt>
                                  <dd className="break-all text-ink-2">
                                    {e.ipAddress ?? "—"} · {e.userAgent ?? "—"}
                                  </dd>
                                </div>
                                <div className="sm:col-span-2">
                                  <dt className="font-medium text-ink">Details (scrubbed)</dt>
                                  <dd>
                                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control bg-white p-2 font-mono text-[11px] text-ink-2">{JSON.stringify(e.metadata, null, 2)}</pre>
                                  </dd>
                                </div>
                              </dl>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />
            </>
          )}
        </div>
      )}
    </PlatformPage>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={null}>
      <Audit />
    </Suspense>
  );
}
