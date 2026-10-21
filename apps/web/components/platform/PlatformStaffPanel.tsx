"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { Badge, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { platformRoleLabel } from "@pulseos/types";
import { AccountStatusBadge, ErrorPanel, TableSkeleton, fmtAgo } from "./ui";

/** Who has Platform Console access, with which role. Changes happen on each person's page (and are audited). */
export function PlatformStaffPanel() {
  const q = useQuery({ queryKey: ["platform", "staff"], queryFn: platformApi.staff });
  const owners = q.data?.staff.filter((s) => s.role === "PLATFORM_OWNER" && s.status === "ACTIVE").length ?? 0;
  return (
    <Panel title="Platform staff" subtitle={q.data ? `${q.data.staff.length} people · ${owners} active owner${owners === 1 ? "" : "s"} (at least one is always required)` : undefined} padded={false} data-testid="platform-staff">
      {q.isError ? (
        <div className="p-4">
          <ErrorPanel error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : !q.data ? (
        <TableSkeleton cols={4} />
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]">
            <TableHead>
              <tr>
                <Th leading>Person</Th>
                <Th>Platform role</Th>
                <Th>Status</Th>
                <Th>Last console sign-in</Th>
              </tr>
            </TableHead>
            <TableBody>
              {q.data.staff.map((s) => (
                <Tr key={s.id}>
                  <Td leading nowrap={false}>
                    <Link href={`/platform/users/${s.id}`} className="block max-w-[260px] truncate font-medium text-ink hover:text-primary-700">
                      {s.name}
                    </Link>
                    <span className="block max-w-[260px] truncate text-[11px] text-ink-2">{s.email}</span>
                  </Td>
                  <Td>
                    <Badge tone={s.role === "PLATFORM_OWNER" ? "primary" : "neutral"}>{platformRoleLabel(s.role)}</Badge>
                  </Td>
                  <Td>
                    <AccountStatusBadge status={s.status} />
                  </Td>
                  <Td>{fmtAgo(s.lastSignInAt)}</Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
