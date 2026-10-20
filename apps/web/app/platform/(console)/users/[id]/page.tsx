"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { ApiError, platformApi } from "@pulseos/api-client";
import { Badge, Button, Panel, Skeleton, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { PLATFORM_ROLES, canManagePlatformRole, platformRoleLabel, roleGroupLabel, type PlatformRole, type PlatformUserDetail, type Role } from "@pulseos/types";
import { CONTROL, FormField } from "../../../../../components/settings/FormBits";
import { AccountStatusBadge, ActionDialog, ErrorPanel, Fact, PlatformPage, TenantStatusBadge, fmtAgo, fmtWhen } from "../../../../../components/platform/ui";
import { RowMenu } from "../../../../../components/platform/RowMenu";
import { usePlatformUser } from "../../../../../components/platform/usePlatformUser";

const TENANT_ROLES: Role[] = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"];
const ROLE_LABEL: Record<Role, string> = { SUPER_ADMIN: "Super Admin", HOSPITAL_ADMIN: "Admin", FRONT_DESK: "Front Desk", PATIENT_COORDINATOR: "Coordinator", DOCTOR: "Doctor" };

type Membership = PlatformUserDetail["memberships"][number];
type Pending =
  | { kind: "role"; m: Membership }
  | { kind: "suspend" | "reactivate" | "remove"; m: Membership }
  | { kind: "reset"; m: Membership }
  | { kind: "signout"; m: Membership }
  | { kind: "identity-suspend" | "identity-reactivate" }
  | { kind: "staff-role" }
  | { kind: "staff-suspend" | "staff-reactivate" }
  | { kind: "session"; sessionId: string; platform: boolean; label: string };

/** Short, human device label from a user-agent string (never shown raw in a cramped table). */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /node|undici|lightmyrequest/i.test(ua) ? "API client" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { user: me, can } = usePlatformUser();
  const detail = useQuery({ queryKey: ["platform", "user", id], queryFn: () => platformApi.user(id) });
  const [pending, setPending] = useState<Pending | null>(null);
  const [role, setRole] = useState<Role>("FRONT_DESK");
  const [staffRole, setStaffRole] = useState<PlatformRole>("SUPPORT_AGENT");
  const [confirmNoAdmin, setConfirmNoAdmin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: async (reason: string): Promise<string> => {
      const p = pending!;
      const d = detail.data!;
      switch (p.kind) {
        case "role":
          await platformApi.changeMemberRole(p.m.userId, { role, version: p.m.version, confirmNoAdmin });
          return `Role changed to ${ROLE_LABEL[role]} in ${p.m.tenantName}. It applies on their next request.`;
        case "suspend":
        case "reactivate":
        case "remove":
          await platformApi.membershipAction(p.m.userId, p.kind, { reason, confirmNoAdmin });
          return `Membership in ${p.m.tenantName}: ${p.kind === "remove" ? "removed" : p.kind === "suspend" ? "suspended" : "reactivated"}.`;
        case "reset": {
          const r = await platformApi.sendPasswordReset(p.m.userId);
          return r.deliveryStatus === "SENT" ? "A password reset link was sent." : "The reset link was created but could not be delivered: no email provider is configured.";
        }
        case "signout": {
          const r = await platformApi.revokeMemberSessions(p.m.userId);
          return `Signed out of ${r.revoked} session(s) in ${p.m.tenantName}.`;
        }
        case "identity-suspend":
        case "identity-reactivate": {
          const r = await platformApi.identityAction(d.key, p.kind === "identity-suspend" ? "suspend" : "reactivate", { reason, confirmNoAdmin });
          return `${p.kind === "identity-suspend" ? "Suspended" : "Reactivated"} ${r.affected} membership(s).`;
        }
        case "staff-role":
          await platformApi.changeStaffRole(d.platform!.id, { role: staffRole, version: d.platform!.version });
          return `Platform role changed to ${platformRoleLabel(staffRole)}.`;
        case "staff-suspend":
        case "staff-reactivate":
          await platformApi.staffAction(d.platform!.id, p.kind === "staff-suspend" ? "suspend" : "reactivate", reason);
          return `Platform access ${p.kind === "staff-suspend" ? "suspended" : "reactivated"}.`;
        case "session":
          if (p.platform) await platformApi.revokeStaffSessions(d.platform!.id, p.sessionId);
          else await platformApi.revokeSession(p.sessionId);
          return "Session ended.";
      }
    },
    onSuccess: async (message) => {
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
      setNotice(message);
      setPending(null);
      setConfirmNoAdmin(false);
    },
  });

  const back = (
    <Link href="/platform/users" className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
      <ArrowLeft size={14} /> Users
    </Link>
  );
  if (detail.isError)
    return (
      <PlatformPage title="User" back={back}>
        <ErrorPanel error={detail.error} onRetry={() => detail.refetch()} />
      </PlatformPage>
    );
  if (!detail.data)
    return (
      <PlatformPage title="Loading…" back={back}>
        <Skeleton className="h-48 w-full" />
      </PlatformPage>
    );
  const d = detail.data;
  const canMembers = can("MANAGE_MEMBERSHIPS");
  const canAccess = can("MANAGE_ACCOUNT_ACCESS");
  const isMe = !!me && d.platform?.id === me.id;
  const canStaff = !!me && !!d.platform && !isMe && canManagePlatformRole(me.role, d.platform.role);
  const lastAdminError = act.error instanceof ApiError && act.error.message === "last_tenant_admin";

  const open = (p: Pending) => {
    act.reset();
    setConfirmNoAdmin(false);
    if (p.kind === "role") setRole(p.m.role);
    if (p.kind === "staff-role" && d.platform) setStaffRole(d.platform.role);
    setPending(p);
  };

  const dialog = (() => {
    if (!pending) return null;
    switch (pending.kind) {
      case "role":
        return { title: `Change role in ${pending.m.tenantName}`, description: "The new role decides what this person can do from their very next request.", confirm: "Change role", danger: false, reason: false };
      case "suspend":
        return { title: `Suspend in ${pending.m.tenantName}`, description: "They are signed out of this hospital at once and cannot sign in to it. Their other memberships and all history stay.", confirm: "Suspend", danger: true, reason: true };
      case "reactivate":
        return { title: `Reactivate in ${pending.m.tenantName}`, description: "They can sign in to this hospital again (or finish accepting their invitation).", confirm: "Reactivate", danger: false, reason: true };
      case "remove":
        return { title: `Remove from ${pending.m.tenantName}`, description: "They lose access to this hospital and are signed out. The person, their other memberships and everything they did stay intact.", confirm: "Remove membership", danger: true, reason: true };
      case "reset":
        return { title: "Send a password reset link", description: `A single-use link goes to ${d.email}. Nobody at Invictus sees or sets the new password. Using the link signs them out of every session of this membership.`, confirm: "Send link", danger: false, reason: false };
      case "signout":
        return { title: `Sign out everywhere in ${pending.m.tenantName}`, description: "Every open session of this membership ends now. They can sign in again.", confirm: "Sign out", danger: true, reason: false };
      case "identity-suspend":
        return { title: `Suspend ${d.name} everywhere`, description: "Every hospital membership is suspended and every session ends. Platform access (if any) is managed separately. Nothing is deleted.", confirm: "Suspend everywhere", danger: true, reason: true };
      case "identity-reactivate":
        return { title: `Reactivate ${d.name}`, description: "Every suspended membership becomes active again (or invited, if they never set a password).", confirm: "Reactivate", danger: false, reason: true };
      case "staff-role":
        return { title: "Change platform role", description: "Platform roles decide what this staff member can do in the console. Only a Platform Owner grants Owner and Admin.", confirm: "Change role", danger: false, reason: false };
      case "staff-suspend":
        return { title: "Suspend platform access", description: "They are signed out of the console at once. There must always be at least one active Platform Owner.", confirm: "Suspend access", danger: true, reason: true, typed: "SUSPEND" };
      case "staff-reactivate":
        return { title: "Reactivate platform access", description: "They can sign in to the console again.", confirm: "Reactivate", danger: false, reason: true };
      case "session":
        return { title: "End this session", description: `${pending.label} will be signed out.`, confirm: "End session", danger: true, reason: false };
    }
  })();

  return (
    <PlatformPage
      title={d.name}
      subtitle={d.email}
      back={back}
      testId="platform-user-detail"
      actions={
        <>
          <AccountStatusBadge status={d.status} />
          {can("SUSPEND_ACCOUNTS") && d.memberships.length > 0 && (d.memberships.some((m) => m.status === "SUSPENDED") && !d.memberships.some((m) => m.status === "ACTIVE" || m.status === "INVITED") ? (
            <Button onClick={() => open({ kind: "identity-reactivate" })}>Reactivate account</Button>
          ) : d.memberships.some((m) => m.status === "ACTIVE" || m.status === "INVITED") ? (
            <Button variant="danger" onClick={() => open({ kind: "identity-suspend" })} data-testid="suspend-identity">
              Suspend account
            </Button>
          ) : null)}
        </>
      }
    >
      {notice && (
        <p role="status" className="rounded-card border border-line bg-surface-info px-4 py-2.5 text-sm text-ink" data-testid="user-notice">
          {notice}
        </p>
      )}

      <Panel title="Identity">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Email">{d.email}</Fact>
          <Fact label="Account status">
            <AccountStatusBadge status={d.status} />
          </Fact>
          <Fact label="Created">{fmtWhen(d.createdAt)}</Fact>
          <Fact label="Last sign-in">{fmtAgo(d.lastSignInAt)}</Fact>
        </dl>
        <p className="mt-3 text-xs text-ink-2">Passwords are never visible here. Use a reset link; the person chooses their own password.</p>
      </Panel>

      <Panel title="Hospital memberships" subtitle={`${d.memberships.length}`} padded={false} data-testid="user-memberships">
        {d.memberships.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-2">Not a member of any hospital.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHead>
                <tr>
                  <Th leading>Hospital</Th>
                  <Th>Role</Th>
                  <Th>Membership</Th>
                  <Th>Hospital status</Th>
                  <Th>Last sign-in</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </TableHead>
              <TableBody>
                {d.memberships.map((m) => {
                  const items = [
                    ...(canMembers && m.status !== "REMOVED" ? [{ key: "role", label: "Change role", onClick: () => open({ kind: "role", m }) }] : []),
                    ...(canAccess && m.status === "ACTIVE" ? [{ key: "reset", label: "Send password reset", onClick: () => open({ kind: "reset", m }) }] : []),
                    ...(canAccess && m.status === "ACTIVE" ? [{ key: "signout", label: "Sign out everywhere", onClick: () => open({ kind: "signout", m }) }] : []),
                    ...(canMembers && m.status === "SUSPENDED" ? [{ key: "reactivate", label: "Reactivate", onClick: () => open({ kind: "reactivate", m }) }] : []),
                    ...(canMembers && (m.status === "ACTIVE" || m.status === "INVITED") ? [{ key: "suspend", label: "Suspend membership", danger: true, onClick: () => open({ kind: "suspend", m }) }] : []),
                    ...(canMembers && m.status !== "REMOVED" ? [{ key: "remove", label: "Remove membership", danger: true, onClick: () => open({ kind: "remove", m }) }] : []),
                  ];
                  return (
                    <Tr key={m.userId} data-testid={`membership-${m.tenantSlug ?? m.tenantId}`}>
                      <Td leading nowrap={false}>
                        <Link href={`/platform/tenants/${m.tenantId}`} className="font-medium text-ink hover:text-primary-700">
                          {m.tenantName}
                        </Link>
                        {m.primaryAdmin && (
                          <span className="ml-1.5">
                            <Badge tone="primary">Primary admin</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>{roleGroupLabel(m.role)}</Td>
                      <Td>
                        <AccountStatusBadge status={m.status} />
                      </Td>
                      <Td>
                        <TenantStatusBadge status={m.tenantStatus} />
                      </Td>
                      <Td>{fmtAgo(m.lastSignInAt)}</Td>
                      <Td>{items.length > 0 && <RowMenu label={`Actions for ${m.tenantName}`} items={items} testId={`membership-menu-${m.tenantSlug ?? m.tenantId}`} />}</Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {d.platform && (
        <Panel
          title="Platform access"
          subtitle="Invictus staff access to this console"
          data-testid="user-platform-access"
          action={
            canStaff && (
              <span className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => open({ kind: "staff-role" })}>
                  Change role
                </Button>
                {d.platform.status === "SUSPENDED" ? (
                  <Button size="sm" onClick={() => open({ kind: "staff-reactivate" })}>
                    Reactivate
                  </Button>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => open({ kind: "staff-suspend" })} data-testid="suspend-staff">
                    Suspend
                  </Button>
                )}
              </span>
            )
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Fact label="Platform role">{platformRoleLabel(d.platform.role)}</Fact>
            <Fact label="Status">
              <AccountStatusBadge status={d.platform.status} />
            </Fact>
            <Fact label="Last console sign-in">{fmtAgo(d.platform.lastSignInAt)}</Fact>
            <Fact label="Since">{fmtWhen(d.platform.createdAt)}</Fact>
          </dl>
          {isMe && <p className="mt-3 text-xs text-ink-2">This is you. Your own platform access can only be changed by another authorised staff member.</p>}
        </Panel>
      )}

      <Panel title="Active sessions" subtitle="Device, address and activity of every open session" padded={false} data-testid="user-sessions">
        {d.sessions.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-2">No open sessions.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHead>
                <tr>
                  <Th leading>Where</Th>
                  <Th>Device</Th>
                  <Th>Address</Th>
                  <Th>Started</Th>
                  <Th>Last active</Th>
                  <Th>Expires</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </TableHead>
              <TableBody>
                {d.sessions.map((s) => {
                  const allowed = s.kind === "tenant" ? canAccess : isMe || canStaff;
                  return (
                    <Tr key={s.id}>
                      <Td leading>{s.context}</Td>
                      <Td>
                        <span title={s.userAgent ?? undefined}>{deviceLabel(s.userAgent)}</span>
                      </Td>
                      <Td>{s.ipAddress ?? "—"}</Td>
                      <Td>{fmtWhen(s.createdAt)}</Td>
                      <Td>{fmtAgo(s.lastSeenAt)}</Td>
                      <Td>{fmtWhen(s.expiresAt)}</Td>
                      <Td>
                        {allowed && (
                          <Button size="sm" variant="ghost" onClick={() => open({ kind: "session", sessionId: s.id, platform: s.kind === "platform", label: `${deviceLabel(s.userAgent)} (${s.context})` })} data-testid="revoke-session">
                            End
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Invitations & reset links" padded={false}>
          {d.invitations.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-2">None.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {d.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="text-ink">{i.purpose === "INVITE" ? "Invitation" : "Password reset"}</span>
                    <span className="text-ink-2"> · {i.tenantName ?? "Platform Console"}</span>
                    <span className="block text-[11px] text-ink-2">
                      Created {fmtWhen(i.createdAt)} · expires {fmtWhen(i.expiresAt)} · {i.deliveryStatus === "SENT" ? "delivered" : "not delivered"}
                    </span>
                  </span>
                  <Badge tone={i.status === "PENDING" ? "primary" : i.status === "ACCEPTED" ? "success" : "neutral"}>{i.status.toLowerCase()}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Security & admin history" padded={false} data-testid="user-history">
          {d.history.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-2">No platform actions yet.</p>
          ) : (
            <ul className="max-h-[420px] divide-y divide-neutral-100 overflow-y-auto">
              {d.history.map((h) => (
                <li key={h.id} className="px-4 py-2.5 text-sm">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-ink">{h.summary}</span>
                    <span className="text-xs text-ink-2">{fmtAgo(h.at)}</span>
                  </span>
                  <span className="block text-[11px] text-ink-2">
                    by {h.actor}
                    {h.context === "SUPPORT_MODE" ? " · support mode" : ""}
                    {h.reason ? ` · “${h.reason}”` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <ActionDialog
        open={!!pending && !!dialog}
        title={dialog?.title ?? ""}
        description={dialog?.description ?? ""}
        confirmLabel={dialog?.confirm ?? ""}
        danger={dialog?.danger}
        requireReason={dialog?.reason}
        typedConfirmation={dialog && "typed" in dialog ? dialog.typed : undefined}
        pending={act.isPending}
        error={act.error}
        onConfirm={(reason) => act.mutate(reason)}
        onCancel={() => setPending(null)}
      >
        {pending?.kind === "role" && (
          <FormField label="New role" htmlFor="new-role">
            <select id="new-role" className={CONTROL} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {TENANT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </FormField>
        )}
        {pending?.kind === "staff-role" && me && (
          <FormField label="New platform role" htmlFor="new-staff-role">
            <select id="new-staff-role" className={CONTROL} value={staffRole} onChange={(e) => setStaffRole(e.target.value as PlatformRole)}>
              {PLATFORM_ROLES.filter((r) => canManagePlatformRole(me.role, r.key)).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </FormField>
        )}
        {lastAdminError && (
          <label className="flex items-start gap-2 rounded-control border border-warning-500/40 bg-warning-100/60 px-3 py-2 text-xs text-ink">
            <input type="checkbox" checked={confirmNoAdmin} onChange={(e) => setConfirmNoAdmin(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary-600" data-testid="confirm-no-admin" />
            I understand this leaves the hospital without an active administrator, and I confirm it.
          </label>
        )}
      </ActionDialog>
    </PlatformPage>
  );
}
