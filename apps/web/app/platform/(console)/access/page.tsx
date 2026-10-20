"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, EmptyState, FilterSelect, Table, TableBody, TableHead, Tabs, Td, Th, Tr } from "@pulseos/ui";
import { platformRoleLabel, roleGroupLabel, type PlatformInvitationRow, type PlatformRole, type Role } from "@pulseos/types";
import { useUrlFilters } from "../../../../lib/useUrlFilters";
import { ActionDialog, ErrorPanel, Pager, PlatformFilters, PlatformPage, SearchBox, TableSkeleton, fmtAgo, fmtWhen } from "../../../../components/platform/ui";
import { usePlatformUser } from "../../../../components/platform/usePlatformUser";

const STATUS_TONE = { PENDING: "primary", ACCEPTED: "success", EXPIRED: "warning", REVOKED: "neutral" } as const;
const STATUS_LABEL = { PENDING: "Pending", ACCEPTED: "Accepted", EXPIRED: "Expired", REVOKED: "Revoked" } as const;

function roleLabel(row: PlatformInvitationRow) {
  return row.kind === "platform" ? platformRoleLabel(row.role as PlatformRole) : roleGroupLabel(row.role as Role);
}

function Invitations() {
  const queryClient = useQueryClient();
  const { can } = usePlatformUser();
  const { get, set } = useUrlFilters();
  const status = (get("status") || "pending") as "pending" | "accepted" | "expired" | "revoked";
  const q = { status, q: get("q") || undefined, kind: (get("kind") || undefined) as "tenant" | "platform" | undefined, page: Number(get("page")) || 1, pageSize: 25 };
  const list = useQuery({ queryKey: ["platform", "invitations", q], queryFn: () => platformApi.invitations(q), placeholderData: keepPreviousData });
  const [revoking, setRevoking] = useState<PlatformInvitationRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (row: PlatformInvitationRow) => platformApi.resendInvitation(row.id),
    onSuccess: async (r, row) => {
      setNotice(r.invitation.deliveryStatus === "SENT" ? `A new invitation link was sent to ${row.email}. The previous link no longer works.` : `A new link was created for ${row.email}, but it could not be delivered: no email provider is configured.`);
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    },
  });
  const revoke = useMutation({
    mutationFn: ({ row, reason }: { row: PlatformInvitationRow; reason: string }) => platformApi.revokeInvitation(row.id, reason),
    onSuccess: async (_r, { row }) => {
      setNotice(`The invitation to ${row.email} was revoked.`);
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    },
  });
  const s = list.data?.summary;

  return (
    <PlatformPage title="Access & Invitations" subtitle="Every invitation to a hospital or to this console. Links are never shown: they go only to the invited person." testId="platform-access">
      <Tabs
        variant="underline"
        ariaLabel="Invitation status"
        value={status}
        onChange={(k) => set({ status: k === "pending" ? undefined : k, page: undefined })}
        items={[
          { key: "pending", label: "Pending", count: s?.pending, testId: "tab-pending" },
          { key: "accepted", label: "Accepted", count: s?.accepted },
          { key: "expired", label: "Expired", count: s?.expired, testId: "tab-expired" },
          { key: "revoked", label: "Revoked", count: s?.revoked },
        ]}
      />
      <PlatformFilters>
        <SearchBox value={q.q ?? ""} onChange={(v) => set({ q: v || undefined, page: undefined })} placeholder="Email or hospital" label="Search invitations" testId="invitation-search" />
        <FilterSelect aria-label="Kind" value={q.kind ?? ""} onChange={(e) => set({ kind: e.target.value || undefined, page: undefined })}>
          <option value="">Hospitals and console</option>
          <option value="tenant">Hospital invitations</option>
          <option value="platform">Console invitations</option>
        </FilterSelect>
      </PlatformFilters>
      {notice && (
        <p role="status" className="rounded-card border border-line bg-surface-info px-4 py-2.5 text-sm text-ink" data-testid="access-notice">
          {notice}
        </p>
      )}
      {resend.isError && <ErrorPanel error={resend.error} />}
      {list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line surface-content shadow-panel" data-testid="invitation-table">
          {!list.data ? (
            <TableSkeleton cols={6} />
          ) : list.data.rows.length === 0 ? (
            <EmptyState message={`No ${status} invitations`} hint={status === "pending" ? "Invite people from a tenant's Users tab, or platform staff from Users." : undefined} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[980px]">
                  <TableHead>
                    <tr>
                      <Th leading>Email</Th>
                      <Th>Tenant</Th>
                      <Th>Role</Th>
                      <Th>Invited by</Th>
                      <Th>Created</Th>
                      <Th>Expires</Th>
                      <Th>Status</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {list.data.rows.map((r) => (
                      <Tr key={r.id} data-testid={`invitation-${r.email}`}>
                        <Td leading nowrap={false}>
                          <Link href={`/platform/users/${r.accountId}`} className="block max-w-[260px] truncate font-medium text-ink hover:text-primary-700" title={r.email}>
                            {r.email}
                          </Link>
                          <span className="block text-[11px] text-ink-2">
                            {r.deliveryStatus === "SENT" ? "Delivered" : "Not delivered"} · sent {r.sendCount}×
                          </span>
                        </Td>
                        <Td>{r.kind === "platform" ? <span className="text-ink-2">Platform Console</span> : r.tenantName}</Td>
                        <Td>{roleLabel(r)}</Td>
                        <Td>{r.invitedBy ?? <span className="text-ink-2">—</span>}</Td>
                        <Td>{fmtAgo(r.createdAt)}</Td>
                        <Td>{fmtWhen(r.expiresAt)}</Td>
                        <Td>
                          <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                        </Td>
                        <Td>
                          {can("MANAGE_ACCOUNT_ACCESS") && (r.status === "PENDING" || r.status === "EXPIRED") && (
                            <span className="flex gap-1">
                              <Button size="sm" disabled={resend.isPending} onClick={() => resend.mutate(r)} data-testid={`resend-${r.email}`}>
                                Resend
                              </Button>
                              {r.status === "PENDING" && (
                                <Button size="sm" variant="ghost" onClick={() => setRevoking(r)} data-testid={`revoke-${r.email}`}>
                                  Revoke
                                </Button>
                              )}
                            </span>
                          )}
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
      <ActionDialog
        open={!!revoking}
        title="Revoke invitation"
        description={revoking ? `The link sent to ${revoking.email} stops working. The account stays invited; you can send a new invitation later.` : ""}
        confirmLabel="Revoke"
        danger
        requireReason
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={(reason) => revoking && revoke.mutate({ row: revoking, reason })}
        onCancel={() => setRevoking(null)}
      />
    </PlatformPage>
  );
}

export default function AccessPage() {
  return (
    <Suspense fallback={null}>
      <Invitations />
    </Suspense>
  );
}
