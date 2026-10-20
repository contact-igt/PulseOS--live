"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { platformApi } from "@pulseos/api-client";
import { Badge, EmptyState, MetricStrip, Panel, Skeleton } from "@pulseos/ui";
import { Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { ErrorPanel, PlatformPage, TenantStatusBadge, fmtAgo, fmtDay } from "../../../components/platform/ui";

const OUTCOME_TONE = { SUCCESS: "neutral", DENIED: "danger", FAILURE: "warning" } as const;

export default function PlatformOverviewPage() {
  const router = useRouter();
  const q = useQuery({ queryKey: ["platform", "overview"], queryFn: platformApi.overview });

  return (
    <PlatformPage title="Overview" subtitle="Every PulseOS client, right now. Counts are live; nothing here is patient-level." testId="platform-overview">
      {q.isError ? (
        <ErrorPanel error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line sm:grid-cols-4" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="bg-surface px-4 py-3">
              <Skeleton className="h-5 w-12" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <MetricStrip
            testId="platform-kpis"
            ariaLabel="Platform totals"
            cells={[
              { key: "tenants", label: "Total tenants", value: q.data.tenants.total, onClick: () => router.push("/platform/tenants") },
              { key: "active", label: "Active", value: q.data.tenants.active, onClick: () => router.push("/platform/tenants?status=ACTIVE") },
              { key: "onboarding", label: "Draft & onboarding", value: q.data.tenants.onboarding, onClick: () => router.push("/platform/tenants?status=ONBOARDING") },
              { key: "suspended", label: "Suspended", value: q.data.tenants.suspended, attention: true, onClick: () => router.push("/platform/tenants?status=SUSPENDED") },
            ]}
          />
          <MetricStrip
            testId="platform-kpis-2"
            ariaLabel="Accounts and integrations"
            cells={[
              { key: "users", label: "Active users", value: q.data.activeUsers, onClick: () => router.push("/platform/users?status=ACTIVE") },
              { key: "invites", label: "Pending invitations", value: q.data.pendingInvitations, onClick: () => router.push("/platform/access") },
              { key: "integrations", label: "Configured integrations", value: q.data.configuredIntegrations, onClick: () => router.push("/platform/integrations") },
              { key: "attention", label: "Integrations needing attention", value: q.data.integrationsNeedingAttention, attention: true, onClick: () => router.push("/platform/integrations?bucket=attention") },
            ]}
          />

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Integrations needing attention" subtitle="Configured connections that are failing" padded={false} data-testid="overview-integration-issues">
              {q.data.integrationIssues.length === 0 ? (
                <EmptyState message="No integration issues" hint="Every configured connection is reporting normally." />
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {q.data.integrationIssues.map((i) => (
                    <li key={`${i.tenantId}-${i.integration}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <span className="min-w-0">
                        <Link href={`/platform/tenants/${i.tenantId}?tab=integrations`} className="font-medium text-ink hover:text-primary-700">
                          {i.tenantName}
                        </Link>
                        <span className="text-ink-2"> · {i.integration}</span>
                      </span>
                      <Badge tone="warning">{i.reason}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Onboarding" subtitle="Draft and onboarding tenants" padded={false} data-testid="overview-onboarding">
              {q.data.onboarding.length === 0 ? (
                <EmptyState message="No tenants are onboarding" hint="New tenants appear here until they are activated." />
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {q.data.onboarding.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <Link href={`/platform/tenants/${t.id}`} className="min-w-0 truncate font-medium text-ink hover:text-primary-700">
                        {t.name}
                      </Link>
                      <span className="flex items-center gap-2 text-xs text-ink-2">
                        Created {fmtDay(t.createdAt)} <TenantStatusBadge status={t.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Recent tenant activity" subtitle="Latest staff sign-in per hospital" padded={false} data-testid="overview-recent-activity">
              {q.data.recentActivity.length === 0 ? (
                <EmptyState message="No sign-ins yet" />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHead>
                      <tr>
                        <Th leading>Tenant</Th>
                        <Th>Status</Th>
                        <Th align="right">Active users</Th>
                        <Th>Last sign-in</Th>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {q.data.recentActivity.map((r) => (
                        <Tr key={r.tenantId} onClick={() => router.push(`/platform/tenants/${r.tenantId}`)}>
                          <Td leading>
                            <span className="font-medium">{r.tenantName}</span>
                          </Td>
                          <Td>
                            <TenantStatusBadge status={r.status} />
                          </Td>
                          <Td align="right">{r.activeUsers}</Td>
                          <Td>{fmtAgo(r.lastSignInAt)}</Td>
                        </Tr>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>

            <Panel title="Recent security & admin events" padded={false} action={<Link href="/platform/audit?security=1" className="text-xs font-medium text-primary-700 hover:underline">Audit & Security</Link>} data-testid="overview-security">
              {q.data.recentSecurity.length === 0 ? (
                <EmptyState message="No security events yet" />
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {q.data.recentSecurity.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-2.5">
                      <span className="min-w-0 flex-1 basis-48">
                        <span className="block text-sm text-ink">{e.summary}</span>
                        <span className="block truncate text-xs text-ink-2">{e.actor}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-ink-2">
                        {e.outcome !== "SUCCESS" && <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome === "DENIED" ? "Denied" : "Failed"}</Badge>}
                        {fmtAgo(e.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </PlatformPage>
  );
}
