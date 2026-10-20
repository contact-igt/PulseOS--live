"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, Panel } from "@pulseos/ui";
import type { SourceChannel } from "@pulseos/types";
import { CONTROL } from "../../settings/FormBits";
import { ErrorPanel, TableSkeleton, errorMessage } from "../ui";

const BUCKET_LABEL: Record<SourceChannel, string> = {
  meta: "Digital · Meta",
  google: "Digital · Google",
  website: "Digital · Website",
  whatsapp: "WhatsApp",
  phone: "Offline · Phone",
  walk_in: "Offline · Walk-in",
  referral: "Referral",
  organic: "Direct",
  other: "Custom / other",
};

/**
 * Branches, departments and lead sources are the hospital's own configuration. The console helps set them up through the
 * same services the hospital's Settings use; every change is audited against the platform staff member.
 */
export function TenantConfigTab({ tenantId, canEdit }: { tenantId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const key = ["platform", "tenant", tenantId, "configuration"];
  const cfg = useQuery({ queryKey: key, queryFn: () => platformApi.tenantConfiguration(tenantId) });
  const [branch, setBranch] = useState({ name: "", city: "" });
  const [source, setSource] = useState<{ label: string; bucket: SourceChannel }>({ label: "", bucket: "other" });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: ["platform", "tenant", tenantId] })]);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
  });

  if (cfg.isError) return <ErrorPanel error={cfg.error} onRetry={() => cfg.refetch()} />;
  if (!cfg.data) return <TableSkeleton rows={8} cols={3} />;
  const c = cfg.data;

  return (
    <div className="space-y-4" data-testid="tenant-config">
      {run.isError && (
        <p role="alert" className="rounded-control bg-danger-100/50 px-3 py-2 text-xs text-danger-700">
          {errorMessage(run.error)}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Branches" subtitle={`${c.branches.length}`} padded={false}>
          <ul className="divide-y divide-neutral-100">
            {c.branches.map((b) => (
              <li key={b.id} className="px-4 py-2 text-sm">
                <span className="font-medium text-ink">{b.name}</span> <span className="text-ink-2">· {b.city}</span>
              </li>
            ))}
          </ul>
          {canEdit && (
            <form
              className="grid grid-cols-[1fr_1fr_auto] gap-2 border-t border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (branch.name.trim().length < 2 || branch.city.trim().length < 2) return;
                run.mutate(() => platformApi.addBranch(tenantId, { name: branch.name.trim(), city: branch.city.trim() }), { onSuccess: () => setBranch({ name: "", city: "" }) });
              }}
            >
              <input aria-label="New branch name" placeholder="Branch name" className={CONTROL} value={branch.name} onChange={(e) => setBranch((b) => ({ ...b, name: e.target.value }))} />
              <input aria-label="New branch city" placeholder="City" className={CONTROL} value={branch.city} onChange={(e) => setBranch((b) => ({ ...b, city: e.target.value }))} />
              <Button type="submit" variant="primary" disabled={run.isPending} aria-label="Add branch">
                <Plus size={14} />
              </Button>
            </form>
          )}
        </Panel>

        <Panel title="Departments" subtitle={`${c.departments.filter((d) => !d.archived).length} active`} padded={false}>
          {c.departments.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-ink-2">No departments yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {c.departments.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                  <span className={d.archived ? "text-ink-2 line-through" : "text-ink"}>{d.displayName}</span>
                  <span className="flex items-center gap-2">
                    {d.archived && <Badge>Archived</Badge>}
                    {canEdit && (
                      <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => run.mutate(() => platformApi.updateDepartment(tenantId, d.id, { archived: !d.archived }))}>
                        {d.archived ? "Restore" : "Archive"}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canEdit && c.availableDepartmentTemplates.length > 0 && (
            <div className="space-y-1.5 border-t border-line p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Install from template</p>
              {c.availableDepartmentTemplates.map((t) => (
                <Button key={t.key} size="sm" disabled={run.isPending} onClick={() => run.mutate(() => platformApi.installDepartment(tenantId, t.key))}>
                  <Plus size={13} /> {t.displayName}
                </Button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Lead sources" subtitle={`${c.leadSources.filter((s) => !s.archived).length} offered`} padded={false}>
          <ul className="max-h-[420px] divide-y divide-neutral-100 overflow-y-auto">
            {c.leadSources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="min-w-0">
                  <span className={s.archived ? "text-ink-2" : "text-ink"}>{s.label}</span>
                  <span className="block text-[11px] text-ink-2">{BUCKET_LABEL[s.bucket]}</span>
                </span>
                <span className="flex items-center gap-2">
                  {s.archived && <Badge>Not offered</Badge>}
                  {canEdit && (
                    <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => run.mutate(() => platformApi.updateLeadSource(tenantId, s.id, { archived: !s.archived }))}>
                      {s.archived ? "Offer" : "Stop offering"}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {canEdit && (
            <form
              className="grid grid-cols-[1fr_1fr_auto] gap-2 border-t border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!source.label.trim()) return;
                run.mutate(() => platformApi.addLeadSource(tenantId, { label: source.label.trim(), bucket: source.bucket }), { onSuccess: () => setSource({ label: "", bucket: "other" }) });
              }}
            >
              <input aria-label="New lead source" placeholder="New source" className={CONTROL} value={source.label} onChange={(e) => setSource((s) => ({ ...s, label: e.target.value }))} />
              <select aria-label="Source kind" className={CONTROL} value={source.bucket} onChange={(e) => setSource((s) => ({ ...s, bucket: e.target.value as SourceChannel }))}>
                {(Object.keys(BUCKET_LABEL) as SourceChannel[]).map((b) => (
                  <option key={b} value={b}>
                    {BUCKET_LABEL[b]}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="primary" disabled={run.isPending} aria-label="Add lead source">
                <Plus size={14} />
              </Button>
            </form>
          )}
        </Panel>
      </div>
    </div>
  );
}
