"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { LifeBuoy } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, EmptyState, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import type { PlatformTenantDetail } from "@pulseos/types";
import { ErrorPanel, TableSkeleton, fmtAgo, fmtWhen } from "../ui";
import { usePlatformUser } from "../usePlatformUser";

/** Every support session for this hospital: who, why, how long, and whether edits were enabled. */
export function TenantSupportTab({ detail }: { detail: PlatformTenantDetail }) {
  const { can } = usePlatformUser();
  const q = useQuery({ queryKey: ["platform", "support", { tenantId: detail.tenant.id }], queryFn: () => platformApi.supportSessions({ tenantId: detail.tenant.id, pageSize: 50 }) });
  return (
    <Panel
      title="Support"
      subtitle="Support sessions for this hospital"
      padded={false}
      data-testid="tenant-support"
      action={
        can("START_SUPPORT_SESSION") && (
          <Link href={`/platform/support?tenant=${detail.tenant.id}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-primary-600 px-3 text-xs font-medium text-white hover:bg-primary-700 sm:min-h-8">
            <LifeBuoy size={14} /> Open as support
          </Link>
        )
      }
    >
      {q.isError ? (
        <div className="p-4">
          <ErrorPanel error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : !q.data ? (
        <TableSkeleton cols={5} />
      ) : q.data.rows.length === 0 ? (
        <EmptyState message="No support sessions for this hospital" />
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHead>
              <tr>
                <Th leading>Staff member</Th>
                <Th>Reason</Th>
                <Th>Started</Th>
                <Th>Ended</Th>
                <Th>Edits</Th>
                <Th>Status</Th>
              </tr>
            </TableHead>
            <TableBody>
              {q.data.rows.map((s) => (
                <Tr key={s.id}>
                  <Td leading>{s.staffName}</Td>
                  <Td nowrap={false}>
                    <span className="line-clamp-2 max-w-[320px]">{s.reason}</span>
                  </Td>
                  <Td>{fmtAgo(s.startedAt)}</Td>
                  <Td>{fmtWhen(s.endedAt ?? s.expiresAt)}</Td>
                  <Td>{s.writeReason ? <Badge tone="warning">Enabled</Badge> : <span className="text-ink-2">Read-only</span>}</Td>
                  <Td>
                    <Badge tone={s.active ? "primary" : "neutral"}>{s.active ? "Active" : s.endedAt ? "Ended" : "Expired"}</Badge>
                  </Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
