"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, EmptyState, FilterSelect, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { PLAN_META, TENANT_STATUSES, TENANT_STATUS_LABEL, type Edition, type PlatformTenantQuery, type TenantEnvironment, type TenantStatus } from "@pulseos/types";
import { useUrlFilters } from "../../../../lib/useUrlFilters";
import { EnvironmentBadge, ErrorPanel, Pager, PlatformFilters, PlatformPage, SearchBox, TableSkeleton, TenantStatusBadge, fmtAgo, fmtDay } from "../../../../components/platform/ui";
import { RowMenu } from "../../../../components/platform/RowMenu";
import { usePlatformUser } from "../../../../components/platform/usePlatformUser";

const PAGE_SIZE = 25;

function TenantsDirectory() {
  const router = useRouter();
  const { can } = usePlatformUser();
  const { get, set } = useUrlFilters();
  const query: PlatformTenantQuery = {
    q: get("q") || undefined,
    status: (get("status") || undefined) as TenantStatus | undefined,
    edition: (get("edition") || undefined) as Edition | undefined,
    industry: get("industry") || undefined,
    environment: (get("environment") || undefined) as TenantEnvironment | undefined,
    health: (get("health") || undefined) as PlatformTenantQuery["health"],
    createdFrom: get("from") || undefined,
    createdTo: get("to") || undefined,
    sort: (get("sort") || "created") as PlatformTenantQuery["sort"],
    dir: (get("dir") || "desc") as "asc" | "desc",
    page: Number(get("page")) || 1,
    pageSize: PAGE_SIZE,
  };
  const list = useQuery({ queryKey: ["platform", "tenants", query], queryFn: () => platformApi.tenants(query), placeholderData: keepPreviousData });
  const industries = useQuery({ queryKey: ["platform", "tenant-industries"], queryFn: platformApi.tenantIndustries, staleTime: 300_000 });
  const filtered = !!(query.q || query.status || query.edition || query.industry || query.environment || query.health || query.createdFrom || query.createdTo);
  const setFilter = (patch: Record<string, string | undefined>) => set({ ...patch, page: undefined });

  function copyLink(slug: string) {
    void navigator.clipboard?.writeText(`${window.location.origin}/login/${slug}`);
  }

  return (
    <PlatformPage
      title="Tenants"
      subtitle="Every PulseOS client workspace. Search, filters and paging run on the server."
      testId="platform-tenants"
      actions={
        can("CREATE_TENANT") && (
          <Button variant="primary" onClick={() => router.push("/platform/tenants/new")} data-testid="create-tenant">
            <Plus size={15} /> Create tenant
          </Button>
        )
      }
    >
      <PlatformFilters>
        <SearchBox value={query.q ?? ""} onChange={(v) => setFilter({ q: v || undefined })} placeholder="Name, slug or admin email" label="Search tenants" testId="tenant-search" />
        <FilterSelect aria-label="Status" value={query.status ?? ""} onChange={(e) => setFilter({ status: e.target.value || undefined })} data-testid="filter-status">
          <option value="">All statuses</option>
          {TENANT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TENANT_STATUS_LABEL[s].label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Plan" value={query.edition ?? ""} onChange={(e) => setFilter({ edition: e.target.value || undefined })} data-testid="filter-plan">
          <option value="">All plans</option>
          {(Object.keys(PLAN_META) as Edition[]).map((e) => (
            <option key={e} value={e}>
              {PLAN_META[e].name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Industry" value={query.industry ?? ""} onChange={(e) => setFilter({ industry: e.target.value || undefined })}>
          <option value="">All industries</option>
          {(industries.data?.industries ?? []).map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Integration health" value={query.health ?? ""} onChange={(e) => setFilter({ health: e.target.value || undefined })} data-testid="filter-health">
          <option value="">Any integration health</option>
          <option value="healthy">Healthy</option>
          <option value="attention">Needs attention</option>
          <option value="not_configured">Nothing configured</option>
        </FilterSelect>
        <FilterSelect aria-label="Environment" value={query.environment ?? ""} onChange={(e) => setFilter({ environment: e.target.value || undefined })}>
          <option value="">All environments</option>
          <option value="PRODUCTION">Production</option>
          <option value="DEMO">Demo</option>
          <option value="TEST">Test</option>
        </FilterSelect>
        <div className="col-span-2 flex min-w-0 items-center gap-1 text-xs text-ink-2">
          <span className="shrink-0">Created</span>
          <input type="date" aria-label="Created from" value={query.createdFrom ?? ""} onChange={(e) => setFilter({ from: e.target.value || undefined })} className="glass-control h-11 min-w-0 flex-1 rounded-control px-2 text-xs sm:h-8 sm:w-36 sm:flex-none" />
          <span aria-hidden="true">–</span>
          <input type="date" aria-label="Created to" value={query.createdTo ?? ""} onChange={(e) => setFilter({ to: e.target.value || undefined })} className="glass-control h-11 min-w-0 flex-1 rounded-control px-2 text-xs sm:h-8 sm:w-36 sm:flex-none" />
        </div>
        <FilterSelect
          aria-label="Sort"
          value={`${query.sort}:${query.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":");
            setFilter({ sort, dir });
          }}
        >
          <option value="created:desc">Newest first</option>
          <option value="created:asc">Oldest first</option>
          <option value="name:asc">Name A–Z</option>
          <option value="lastActivity:desc">Recently active</option>
          <option value="status:asc">Status</option>
        </FilterSelect>
        {filtered && (
          <Button size="sm" variant="ghost" onClick={() => set({ q: undefined, status: undefined, edition: undefined, industry: undefined, environment: undefined, health: undefined, from: undefined, to: undefined, page: undefined })}>
            Clear filters
          </Button>
        )}
      </PlatformFilters>

      {list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line surface-content shadow-panel" data-testid="tenant-table">
          {!list.data ? (
            <TableSkeleton cols={6} />
          ) : list.data.rows.length === 0 ? (
            filtered ? (
              <EmptyState message="No tenants match these filters" hint="Try a different search or clear the filters." />
            ) : (
              <EmptyState message="No tenants yet" hint="Create the first client workspace to get started." action={can("CREATE_TENANT") ? <Button variant="primary" onClick={() => router.push("/platform/tenants/new")}>Create tenant</Button> : undefined} />
            )
          ) : (
            <>
              <div className="overflow-x-auto" aria-busy={list.isFetching}>
                <Table className="min-w-[1100px]">
                  <TableHead>
                    <tr>
                      <Th leading>Tenant</Th>
                      <Th>Status</Th>
                      <Th>Plan</Th>
                      <Th>Industry</Th>
                      <Th>Primary admin</Th>
                      <Th align="right">Users</Th>
                      <Th align="right">Branches</Th>
                      <Th align="right">Modules</Th>
                      <Th>Integrations</Th>
                      <Th>Created</Th>
                      <Th>Last activity</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {list.data.rows.map((t) => (
                      <Tr key={t.id} onClick={() => router.push(`/platform/tenants/${t.id}`)} data-testid={`tenant-row-${t.loginSlug ?? t.id}`}>
                        <Td leading nowrap={false}>
                          <Link href={`/platform/tenants/${t.id}`} onClick={(e) => e.stopPropagation()} className="block max-w-[260px] truncate text-[13px] font-semibold text-ink hover:text-primary-700" title={t.name}>
                            {t.name}
                          </Link>
                          <span className="flex items-center gap-1.5 text-[11px] text-ink-2">
                            <span className="truncate font-mono">{t.loginSlug ?? "no sign-in page"}</span>
                            <EnvironmentBadge environment={t.environment} />
                          </span>
                        </Td>
                        <Td>
                          <TenantStatusBadge status={t.status} />
                        </Td>
                        <Td>{PLAN_META[t.edition].name}</Td>
                        <Td>{t.industry ?? "—"}</Td>
                        <Td nowrap={false}>
                          {t.primaryAdmin ? (
                            <span className="block max-w-[200px]">
                              <span className="block truncate">{t.primaryAdmin.name}</span>
                              <span className="block truncate text-[11px] text-ink-2" title={t.primaryAdmin.email}>
                                {t.primaryAdmin.email}
                              </span>
                            </span>
                          ) : (
                            <span className="text-ink-2">None</span>
                          )}
                        </Td>
                        <Td align="right">{t.users}</Td>
                        <Td align="right">{t.branches}</Td>
                        <Td align="right">
                          {t.modules.enabled}/{t.modules.total}
                        </Td>
                        <Td>
                          <span className="flex items-center gap-1.5">
                            <span>{t.integrations.configured} configured</span>
                            {t.integrations.attention > 0 && <Badge tone="warning">{t.integrations.attention} need attention</Badge>}
                          </span>
                        </Td>
                        <Td>{fmtDay(t.createdAt)}</Td>
                        <Td>{fmtAgo(t.lastActivityAt)}</Td>
                        <Td>
                          <RowMenu
                            label={`More actions for ${t.name}`}
                            items={[
                              { key: "open", label: "Open tenant", onClick: () => router.push(`/platform/tenants/${t.id}`) },
                              { key: "users", label: "Users", onClick: () => router.push(`/platform/tenants/${t.id}?tab=users`) },
                              { key: "integrations", label: "Integrations", onClick: () => router.push(`/platform/tenants/${t.id}?tab=integrations`) },
                              ...(t.loginSlug ? [{ key: "copy", label: "Copy login link", onClick: () => copyLink(t.loginSlug!) }] : []),
                            ]}
                          />
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

export default function TenantsPage() {
  return (
    <Suspense fallback={null}>
      <TenantsDirectory />
    </Suspense>
  );
}
