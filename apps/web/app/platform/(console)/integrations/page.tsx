"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { EmptyState, FilterSelect, MetricStrip, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { useUrlFilters } from "../../../../lib/useUrlFilters";
import { ConfigurationBadge, CredentialBadge, EnabledBadge, HealthBadge, MODE_LABEL } from "../../../../components/platform/integrationLabels";
import { EnvironmentBadge, ErrorPanel, Pager, PlatformFilters, PlatformPage, TableSkeleton, fmtAgo } from "../../../../components/platform/ui";

function Integrations() {
  const router = useRouter();
  const { get, set } = useUrlFilters();
  const q = { connector: get("connector") || undefined, bucket: (get("bucket") || undefined) as "healthy" | "attention" | "not_configured" | undefined, tenantId: get("tenant") || undefined, page: Number(get("page")) || 1, pageSize: 50 };
  const list = useQuery({ queryKey: ["platform", "integrations", q], queryFn: () => platformApi.integrations(q), placeholderData: keepPreviousData });
  const t = list.data?.totals;

  return (
    <PlatformPage title="Integrations" subtitle="Every hospital's connectors. Enabled, configured, credentials, activity and health are separate facts; credentials are never shown." testId="platform-integrations">
      {t && (
        <MetricStrip
          layout="inline"
          ariaLabel="Integration health"
          activeKey={q.bucket ?? "all"}
          cells={[
            { key: "all", label: "Switched on or set up", value: t.all, onClick: () => set({ bucket: undefined, page: undefined }) },
            { key: "healthy", label: "Healthy", value: t.healthy, onClick: () => set({ bucket: "healthy", page: undefined }) },
            { key: "attention", label: "Need attention", value: t.attention, attention: true, onClick: () => set({ bucket: "attention", page: undefined }) },
            { key: "not_configured", label: "Not configured", value: t.not_configured, onClick: () => set({ bucket: "not_configured", page: undefined }) },
          ]}
        />
      )}
      <PlatformFilters>
        <FilterSelect aria-label="Connector" value={q.connector ?? ""} onChange={(e) => set({ connector: e.target.value || undefined, page: undefined })} data-testid="filter-connector">
          <option value="">All connectors</option>
          {(list.data?.connectors ?? []).map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Health" value={q.bucket ?? ""} onChange={(e) => set({ bucket: e.target.value || undefined, page: undefined })}>
          <option value="">Any health</option>
          <option value="healthy">Healthy</option>
          <option value="attention">Needs attention</option>
          <option value="not_configured">Not configured</option>
        </FilterSelect>
      </PlatformFilters>
      {list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line surface-content shadow-panel" data-testid="integration-table">
          {!list.data ? (
            <TableSkeleton cols={7} />
          ) : list.data.rows.length === 0 ? (
            <EmptyState message={q.bucket === "attention" ? "No integration issues" : "No integrations match"} hint={q.bucket === "attention" ? "Every configured connection is reporting normally." : undefined} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[1100px]">
                  <TableHead>
                    <tr>
                      <Th leading>Tenant</Th>
                      <Th>Connector</Th>
                      <Th>Enabled</Th>
                      <Th>Configured</Th>
                      <Th>Credentials</Th>
                      <Th>Mode</Th>
                      <Th>Health</Th>
                      <Th>Last event</Th>
                      <Th>Attention</Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {list.data.rows.map((r) => (
                      <Tr key={`${r.tenantId}-${r.connector}`} onClick={() => router.push(`/platform/tenants/${r.tenantId}/integrations/${r.connector}`)} data-testid={`integration-${r.connector}-${r.tenantId}`}>
                        <Td leading nowrap={false}>
                          <Link href={`/platform/tenants/${r.tenantId}`} onClick={(e) => e.stopPropagation()} className="block max-w-[220px] truncate font-medium text-ink hover:text-primary-700">
                            {r.tenantName}
                          </Link>
                          <EnvironmentBadge environment={r.environment} />
                        </Td>
                        <Td>{r.connectorName}</Td>
                        <Td>
                          <EnabledBadge enabled={r.enabled} />
                        </Td>
                        <Td>
                          <ConfigurationBadge state={r.configuration} />
                        </Td>
                        <Td>
                          <CredentialBadge state={r.credentialState} />
                        </Td>
                        <Td>{MODE_LABEL[r.mode]}</Td>
                        <Td>
                          <HealthBadge health={r.health} />
                        </Td>
                        <Td>{r.lastEventAt ? fmtAgo(r.lastEventAt) : "Never"}</Td>
                        <Td nowrap={false}>
                          {r.attention ? (
                            <span className="flex max-w-[220px] items-start gap-1 text-xs font-medium text-warning-700">
                              <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
                              {r.attention}
                            </span>
                          ) : (
                            <span className="text-ink-2">—</span>
                          )}
                          {r.lastError && <span className="mt-0.5 block max-w-[240px] truncate text-[11px] text-ink-2" title={r.lastError}>{r.lastError}</span>}
                        </Td>
                      </Tr>
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

export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <Integrations />
    </Suspense>
  );
}
