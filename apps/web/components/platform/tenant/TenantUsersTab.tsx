"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, EmptyState, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { roleGroupLabel, type PlatformTenantDetail, type Role } from "@pulseos/types";
import { CONTROL, FormField } from "../../settings/FormBits";
import { AccountStatusBadge, ActionDialog, ErrorPanel, TableSkeleton, fmtAgo } from "../ui";
import { usePlatformUser } from "../usePlatformUser";

const ROLES: { key: Role; label: string }[] = [
  { key: "SUPER_ADMIN", label: "Super Admin" },
  { key: "HOSPITAL_ADMIN", label: "Admin" },
  { key: "FRONT_DESK", label: "Front Desk" },
  { key: "PATIENT_COORDINATOR", label: "Coordinator" },
  { key: "DOCTOR", label: "Doctor" },
];

/** The hospital's people. Inviting sends a link; the person chooses their own password. Row actions live on the person's page. */
export function TenantUsersTab({ detail }: { detail: PlatformTenantDetail }) {
  const tenantId = detail.tenant.id;
  const queryClient = useQueryClient();
  const { can } = usePlatformUser();
  const members = useQuery({ queryKey: ["platform", "tenant", tenantId, "members"], queryFn: () => platformApi.tenantMembers(tenantId) });
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "FRONT_DESK" as Role });
  const [notice, setNotice] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => platformApi.addMember(tenantId, { name: form.name.trim(), email: form.email.trim().toLowerCase(), role: form.role }),
    onSuccess: async (r) => {
      setNotice(r.invitation.deliveryStatus === "SENT" ? `Invitation sent to ${form.email.trim()}.` : `${form.email.trim()} was added, but the invitation could not be delivered (no email provider configured).`);
      setInviting(false);
      setForm({ name: "", email: "", role: "FRONT_DESK" });
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    },
  });

  return (
    <div className="space-y-3" data-testid="tenant-users">
      {notice && (
        <p role="status" className="rounded-card border border-line bg-surface-info px-4 py-2.5 text-sm text-ink" data-testid="tenant-users-notice">
          {notice}
        </p>
      )}
      <Panel
        title="Users"
        subtitle="Staff accounts of this hospital"
        padded={false}
        action={
          can("MANAGE_MEMBERSHIPS") &&
          detail.tenant.status !== "ARCHIVED" && (
            <Button size="sm" variant="primary" onClick={() => setInviting(true)} data-testid="invite-member">
              <UserPlus size={14} /> Invite user
            </Button>
          )
        }
      >
        {members.isError ? (
          <div className="p-4">
            <ErrorPanel error={members.error} onRetry={() => members.refetch()} />
          </div>
        ) : !members.data ? (
          <TableSkeleton cols={5} />
        ) : members.data.members.length === 0 ? (
          <EmptyState message="No users yet" hint="Invite the hospital's first administrator." />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHead>
                <tr>
                  <Th leading>Person</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th align="right">Open sessions</Th>
                  <Th>Last sign-in</Th>
                </tr>
              </TableHead>
              <TableBody>
                {members.data.members.map((m) => (
                  <Tr key={m.id} data-testid={`member-${m.email}`}>
                    <Td leading nowrap={false}>
                      <Link href={`/platform/users/${m.id}`} className="block max-w-[260px] truncate font-medium text-ink hover:text-primary-700">
                        {m.name}
                      </Link>
                      <span className="block max-w-[260px] truncate text-[11px] text-ink-2">{m.email}</span>
                    </Td>
                    <Td>
                      <span className="flex items-center gap-1.5">
                        {roleGroupLabel(m.role)}
                        {m.primaryAdmin && <Badge tone="primary">Primary</Badge>}
                      </span>
                    </Td>
                    <Td>
                      <AccountStatusBadge status={m.status} />
                    </Td>
                    <Td align="right">{m.sessions}</Td>
                    <Td>{fmtAgo(m.lastSignInAt)}</Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
      <ActionDialog
        open={inviting}
        title={`Invite a user to ${detail.tenant.name}`}
        description="They receive a single-use link and choose their own password. If they belong to another hospital, this adds a separate membership."
        confirmLabel="Send invitation"
        pending={invite.isPending}
        error={invite.error}
        confirmDisabled={form.name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())}
        onConfirm={() => invite.mutate()}
        onCancel={() => setInviting(false)}
      >
        <div className="grid gap-3">
          <FormField label="Full name" htmlFor="member-name">
            <input id="member-name" className={CONTROL} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="member-name" />
          </FormField>
          <FormField label="Email" htmlFor="member-email">
            <input id="member-email" type="email" className={CONTROL} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} data-testid="member-email" />
          </FormField>
          <FormField label="Role" htmlFor="member-role">
            <select id="member-role" className={CONTROL} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))} data-testid="member-role">
              {ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </ActionDialog>
    </div>
  );
}
