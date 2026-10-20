"use client";

import { useQuery } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { ErrorPanel, TableSkeleton } from "../ui";

/** Real operational counts. Storage is reported as a count of recordings, never an estimated size. */
export function TenantUsageTab({ tenantId }: { tenantId: string }) {
  const q = useQuery({ queryKey: ["platform", "tenant", tenantId, "usage"], queryFn: () => platformApi.tenantUsage(tenantId) });
  if (q.isError) return <ErrorPanel error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Panel title="Usage" subtitle={q.data ? `All time and the last ${q.data.windowDays} days. Counts only; nothing patient-level.` : undefined} padded={false} data-testid="tenant-usage">
      {!q.data ? (
        <TableSkeleton rows={9} cols={3} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHead>
              <tr>
                <Th leading>Metric</Th>
                <Th align="right">All time</Th>
                <Th align="right">Last {q.data.windowDays} days</Th>
              </tr>
            </TableHead>
            <TableBody>
              {q.data.metrics.map((m) => (
                <Tr key={m.key} data-testid={`usage-${m.key}`}>
                  <Td leading>{m.label}</Td>
                  <Td align="right">{m.total.toLocaleString("en-IN")}</Td>
                  <Td align="right">{m.recent.toLocaleString("en-IN")}</Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
