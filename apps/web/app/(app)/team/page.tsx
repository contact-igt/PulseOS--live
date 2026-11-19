"use client";

import { useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, UserPlus, Users } from "lucide-react";
import { ApiError, api } from "@pulseos/api-client";
import { canCreateHospitalTeamRole, HOSPITAL_TEAM_ROLES, type HospitalTeamRole, type Role } from "@pulseos/types";

const roleLabels: Record<Role, string> = {
  SUPER_ADMIN: "Hospital Super Admin", HOSPITAL_ADMIN: "Hospital Admin",
  FRONT_DESK: "Front Desk", PATIENT_COORDINATOR: "Patient Coordinator", DOCTOR: "Doctor",
};
const inputClass = "mt-1 block w-full rounded-control border border-neutral-300 bg-white px-3 py-2.5 text-sm";

type TeamForm = { name: string; email: string; role: HospitalTeamRole; branchId: string; password: string; confirmPassword: string };
const workEmail = z.string().email();

function fieldState(id: string, error?: string) {
  return {
    className: `${inputClass}${error ? " border-red-600" : ""}`,
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? `${id}-error` : undefined,
  };
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span id={`${id}-error`} role="alert" className="mt-1 block text-sm text-red-700">{message}</span> : null;
}

function TeamPasswordInput({ field, label, error }: { field: UseFormRegisterReturn; label: string; error?: string }) {
  const [visible, setVisible] = useState(false);
  const id = `team-${field.name}`;
  const Icon = visible ? EyeOff : Eye;
  const { className, ...state } = fieldState(id, error);

  return <div className="text-sm font-medium">
    <label htmlFor={id}>{label}</label>
    <div className="relative mt-1">
      <input id={id} {...field} {...state} className={`${className} pr-12`} type={visible ? "text" : "password"}
        autoComplete="new-password" minLength={12} maxLength={128} required />
      <button type="button" aria-controls={id} aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-control text-neutral-600 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-700"
        onClick={() => setVisible(!visible)}>
        <Icon size={18} aria-hidden="true" />
      </button>
    </div>
    <FieldError id={id} message={error} />
  </div>;
}

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
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { register, handleSubmit, reset, formState: { errors: fields } } = useForm<TeamForm>();
  const eligibleRoles = actor ? HOSPITAL_TEAM_ROLES.filter((role) => canCreateHospitalTeamRole(actor.role, role)) : [];

  async function submit({ name, email, role, branchId, password }: TeamForm) {
    if (working) return;
    setError("");
    setNotice("");
    setWorking(true);
    try {
      const member = await api.createHospitalTeamMember({
        name, email, role, branchId, password,
      });
      setNotice(`${member.name} can now sign in through your hospital’s sign-in page.`);
      setShowForm(false);
      reset();
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
          disabled={working} onClick={() => { reset(); setShowForm(!showForm); setError(""); }}>
          <UserPlus size={17} aria-hidden="true" /> {showForm ? "Close form" : "Add team member"}
        </button>}
      </header>
      {showForm && <form id="hospital-team-form" className="space-y-4 border-b border-primary-100 bg-primary-50/50 p-4 sm:p-6" noValidate onSubmit={handleSubmit(submit)}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="text-sm font-medium"><label htmlFor="team-name">Full name</label><input id="team-name" {...fieldState("team-name", fields.name?.message)}
            {...register("name", { setValueAs: (value: string) => value.trim(), required: "Enter the full name.", minLength: { value: 2, message: "Enter at least 2 characters." } })}
            autoComplete="off" maxLength={80} required /><FieldError id="team-name" message={fields.name?.message} /></div>
          <div className="text-sm font-medium"><label htmlFor="team-email">Work email</label><input id="team-email" {...fieldState("team-email", fields.email?.message)}
            {...register("email", { setValueAs: (value: string) => value.trim(), required: "Enter a work email.", validate: (value) => workEmail.safeParse(value).success || "Enter a valid email address." })}
            type="email" autoComplete="off" maxLength={254} required /><FieldError id="team-email" message={fields.email?.message} /></div>
          <div className="text-sm font-medium"><label htmlFor="team-role">Hospital role</label><select id="team-role" {...fieldState("team-role", fields.role?.message)}
            {...register("role", { required: "Select a hospital role." })} defaultValue="" required>
            <option value="" disabled>Select a role</option>
            {eligibleRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
          </select><FieldError id="team-role" message={fields.role?.message} /></div>
          <div className="text-sm font-medium"><label htmlFor="team-branch">Branch</label><select id="team-branch" {...fieldState("team-branch", fields.branchId?.message)}
            {...register("branchId", { required: "Select a branch." })} defaultValue="" required>
            <option value="" disabled>Select a branch</option>
            {branches.data?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select><FieldError id="team-branch" message={fields.branchId?.message} /></div>
          <TeamPasswordInput label="Initial password" error={fields.password?.message} field={register("password", {
            required: "Enter an initial password.",
            minLength: { value: 12, message: "Use at least 12 characters." },
          })} />
          <TeamPasswordInput label="Confirm password" error={fields.confirmPassword?.message} field={register("confirmPassword", {
            required: "Confirm the password.",
            validate: (value, form) => value === form.password || "Passwords do not match.",
          })} />
        </div>
        <p className="text-sm text-neutral-600">Use at least 12 characters and share the password through a secure channel.</p>
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
