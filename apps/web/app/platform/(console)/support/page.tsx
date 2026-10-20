"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, EmptyState, FilterSelect, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import type { PlatformSupportSession } from "@pulseos/types";
import { useUrlFilters } from "../../../../lib/useUrlFilters";
import { CONTROL, FormField } from "../../../../components/settings/FormBits";
import { ActionDialog, ErrorPanel, Pager, PlatformFilters, PlatformPage, TableSkeleton, errorMessage, fmtAgo, fmtWhen } from "../../../../components/platform/ui";
import { usePlatformUser } from "../../../../components/platform/usePlatformUser";

/** A full page load, so the hospital app starts fresh with the support session (no cached hospital or console state). */
function openHospital() {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load resets the app's session state when entering Support Mode
  window.location.assign("/command-centre");
}

function minutesLeft(iso: string) {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
}

function ActiveSession({ s }: { s: PlatformSupportSession }) {
  const queryClient = useQueryClient();
  const { can } = usePlatformUser();
  const [enabling, setEnabling] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["platform"] });
  const enable = useMutation({ mutationFn: (reason: string) => platformApi.enableSupportEdits(s.id, { reason, minutes }), onSuccess: async () => { await refresh(); setEnabling(false); } });
  const disable = useMutation({ mutationFn: () => platformApi.disableSupportEdits(s.id), onSuccess: refresh });
  const end = useMutation({ mutationFn: () => platformApi.endSupport(s.id), onSuccess: refresh });

  return (
    <Panel
      title={`Your support session: ${s.tenantName}`}
      subtitle={`${minutesLeft(s.expiresAt)} min left`}
      tone="info"
      data-testid="active-support"
      action={
        <span className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={openHospital} data-testid="open-support-tenant">
            Open hospital
          </Button>
          <Button variant="danger" disabled={end.isPending} onClick={() => end.mutate()} data-testid="end-support-console">
            End session
          </Button>
        </span>
      }
    >
      <p className="text-sm text-ink">
        <span className="font-medium">Reason:</span> {s.reason}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {s.writeEnabled ? (
          <>
            <Badge tone="warning">Edits enabled</Badge>
            <span className="text-ink-2">until {fmtWhen(s.writeExpiresAt)} · “{s.writeReason}”</span>
            <Button size="sm" disabled={disable.isPending} onClick={() => disable.mutate()}>
              Switch edits off
            </Button>
          </>
        ) : (
          <>
            <Badge tone="primary">Read-only</Badge>
            {can("ENABLE_SUPPORT_EDITS") && (
              <Button size="sm" onClick={() => setEnabling(true)} data-testid="enable-edits">
                Enable support edits
              </Button>
            )}
          </>
        )}
      </p>
      {(end.isError || disable.isError) && <p role="alert" className="mt-2 text-xs text-danger-700">{errorMessage(end.error ?? disable.error)}</p>}
      <ActionDialog
        open={enabling}
        title={`Enable support edits in ${s.tenantName}`}
        description="Changes you make will be real and immediate. Each one is recorded as you, in Support Mode, with this reason. Edits switch off automatically when the time is up."
        confirmLabel="Enable edits"
        danger
        requireReason
        typedConfirmation="EDIT"
        pending={enable.isPending}
        error={enable.error}
        onConfirm={(reason) => enable.mutate(reason)}
        onCancel={() => setEnabling(false)}
      >
        <FormField label="For how long" htmlFor="edit-minutes">
          <select id="edit-minutes" className={CONTROL} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[10, 15, 30].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </FormField>
      </ActionDialog>
    </Panel>
  );
}

function StartSupport({ initialTenant }: { initialTenant: string }) {
  const tenants = useQuery({ queryKey: ["platform", "tenant-options"], queryFn: () => platformApi.tenants({ pageSize: 100, sort: "name", dir: "asc" }), staleTime: 300_000 });
  const [tenantId, setTenantId] = useState(initialTenant);
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(30);
  const start = useMutation({
    mutationFn: () => platformApi.startSupport(tenantId, { reason: reason.trim(), minutes }),
    onSuccess: openHospital,
  });
  return (
    <Panel title="Open a hospital in Support Mode" subtitle="Read-only by default · time-limited · every step is audited" data-testid="start-support">
      <form
        className="grid gap-3 md:grid-cols-[1fr_1.5fr_auto_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (tenantId && reason.trim().length >= 5) start.mutate();
        }}
      >
        <FormField label="Hospital" htmlFor="support-tenant">
          <select id="support-tenant" className={CONTROL} value={tenantId} onChange={(e) => setTenantId(e.target.value)} data-testid="support-tenant">
            <option value="">Choose a hospital…</option>
            {(tenants.data?.rows ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.status !== "ACTIVE" ? ` (${t.status.toLowerCase()})` : ""}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Reason (recorded)" htmlFor="support-reason">
          <input id="support-reason" className={CONTROL} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket 1423: follow-ups not showing" data-testid="support-reason" />
        </FormField>
        <FormField label="Duration" htmlFor="support-minutes">
          <select id="support-minutes" className={CONTROL} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </FormField>
        <Button type="submit" variant="primary" disabled={!tenantId || reason.trim().length < 5 || start.isPending} data-testid="start-support-submit">
          <LifeBuoy size={15} /> {start.isPending ? "Opening…" : "Open as support"}
        </Button>
      </form>
      {start.isError && <p role="alert" className="mt-2 text-xs text-danger-700">{errorMessage(start.error)}</p>}
    </Panel>
  );
}

function Support() {
  const { can } = usePlatformUser();
  const { get, set } = useUrlFilters();
  const q = { active: (get("active") || undefined) as "true" | undefined, page: Number(get("page")) || 1, pageSize: 25 };
  const mine = useQuery({ queryKey: ["platform", "support", "mine"], queryFn: () => platformApi.supportSessions({ mine: "true", active: "true", pageSize: 1 }) });
  const list = useQuery({ queryKey: ["platform", "support", q], queryFn: () => platformApi.supportSessions(q), placeholderData: keepPreviousData });
  const active = mine.data?.rows[0];

  return (
    <PlatformPage title="Support" subtitle="See a hospital the way its admin does — for a stated reason, for a limited time, under a visible banner. Never invisible, never as a client user." testId="platform-support">
      {active ? <ActiveSession s={active} /> : can("START_SUPPORT_SESSION") ? <StartSupport initialTenant={get("tenant")} /> : null}
      <PlatformFilters>
        <FilterSelect aria-label="Which sessions" value={q.active ?? ""} onChange={(e) => set({ active: e.target.value || undefined, page: undefined })}>
          <option value="">All support sessions</option>
          <option value="true">Active now</option>
        </FilterSelect>
      </PlatformFilters>
      {list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line surface-content shadow-panel" data-testid="support-table">
          {!list.data ? (
            <TableSkeleton cols={6} />
          ) : list.data.rows.length === 0 ? (
            <EmptyState message="No support sessions yet" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[960px]">
                  <TableHead>
                    <tr>
                      <Th leading>Hospital</Th>
                      <Th>Staff member</Th>
                      <Th>Reason</Th>
                      <Th>Started</Th>
                      <Th>Ends / ended</Th>
                      <Th>Edits</Th>
                      <Th>Status</Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {list.data.rows.map((s) => (
                      <Tr key={s.id}>
                        <Td leading>
                          <Link href={`/platform/tenants/${s.tenantId}`} className="font-medium text-ink hover:text-primary-700">
                            {s.tenantName}
                          </Link>
                        </Td>
                        <Td>{s.staffName}</Td>
                        <Td nowrap={false}>
                          <span className="line-clamp-2 max-w-[280px]">{s.reason}</span>
                        </Td>
                        <Td>{fmtAgo(s.startedAt)}</Td>
                        <Td>{fmtWhen(s.endedAt ?? s.expiresAt)}</Td>
                        <Td>{s.writeReason ? <Badge tone="warning">Enabled</Badge> : <span className="text-ink-2">Read-only</span>}</Td>
                        <Td>
                          <Badge tone={s.active ? "primary" : "neutral"}>{s.active ? "Active" : s.endReason === "replaced" ? "Replaced" : s.endedAt ? "Ended" : "Expired"}</Badge>
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

export default function SupportPage() {
  return (
    <Suspense fallback={null}>
      <Support />
    </Suspense>
  );
}
