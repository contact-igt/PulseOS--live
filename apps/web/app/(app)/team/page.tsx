"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, UserPlus, Users } from "lucide-react";
import { ApiError, api } from "@pulseos/api-client";
import { canCreateHospitalTeamRole, HOSPITAL_TEAM_ROLES, type HospitalTeamRole, type Role } from "@pulseos/types";

const roleLabels: Record<Role, string> = {
  SUPER_ADMIN: "Hospital Super Admin", HOSPITAL_ADMIN: "Hospital Admin",
  FRONT_DESK: "Front Desk", PATIENT_COORDINATOR: "Patient Coordinator", DOCTOR: "Doctor",
};
const inputClass = "mt-1 block w-full rounded-control border border-neutral-300 bg-white px-3 py-2.5 text-sm";
const errors: Record<string, string> = {
  email_in_use: "This email is already associated with a PulseOS account.",
  invalid_branch: "Choose a branch in this hospital.",
  invalid_password: "Choose a password different from the email address.",
  forbidden: "Your role cannot create this account.",
  hospital_unavailable: "The hospital must be active to create an account.",
  invalid_request: "Check the account details and password requirements.",
};

export default function HospitalTeamPage() {
  const cache = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const actor = session.data?.user;
  const teamKey = ["hospital-team", actor?.tenantId];
  const team = useQuery({ queryKey: teamKey, queryFn: api.hospitalTeam, enabled: Boolean(actor) });
  const branches = useQuery({ queryKey: ["hospital-team-branches", actor?.tenantId], queryFn: api.branches, enabled: Boolean(actor) });
  const [showForm, setShowForm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const eligibleRoles = actor ? HOSPITAL_TEAM_ROLES.filter((role) => canCreateHospitalTeamRole(actor.role, role)) : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    const form = new FormData(event.currentTarget);
    const read = (field: string) => String(form.get(field) ?? "");
    const password = read("password");
    setError("");
    setNotice("");
    if (password !== read("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    setWorking(true);
    try {
      const member = await api.createHospitalTeamMember({
        name: read("name"), email: read("email"), role: read("role") as HospitalTeamRole,
        branchId: read("branchId"), password,
      });
      setNotice(`${member.name} can now sign in through your hospital’s sign-in page.`);
      setShowForm(false);
      setShowPassword(false);
      void cache.invalidateQueries({ queryKey: teamKey });
      void cache.invalidateQueries({ queryKey: ["lookups"] });
    } catch (failure) {
      setError(failure instanceof ApiError ? errors[failure.message] ?? "Could not create the account. Try again." : "Could not create the account. Try again.");
    } finally {
      setWorking(false);
    }
  }

  return <div className="space-y-5">
    {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</p>}
    <section className="overflow-hidden rounded-xl border border-primary-100 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-primary-100 p-4 sm:px-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Users size={20} className="text-primary-700" aria-hidden="true" /> Hospital team</h2>
        {eligibleRoles.length > 0 && <button type="button" aria-expanded={showForm} aria-controls="hospital-team-form"
          className="inline-flex items-center gap-2 rounded-control bg-primary-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={working} onClick={() => { setShowForm(!showForm); setShowPassword(false); setError(""); }}>
          <UserPlus size={17} aria-hidden="true" /> {showForm ? "Close form" : "Add team member"}
        </button>}
      </header>
      {showForm && <form id="hospital-team-form" className="space-y-4 border-b border-primary-100 bg-primary-50/50 p-4 sm:p-6" onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium">Full name<input name="name" className={inputClass} autoComplete="off" minLength={2} maxLength={80} required /></label>
          <label className="text-sm font-medium">Work email<input name="email" className={inputClass} type="email" autoComplete="off" maxLength={254} required /></label>
          <label className="text-sm font-medium">Hospital role<select name="role" className={inputClass} defaultValue="" required>
            <option value="" disabled>Select a role</option>
            {eligibleRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
          </select></label>
          <label className="text-sm font-medium">Branch<select name="branchId" className={inputClass} defaultValue="" required>
            <option value="" disabled>Select a branch</option>
            {branches.data?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select></label>
          <label className="text-sm font-medium">Initial password<input name="password" className={inputClass} type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <label className="text-sm font-medium">Confirm password<input name="confirmPassword" className={inputClass} type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" className="inline-flex items-center gap-2 text-sm font-semibold text-primary-700" onClick={() => setShowPassword(!showPassword)}>
            {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            {showPassword ? "Hide passwords" : "Show passwords"}
          </button>
          <p className="text-sm text-neutral-600">Use at least 12 characters and share the password through a secure channel.</p>
        </div>
        {branches.isError && <p role="alert" className="text-sm text-red-700">Couldn’t load hospital branches.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={working || !branches.data?.length} className="rounded-control bg-primary-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {working ? "Creating account…" : "Create account"}
        </button>
      </form>}
      {team.isPending && <p role="status" className="p-5 text-sm">Loading hospital team…</p>}
      {team.isError && <p role="alert" className="p-5 text-sm text-red-700">Couldn’t load the hospital team.</p>}
      {team.data?.items.length === 0 && <p className="p-5 text-sm text-neutral-600">No team members found.</p>}
      {!!team.data?.items.length && <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-primary-50 text-neutral-700"><tr>{["Name", "Email", "Role", "Branch"].map((title) =>
            <th key={title} scope="col" className="px-4 py-3 font-semibold">{title}</th>)}</tr></thead>
          <tbody className="divide-y divide-primary-100">{team.data.items.map((member) => <tr key={member.id}>
            <th scope="row" className="px-4 py-3.5 font-semibold">{member.name}</th>
            <td className="px-4 py-3.5">{member.email}</td>
            <td className="px-4 py-3.5"><span className="inline-block rounded-full bg-primary-50 px-2.5 py-1 text-xs font-medium text-primary-800">{roleLabels[member.role]}</span></td>
            <td className="px-4 py-3.5">{member.branchName ?? "Unassigned"}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  </div>;
}
