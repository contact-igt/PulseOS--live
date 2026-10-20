"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Copy } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { PLAN_META, roleGroupLabel, type PlatformTenantDetail, type TenantReadiness } from "@pulseos/types";
import { AccountStatusBadge, Fact, fmtAgo, fmtDay, fmtWhen } from "../ui";

export const READINESS: Record<TenantReadiness, { label: string; tone: "neutral" | "warning" | "primary" | "success"; hint: string }> = {
  SETUP_INCOMPLETE: { label: "Setup incomplete", tone: "neutral", hint: "Branches, departments, lead sources and an invited admin are needed before handing over." },
  READY_FOR_CLIENT: { label: "Ready for client", tone: "primary", hint: "Setup is complete. Activate the tenant when the client is ready to go live." },
  ACTIVE: { label: "Active", tone: "success", hint: "Live, with an active administrator and no integration issues." },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "warning", hint: "Live, but an integration is failing or no administrator is active." },
};

export function TenantOverviewTab({ detail, canManagePrimary }: { detail: PlatformTenantDetail; canManagePrimary: boolean }) {
  const t = detail.tenant;
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const setPrimary = useMutation({
    mutationFn: (userId: string) => platformApi.setPrimaryAdmin(t.id, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platform", "tenant", t.id] }),
  });
  const loginUrl = detail.loginPath && typeof window !== "undefined" ? `${window.location.origin}${detail.loginPath}` : null;
  const done = detail.checklist.filter((c) => c.done).length;

  return (
    <div className="space-y-4" data-testid="tenant-overview">
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel title="Workspace">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Fact label="Slug">{t.loginSlug ? <span className="font-mono">{t.loginSlug}</span> : "—"}</Fact>
            <Fact label="Plan">{PLAN_META[t.edition].name}</Fact>
            <Fact label="Industry">{t.industry ?? "—"}</Fact>
            <Fact label="Country">{t.country ?? "—"}</Fact>
            <Fact label="Time zone">{t.timezone}</Fact>
            <Fact label="Locale">{t.locale}</Fact>
            <Fact label="Created">{fmtDay(t.createdAt)}</Fact>
            <Fact label="Status changed">{fmtWhen(t.statusChangedAt)}</Fact>
            <Fact label="Last staff sign-in">{fmtAgo(detail.lastLoginAt)}</Fact>
          </dl>
          {t.statusReason && (
            <p className="mt-3 rounded-control bg-surface-muted px-3 py-2 text-xs text-ink-2">
              <span className="font-medium text-ink">Status reason:</span> {t.statusReason}
            </p>
          )}
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Client login link</p>
            {loginUrl ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="min-w-0 break-all rounded-control bg-surface-muted px-2 py-1 text-xs text-ink" data-testid="tenant-login-link">
                  {loginUrl}
                </code>
                <Button
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(loginUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  data-testid="copy-login-link"
                >
                  <Copy size={13} /> {copied ? "Copied" : "Copy login link"}
                </Button>
              </div>
            ) : (
              <p className="mt-1 text-xs text-ink-2">No sign-in address. Set a login address under Edit details.</p>
            )}
          </div>
        </Panel>

        <Panel title="Onboarding checklist" subtitle={`${done} of ${detail.checklist.length} done`} data-testid="tenant-checklist">
          {detail.readiness && (
            <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
              <Badge tone={READINESS[detail.readiness].tone}>{READINESS[detail.readiness].label}</Badge>
              {READINESS[detail.readiness].hint}
            </p>
          )}
          <ul className="space-y-1.5">
            {detail.checklist.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-sm" data-testid={`check-${c.key}`} data-done={c.done}>
                {c.done ? <Check size={16} className="mt-0.5 shrink-0 text-accent-700" aria-hidden="true" /> : <Circle size={16} className="mt-0.5 shrink-0 text-neutral-400" aria-hidden="true" />}
                <span>
                  <span className={c.done ? "text-ink" : "text-ink-2"}>{c.label}</span>
                  <span className="sr-only">{c.done ? " (done)" : " (not done)"}</span>
                  {c.detail && <span className="block text-[11px] text-ink-2">{c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line shadow-panel sm:grid-cols-4 lg:grid-cols-8" data-testid="tenant-counts">
        {(
          [
            ["Users", detail.counts.users],
            ["Branches", detail.counts.branches],
            ["Departments", detail.counts.departments],
            ["Lead sources", detail.counts.leadSources],
            ["Patients", detail.counts.patients],
            ["Journeys", detail.counts.journeys],
            ["Calls", detail.counts.calls],
            ["Appointments", detail.counts.appointments],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="bg-surface px-4 py-3">
            <span className="block text-lg font-semibold tabular-nums text-ink">{value}</span>
            <span className="text-xs text-ink-2">{label}</span>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Administrators" subtitle="Primary admin is the client's main contact" padded={false} data-testid="tenant-admins">
          {detail.admins.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-2">No administrator. Invite one from the Users tab.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHead>
                  <tr>
                    <Th leading>Name</Th>
                    <Th>Role</Th>
                    <Th>Status</Th>
                    <Th>Last sign-in</Th>
                    <Th>
                      <span className="sr-only">Primary</span>
                    </Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {detail.admins.map((a) => (
                    <Tr key={a.id}>
                      <Td leading nowrap={false}>
                        <span className="block max-w-[220px] truncate font-medium">{a.name}</span>
                        <span className="block max-w-[220px] truncate text-[11px] text-ink-2" title={a.email}>
                          {a.email}
                        </span>
                      </Td>
                      <Td>{roleGroupLabel(a.role)}</Td>
                      <Td>
                        <AccountStatusBadge status={a.status} />
                      </Td>
                      <Td>{fmtAgo(a.lastSignInAt)}</Td>
                      <Td>
                        {a.primary ? (
                          <Badge tone="primary">Primary</Badge>
                        ) : canManagePrimary && (a.status === "ACTIVE" || a.status === "INVITED") ? (
                          <Button size="sm" variant="ghost" disabled={setPrimary.isPending} onClick={() => setPrimary.mutate(a.id)}>
                            Make primary
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {setPrimary.isError && <p role="alert" className="px-4 py-2 text-xs text-danger-700">Could not change the primary admin. Please try again.</p>}
        </Panel>

        <Panel title="Recent integration activity" subtitle="When events arrived and how they were handled — no payloads" padded={false} data-testid="tenant-recent-events">
          {detail.recentIntegrationEvents.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-2">No integration events yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {detail.recentIntegrationEvents.map((e, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs">
                  <span className="text-ink">
                    {e.displayName} <span className="text-ink-2">· {e.direction}</span>
                  </span>
                  <span className="flex items-center gap-2 text-ink-2">
                    <Badge tone={e.status === "failed" ? "danger" : e.status === "processed" ? "success" : "neutral"}>{e.status}</Badge>
                    {fmtAgo(e.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
