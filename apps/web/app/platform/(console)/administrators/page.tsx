"use client";

import { useState, type FormEvent } from "react";
import { platformApi } from "@pulseos/api-client";
import { PLATFORM_ONBOARDING_GRANTS, PLATFORM_ROLES, type PlatformRole } from "@pulseos/types";
import { buttonClass, date, Failure, inputClass, label, Loading, PageControls, PageTitle, panelClass, secondaryClass, usePlatformAccount, usePlatformQuery } from "../platform-ui";

type Member = Awaited<ReturnType<typeof platformApi.administrators>>["items"][number];
type Change = Parameters<typeof platformApi.updateAdministrator>[1];

const grantLabels = {
  "hospital:create": "Create hospitals", "hospital:invite": "Issue hospital invitations",
  "hospital:retry": "Retry department templates", "hospital:activate": "Activate hospitals",
};

function RoleFields({ member }: { member?: Member }) {
  const [role, setRole] = useState<PlatformRole>(member?.role ?? "PLATFORM_OPERATIONS_ADMIN");
  return <>
    <label className="block text-sm font-medium">Platform role
      <select className={inputClass} name="role" value={role} onChange={(event) => setRole(event.target.value as PlatformRole)}>
        {PLATFORM_ROLES.map((option) => <option key={option} value={option}>{label(option.toLowerCase())}</option>)}
      </select>
    </label>
    {role === "PLATFORM_OPERATIONS_ADMIN" && <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
      <legend className="mb-1 text-sm font-medium">Onboarding permissions</legend>
      {PLATFORM_ONBOARDING_GRANTS.map((grant) => <label className="text-sm" key={grant}>
        <input className="mr-1" type="checkbox" name="permission" value={grant} defaultChecked={member?.role === "PLATFORM_OPERATIONS_ADMIN" && member.permissions.includes(grant)} />{grantLabels[grant]}
      </label>)}
    </fieldset>}
  </>;
}

export default function Team() {
  const [page, setPage] = useState(1);
  const [token, setToken] = useState<{ value: string; expiry?: string; recovery?: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [auditId, setAuditId] = useState<string | null>(null);
  const account = usePlatformAccount();
  const query = usePlatformQuery(["administrators", String(page)], () => platformApi.administrators(page));

  async function submit(event: FormEvent<HTMLFormElement>, member?: Member) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form, (event.nativeEvent as SubmitEvent).submitter);
    const role = String(fields.get("role")) as PlatformRole;
    const permissions = PLATFORM_ONBOARDING_GRANTS.filter((grant) => fields.getAll("permission").includes(grant));
    const changes: Change = { role, permissions, disabled: fields.get("disabled") === "on", reissue: fields.has("reissue") };
    setWorking(true);
    setError(undefined);
    setNotice("");
    setToken(null);
    try {
      const result = member ? await platformApi.updateAdministrator(member.id, changes)
        : await platformApi.inviteAdministrator({ email: String(fields.get("email")), role, permissions });
      if (result.setupToken) setToken({ value: result.setupToken, expiry: result.expiresAt });
      if (!member) form.reset();
      void query.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setWorking(false);
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form, (event.nativeEvent as SubmitEvent).submitter);
    const action = fields.get("action");
    if (action !== "request" && action !== "approve" && action !== "reject") return;
    setWorking(true);
    setError(undefined);
    setNotice("");
    setToken(null);
    try {
      const result = await platformApi.administratorRecovery(member.id,
        action === "approve" ? { action, code: String(fields.get("code")) } : { action });
      if (result.recoveryToken) setToken({ value: result.recoveryToken, expiry: result.expiresAt, recovery: true });
      setNotice(action === "request" ? "Recovery request created." : action === "reject" ? "Recovery request rejected." : "Recovery approved. Existing sessions were revoked.");
      await query.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      form.reset();
      setWorking(false);
    }
  }

  if (query.isError) return <Failure error={query.error} />;
  return <>
    <PageTitle title="Platform administrators" />
    <form className={panelClass + " mb-4 space-y-3"} onSubmit={(event) => submit(event)}>
      <h2 className="font-semibold">Invite an administrator</h2>
      <label className="block text-sm font-medium">Platform email<input type="email" name="email" className={inputClass} maxLength={254} required /></label>
      <RoleFields />
      <button className={buttonClass} disabled={working}>Create setup token</button>
    </form>
    {error !== undefined && <Failure error={error} />}
    {notice && <p role="status">{notice}</p>}
    {token && <section className={panelClass + " mb-4 space-y-3"}>
      <p>Deliver this one-time token securely. {token.recovery ? "The administrator needs their current password and a new authenticator." : "The administrator sets a password and enrolls an authenticator."} {token.expiry && "Expires " + date(token.expiry) + "."}</p>
      <label className="block text-sm">{token.recovery ? "Administrator recovery token" : "Administrator setup token"}<input readOnly value={token.value} className={inputClass} autoComplete="off" /></label>
      <button className={secondaryClass} onClick={() => setToken(null)}>Hide token</button>
    </section>}
    {query.isPending && <Loading />}
    <div className="space-y-3">
      {query.data?.items.map((member) => <details key={member.id} className={panelClass}>
        <summary className="cursor-pointer break-all font-medium">{member.email} <span className="ml-2 text-sm text-neutral-600">{member.disabled ? "Disabled" : member.enrolled ? "MFA enrolled" : "Awaiting MFA setup"}</span></summary>
        <form key={JSON.stringify(member)} className="mt-3 space-y-3" onSubmit={(event) => submit(event, member)}>
          <RoleFields member={member} />
          <label className="block text-sm"><input className="mr-1" type="checkbox" name="disabled" defaultChecked={member.disabled} />Disable account</label>
          <div className="flex flex-wrap gap-3">
            <button className={buttonClass} disabled={working}>Save changes</button>
            {!member.enrolled && !member.canRecover && <button className={secondaryClass} name="reissue" value="1" disabled={working}>Replace setup token</button>}
          </div>
        </form>
        {member.canRecover && <section className="mt-4 space-y-2 border-t pt-3">
          <h3 className="font-medium">MFA recovery</h3>
          {member.recovery && <p className="text-sm">{label(member.recovery.status)} · Expires {date(member.recovery.expiresAt)}</p>}
          {!member.disabled && account.data?.id !== member.id && <form className="space-y-2" onSubmit={(event) => recover(event, member)}>
            {member.recovery?.status === "pending" ? <>
              {member.recovery.canApprove
                ? <label className="block text-sm">Your current authenticator code<input className={inputClass} name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required /></label>
                : <p className="text-sm">A different Super Admin must approve this request. If the requester is unavailable in the record, reject it and start a new request.</p>}
              <div className="flex flex-wrap gap-2">
                {member.recovery.canApprove && <button className={buttonClass} name="action" value="approve" disabled={working}>Approve recovery</button>}
                <button className={secondaryClass} name="action" value="reject" formNoValidate disabled={working}>Reject recovery</button>
              </div>
            </> : member.recovery?.status !== "approved" && <button className={secondaryClass} name="action" value="request" disabled={working}>Request MFA recovery</button>}
          </form>}
          <button type="button" className={secondaryClass} onClick={() => setAuditId(auditId === member.id ? null : member.id)}>Recovery history</button>
          {auditId === member.id && <RecoveryHistory id={member.id} />}
        </section>}
      </details>)}
    </div>
    <PageControls page={page} hasMore={query.data?.hasMore ?? false} onPage={setPage} />
  </>;
}

function RecoveryHistory({ id }: { id: string }) {
  const query = usePlatformQuery(["administrator-recovery-history", id], () => platformApi.administratorRecoveryHistory(id));
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failure error={query.error} />;
  return query.data.items.length ? <ul className="space-y-1 text-sm">
    {query.data.items.map((item) => <li key={item.id}>{label(item.action)} · {date(item.createdAt)}{item.actorId && " · " + item.actorId}</li>)}
  </ul> : <p className="text-sm">No recovery events.</p>;
}
