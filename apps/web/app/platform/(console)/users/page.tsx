"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, EmptyState, FilterSelect, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { PLATFORM_ROLES, canManagePlatformRole, platformRoleLabel, roleGroupLabel, type PlatformRole, type PlatformUserQuery, type Role } from "@pulseos/types";
import { useUrlFilters } from "../../../../lib/useUrlFilters";
import { CONTROL, FormField } from "../../../../components/settings/FormBits";
import { AccountStatusBadge, ActionDialog, ErrorPanel, Pager, PlatformFilters, PlatformPage, SearchBox, TableSkeleton, fmtAgo, fmtDay } from "../../../../components/platform/ui";
import { usePlatformUser } from "../../../../components/platform/usePlatformUser";

const TENANT_ROLES: Role[] = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"];
const ROLE_LABEL: Record<Role, string> = { SUPER_ADMIN: "Super Admin", HOSPITAL_ADMIN: "Admin", FRONT_DESK: "Front Desk", PATIENT_COORDINATOR: "Coordinator", DOCTOR: "Doctor" };

function InviteStaffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user } = usePlatformUser();
  const roles = PLATFORM_ROLES.filter((r) => user && canManagePlatformRole(user.role, r.key));
  const [form, setForm] = useState({ name: "", email: "", role: (roles[roles.length - 1]?.key ?? "SUPPORT_AGENT") as PlatformRole });
  const invite = useMutation({
    mutationFn: () => platformApi.inviteStaff({ name: form.name.trim(), email: form.email.trim().toLowerCase(), role: form.role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
      onClose();
    },
  });
  return (
    <ActionDialog
      open={open}
      title="Invite platform staff"
      description="Invictus staff get Platform Console access with exactly this role. They receive a link and choose their own password. Only a Platform Owner can grant the Owner and Admin roles."
      confirmLabel="Send invitation"
      pending={invite.isPending}
      error={invite.error}
      confirmDisabled={form.name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())}
      onConfirm={() => invite.mutate()}
      onCancel={onClose}
    >
      <div className="grid gap-3">
        <FormField label="Full name" htmlFor="staff-name">
          <input id="staff-name" className={CONTROL} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </FormField>
        <FormField label="Work email" htmlFor="staff-email">
          <input id="staff-email" type="email" className={CONTROL} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </FormField>
        <FormField label="Platform role" hint={PLATFORM_ROLES.find((r) => r.key === form.role)?.description} htmlFor="staff-role">
          <select id="staff-role" className={CONTROL} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as PlatformRole }))}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
    </ActionDialog>
  );
}

function UsersDirectory() {
  const router = useRouter();
  const { can } = usePlatformUser();
  const { get, set } = useUrlFilters();
  const [inviting, setInviting] = useState(false);
  const query: PlatformUserQuery = {
    q: get("q") || undefined,
    status: (get("status").toLowerCase() || undefined) as PlatformUserQuery["status"],
    kind: (get("kind") || undefined) as PlatformUserQuery["kind"],
    tenantId: get("tenant") || undefined,
    role: (get("role") || undefined) as PlatformUserQuery["role"],
    sort: (get("sort") || "name") as PlatformUserQuery["sort"],
    page: Number(get("page")) || 1,
    pageSize: 25,
  };
  const list = useQuery({ queryKey: ["platform", "users", query], queryFn: () => platformApi.users(query), placeholderData: keepPreviousData });
  const tenants = useQuery({ queryKey: ["platform", "tenant-options"], queryFn: () => platformApi.tenants({ pageSize: 100, sort: "name", dir: "asc" }), staleTime: 300_000 });
  const filtered = !!(query.q || query.status || query.kind || query.tenantId || query.role);
  const setFilter = (patch: Record<string, string | undefined>) => set({ ...patch, page: undefined });

  return (
    <PlatformPage
      title="Users"
      subtitle="Every person with access to PulseOS, across every hospital. One person can belong to several hospitals."
      testId="platform-users"
      actions={
        can("MANAGE_PLATFORM_STAFF") && (
          <Button variant="primary" onClick={() => setInviting(true)} data-testid="invite-staff">
            <UserPlus size={15} /> Invite platform staff
          </Button>
        )
      }
    >
      <PlatformFilters>
        <SearchBox value={query.q ?? ""} onChange={(v) => setFilter({ q: v || undefined })} placeholder="Name, email or hospital" label="Search users" testId="user-search" />
        <FilterSelect aria-label="Status" value={query.status ?? ""} onChange={(e) => setFilter({ status: e.target.value || undefined })}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="suspended">Suspended</option>
        </FilterSelect>
        <FilterSelect aria-label="Kind" value={query.kind ?? ""} onChange={(e) => setFilter({ kind: e.target.value || undefined })} data-testid="filter-kind">
          <option value="">Everyone</option>
          <option value="client">Client users</option>
          <option value="staff">Platform staff</option>
        </FilterSelect>
        <FilterSelect aria-label="Tenant" value={query.tenantId ?? ""} onChange={(e) => setFilter({ tenant: e.target.value || undefined })}>
          <option value="">All tenants</option>
          {(tenants.data?.rows ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Role" value={query.role ?? ""} onChange={(e) => setFilter({ role: e.target.value || undefined })}>
          <option value="">Any role</option>
          <optgroup label="Hospital roles">
            {TENANT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Platform roles">
            {PLATFORM_ROLES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </optgroup>
        </FilterSelect>
        <FilterSelect aria-label="Sort" value={query.sort} onChange={(e) => setFilter({ sort: e.target.value })}>
          <option value="name">Name A–Z</option>
          <option value="lastSignIn">Recently signed in</option>
          <option value="created">Newest first</option>
        </FilterSelect>
      </PlatformFilters>

      {list.isError ? (
        <ErrorPanel error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line surface-content shadow-panel" data-testid="user-table">
          {!list.data ? (
            <TableSkeleton cols={6} />
          ) : list.data.rows.length === 0 ? (
            <EmptyState message={filtered ? "No users match these filters" : "No users yet"} hint={filtered ? "Try a different search or clear the filters." : undefined} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[980px]">
                  <TableHead>
                    <tr>
                      <Th leading>Person</Th>
                      <Th>Status</Th>
                      <Th>Hospital memberships</Th>
                      <Th>Platform role</Th>
                      <Th>Last sign-in</Th>
                      <Th>Created</Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {list.data.rows.map((u) => (
                      <Tr key={u.email} onClick={() => router.push(`/platform/users/${u.key}`)} data-testid={`user-row-${u.email}`}>
                        <Td leading nowrap={false}>
                          <Link href={`/platform/users/${u.key}`} onClick={(e) => e.stopPropagation()} className="block max-w-[260px] truncate text-[13px] font-semibold text-ink hover:text-primary-700">
                            {u.name}
                          </Link>
                          <span className="block max-w-[260px] truncate text-[11px] text-ink-2" title={u.email}>
                            {u.email}
                          </span>
                        </Td>
                        <Td>
                          <AccountStatusBadge status={u.status} />
                        </Td>
                        <Td nowrap={false}>
                          {u.memberships.length === 0 ? (
                            <span className="text-ink-2">None</span>
                          ) : (
                            <span className="flex max-w-[380px] flex-wrap gap-1">
                              {u.memberships.slice(0, 3).map((m) => (
                                <span key={m.userId} className="inline-flex max-w-full items-center gap-1 rounded-chip border border-line bg-white px-1.5 py-0.5 text-[11px]" title={`${m.tenantName} · ${roleGroupLabel(m.role)} · ${m.status.toLowerCase()}`}>
                                  <span className="truncate">{m.tenantName}</span>
                                  <span className="shrink-0 text-ink-2">· {roleGroupLabel(m.role)}</span>
                                  {m.status !== "ACTIVE" && <span className="shrink-0 text-ink-2">· {m.status.toLowerCase()}</span>}
                                </span>
                              ))}
                              {u.memberships.length > 3 && <span className="text-[11px] text-ink-2">+{u.memberships.length - 3} more</span>}
                            </span>
                          )}
                        </Td>
                        <Td>{u.platform ? <Badge tone={u.platform.status === "ACTIVE" ? "primary" : "neutral"}>{platformRoleLabel(u.platform.role)}{u.platform.status !== "ACTIVE" ? ` · ${u.platform.status.toLowerCase()}` : ""}</Badge> : <span className="text-ink-2">—</span>}</Td>
                        <Td>{fmtAgo(u.lastSignInAt)}</Td>
                        <Td>{fmtDay(u.createdAt)}</Td>
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
      {inviting && <InviteStaffDialog open={inviting} onClose={() => setInviting(false)} />}
    </PlatformPage>
  );
}

export default function UsersPage() {
  return (
    <Suspense fallback={null}>
      <UsersDirectory />
    </Suspense>
  );
}
