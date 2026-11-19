"use client";

import { useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, ShieldCheck, UserPlus, Users } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { PLATFORM_ONBOARDING_GRANTS, PLATFORM_ROLES, type PlatformRole } from "@pulseos/types";
import { buttonClass, date, Failure, inputClass, label, Loading, PageControls, PageTitle, panelClass, secondaryClass, usePlatformAccount, usePlatformQuery } from "../platform-ui";

type Member = Awaited<ReturnType<typeof platformApi.administrators>>["items"][number];
type Change = Parameters<typeof platformApi.updateAdministrator>[1];

const roleLabels: Record<PlatformRole, string> = {
  PLATFORM_SUPER_ADMIN: "Platform Super Admin",
  PLATFORM_OPERATIONS_ADMIN: "Platform Operations Admin",
};
const checkboxClass = "size-4 shrink-0 accent-primary-700";

const grantLabels = {
  "hospital:create": "Create hospitals", "hospital:invite": "Issue hospital invitations",
  "hospital:retry": "Retry department templates", "hospital:activate": "Activate hospitals",
};

function RoleFields({ member }: { member?: Member }) {
  const [role, setRole] = useState<PlatformRole>(member?.role ?? "PLATFORM_OPERATIONS_ADMIN");
  return <>
    <label className="block text-sm font-medium">Platform role
      <select className={inputClass} name="role" value={role} onChange={(event) => setRole(event.target.value as PlatformRole)}>
        {PLATFORM_ROLES.map((option) => <option key={option} value={option}>{roleLabels[option]}</option>)}
      </select>
    </label>
    {role === "PLATFORM_OPERATIONS_ADMIN" && <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-medium">Onboarding permissions</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {PLATFORM_ONBOARDING_GRANTS.map((grant) => <label className="flex cursor-pointer items-start gap-2.5 rounded-control border border-primary-100 bg-white px-3 py-2.5 text-sm hover:bg-primary-50" key={grant}>
          <input className={checkboxClass} type="checkbox" name="permission" value={grant} defaultChecked={member?.role === "PLATFORM_OPERATIONS_ADMIN" && member.permissions.includes(grant)} />
          {grantLabels[grant]}
        </label>)}
      </div>
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

  return <>
    <PageTitle title="Platform administrators" />
    {error !== undefined && <Failure error={error} />}
    {notice && <p role="status" className="mb-4 rounded-control border border-primary-200 bg-primary-50 px-4 py-3 text-sm font-medium text-primary-900">{notice}</p>}
    {token && <section className={panelClass + " mb-5 space-y-3 border-primary-200"}>
      <h2 className="flex items-center gap-2 font-semibold"><KeyRound size={18} className="text-primary-700" aria-hidden="true" />{token.recovery ? "Recovery token ready" : "Setup token ready"}</h2>
      <p className="text-sm text-neutral-600">Deliver this one-time token securely. {token.recovery ? "The administrator needs their current password and a new authenticator." : "The administrator sets a password and enrolls an authenticator."} {token.expiry && "Expires " + date(token.expiry) + "."}</p>
      <label className="block text-sm font-medium">{token.recovery ? "Administrator recovery token" : "Administrator setup token"}<input readOnly value={token.value} className={inputClass + " mt-1 font-mono"} autoComplete="off" /></label>
      <button type="button" className={secondaryClass} onClick={() => setToken(null)}>Hide token</button>
    </section>}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <section aria-labelledby="platform-accounts" className={panelClass + " min-w-0"}>
        <h2 id="platform-accounts" className="mb-4 flex items-center gap-2.5 text-base font-semibold">
          <span className="grid size-9 place-items-center rounded-control bg-primary-50 text-primary-700"><Users size={18} aria-hidden="true" /></span>
          Administrator accounts
        </h2>
        {query.isPending && <Loading />}
        {query.isError && <Failure error={query.error} />}
        {query.data?.items.length === 0 && <p className="rounded-control bg-primary-50 p-4 text-sm text-neutral-600">No administrator accounts on this page.</p>}
        <div className="space-y-2">
      {query.data?.items.map((member) => <details key={member.id} className="group rounded-xl border border-primary-100 bg-white open:border-primary-200">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 rounded-xl p-3.5 hover:bg-primary-50 [&::-webkit-details-marker]:hidden">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-50 text-primary-700"><ShieldCheck size={18} aria-hidden="true" /></span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold">{member.email}</span>
            <span className="block text-xs text-neutral-600">{roleLabels[member.role]}</span>
          </span>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${member.disabled ? "bg-neutral-100 text-neutral-700" : member.enrolled ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
            {member.disabled ? "Disabled" : member.enrolled ? "MFA enrolled" : "Awaiting MFA setup"}
          </span>
          <ChevronDown size={17} className="shrink-0 text-neutral-600 group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-4 border-t border-primary-100 p-4">
        <form key={JSON.stringify(member)} className="space-y-3" onSubmit={(event) => submit(event, member)}>
          <RoleFields member={member} />
          <label className="flex items-center gap-2.5 text-sm"><input className={checkboxClass} type="checkbox" name="disabled" defaultChecked={member.disabled} />Disable account</label>
          <div className="flex flex-wrap gap-3">
            <button className={buttonClass} disabled={working}>Save changes</button>
            {!member.enrolled && !member.canRecover && <button className={secondaryClass} name="reissue" value="1" disabled={working}>Replace setup token</button>}
          </div>
        </form>
        {member.canRecover && <section className="space-y-3 rounded-xl border border-primary-100 bg-primary-50/50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound size={16} className="text-primary-700" aria-hidden="true" />MFA recovery</h3>
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
        </div>
      </details>)}
        </div>
        {query.data && <PageControls page={page} hasMore={query.data.hasMore} onPage={setPage} />}
      </section>
      <form className={panelClass + " min-w-0 space-y-4"} onSubmit={(event) => submit(event)}>
        <h2 className="flex items-center gap-2.5 text-base font-semibold">
          <span className="grid size-9 place-items-center rounded-control bg-primary-50 text-primary-700"><UserPlus size={18} aria-hidden="true" /></span>
          Invite an administrator
        </h2>
        <label className="block text-sm font-medium">Platform email<input type="email" name="email" className={inputClass + " mt-1"} maxLength={254} required /></label>
        <RoleFields />
        <button type="submit" className={buttonClass} disabled={working}>Create setup token</button>
      </form>
    </div>
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
