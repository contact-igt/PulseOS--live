"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Badge, Panel } from "@pulseos/ui";
import type { PlatformTenantDetail } from "@pulseos/types";
import { ErrorPanel, NoAccess, TableSkeleton, fmtAgo } from "../ui";
import { usePlatformUser } from "../usePlatformUser";
import { platformApi } from "@pulseos/api-client";

/** Platform actions on this hospital, next to the hospital's own settings history. */
export function TenantAuditTab({ detail }: { detail: PlatformTenantDetail }) {
  const { can } = usePlatformUser();
  const q = useQuery({ queryKey: ["platform", "tenant", detail.tenant.id, "audit"], queryFn: () => platformApi.tenantAudit(detail.tenant.id), enabled: can("VIEW_AUDIT") });
  if (!can("VIEW_AUDIT")) return <NoAccess what="the audit trail" />;
  if (q.isError) return <ErrorPanel error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <TableSkeleton rows={8} cols={3} />;
  return (
    <div className="grid gap-4 xl:grid-cols-2" data-testid="tenant-audit">
      <Panel title="Platform actions" subtitle="By PulseOS staff" padded={false} action={<Link href={`/platform/audit?tenant=${detail.tenant.id}`} className="text-xs font-medium text-primary-700 hover:underline">Full audit</Link>}>
        {q.data.platform.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-2">No platform actions yet.</p>
        ) : (
          <ul className="max-h-[560px] divide-y divide-neutral-100 overflow-y-auto">
            {q.data.platform.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ink">{e.summary}</span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-2">
                    {e.context === "SUPPORT_MODE" && <Badge tone="primary">Support</Badge>}
                    {e.outcome !== "SUCCESS" && <Badge tone="danger">{e.outcome.toLowerCase()}</Badge>}
                    {fmtAgo(e.at)}
                  </span>
                </span>
                <span className="block text-[11px] text-ink-2">
                  {e.actor}
                  {e.reason ? ` · “${e.reason}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Hospital settings history" subtitle="The hospital's own activity log" padded={false}>
        {q.data.tenantActivity.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-2">No settings changes recorded.</p>
        ) : (
          <ul className="max-h-[560px] divide-y divide-neutral-100 overflow-y-auto">
            {q.data.tenantActivity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span>
                  <span className="font-mono text-xs text-ink">{a.action}</span>
                  {a.entityKey && <span className="text-xs text-ink-2"> · {a.entityKey}</span>}
                  <span className="block text-[11px] text-ink-2">{a.actor}</span>
                </span>
                <span className="text-xs text-ink-2">{fmtAgo(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
