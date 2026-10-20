"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, Lock, Minus } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { CAPABILITY_META, TENANT_STATUS_LABEL, type TenantStatus } from "@pulseos/types";
import { ErrorPanel, PlatformPage, TableSkeleton } from "../../../../components/platform/ui";

/** Plans are entitlement bundles (capability defaults). There is no pricing or billing in PulseOS yet, so none is shown. */
export default function PlansPage() {
  const q = useQuery({ queryKey: ["platform", "plans"], queryFn: platformApi.plans });
  return (
    <PlatformPage title="Plans & Capabilities" subtitle="Each plan is a default set of capabilities. Per-tenant overrides sit on top, and the API enforces the result on every request. Entitlements only — no billing." testId="platform-plans">
      {q.isError ? (
        <ErrorPanel error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <TableSkeleton rows={10} cols={3} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {q.data.plans.map((p) => (
              <Panel key={p.key} title={p.name} subtitle={p.label} data-testid={`plan-${p.key}`}>
                <p className="text-sm text-ink-2">{p.description}</p>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Capabilities</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums text-ink">
                      {p.capabilities.filter((c) => c.included).length}/{p.capabilities.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Tenants</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums text-ink">
                      <Link href={`/platform/tenants?edition=${p.key}`} className="hover:text-primary-700">
                        {p.tenants.total}
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">With overrides</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums text-ink">{p.tenantsWithOverrides}</dd>
                  </div>
                </dl>
                <p className="mt-3 flex flex-wrap gap-1">
                  {(Object.entries(p.tenants.byStatus) as [TenantStatus, number][]).map(([s, n]) => (
                    <Badge key={s}>
                      {TENANT_STATUS_LABEL[s].label}: {n}
                    </Badge>
                  ))}
                </p>
              </Panel>
            ))}
          </div>
          <Panel title="Capability defaults by plan" subtitle="Change a single tenant's capabilities on its Modules & Capabilities tab" padded={false} data-testid="plan-matrix">
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <TableHead>
                  <tr>
                    <Th leading>Capability</Th>
                    {q.data.plans.map((p) => (
                      <Th key={p.key} align="center">
                        {p.name}
                      </Th>
                    ))}
                    <Th>Needs</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {q.data.plans[0]!.capabilities.map((c) => (
                    <Tr key={c.key}>
                      <Td leading nowrap={false}>
                        <span className="flex items-center gap-1.5 font-medium">
                          {c.label}
                          {c.locked && <Lock size={12} className="text-ink-2" aria-label="Always on" />}
                        </span>
                        <span className="block max-w-md text-[11px] text-ink-2">{c.description}</span>
                      </Td>
                      {q.data.plans.map((p) => {
                        const inc = p.capabilities.find((x) => x.key === c.key)!.included;
                        return (
                          <Td key={p.key} align="center">
                            {inc ? <Check size={16} className="mx-auto text-accent-700" aria-label="Included" /> : <Minus size={16} className="mx-auto text-neutral-400" aria-label="Not included" />}
                          </Td>
                        );
                      })}
                      <Td nowrap={false}>{c.dependsOn.length ? c.dependsOn.map((d) => CAPABILITY_META[d].label).join(", ") : <span className="text-ink-2">—</span>}</Td>
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>
        </>
      )}
    </PlatformPage>
  );
}
