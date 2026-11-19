"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, platformApi } from "@pulseos/api-client";
import type { PlatformAuditEvent, PlatformHospital } from "@pulseos/types";

export const inputClass = "w-full rounded-control border border-neutral-300 px-3 py-2 text-sm";
export const buttonClass = "inline-flex rounded-control bg-primary-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
export const secondaryClass = "inline-flex rounded-control border border-neutral-300 px-3 py-2 text-sm font-semibold disabled:opacity-50";
export const panelClass = "rounded-xl border border-primary-100 bg-white p-5 shadow-sm shadow-primary-900/5";

export function usePlatformAccount() {
  return useQuery({ queryKey: ["platform", "me"], queryFn: platformApi.me, retry: false, refetchOnWindowFocus: false });
}

export function usePlatformQuery<T>(key: string[], queryFn: () => Promise<T>) {
  return useQuery({ queryKey: ["platform", ...key], queryFn, retry: false, refetchOnWindowFocus: false });
}

export function Loading() {
  return <p role="status">Loading…</p>;
}

export function Failure({ error }: { error: unknown }) {
  const code = error instanceof ApiError ? error.message : "";
  const copy: Record<string, string> = {
    last_super_admin: "Keep at least one active, MFA-enrolled Platform Super Admin.",
    email_in_use: "That email is already in use.",
    invalid_phone: "Enter a valid phone number.",
    idempotency_conflict: "This request ID is already linked to different information.",
    provisioning_failed: "Provisioning failed. Retry this same request.",
    hospital_not_ready: "Complete the readiness requirements before activating.",
    invitation_unavailable: "The invitation is unavailable or has already been accepted.",
    invitation_cooldown: "Wait at least one minute after the previous invitation was issued.",
    mail_not_configured: "Invitation email is not configured.",
    setup_unavailable: "Only enabled administrators awaiting setup can receive a new setup token.",
    forbidden: "Your platform permissions do not allow this action.",
    lifecycle_version_conflict: "The hospital changed. Review its current status and try again.",
    invalid_lifecycle_transition: "This action is unavailable in the current lifecycle state.",
    restoration_configuration_missing: "Required hospital or administrator configuration is missing.",
    not_found: "The requested record was not found.",
  };
  return (
    <p className="text-sm text-red-700" role="alert">
      {error instanceof ApiError && error.status === 401
        ? <Link className="underline" href="/platform/login">Platform session expired. Sign in again.</Link>
        : copy[code] ?? "The request could not be completed. Try again."}
    </p>
  );
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  const { data: account } = usePlatformAccount();
  return (
    <header className="mb-6 flex min-h-20 flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-shell border border-white/80 bg-white/95 px-4 py-4 shadow-sm shadow-primary-900/10 sm:px-6">
      <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">{title}</h1>
      <div className="flex min-w-0 flex-wrap items-center gap-3 lg:ml-auto">
        {children}
        {account && (
          <div className="hidden max-w-52 items-center gap-2.5 rounded-control bg-primary-50 px-3 py-2 sm:flex">
            <ShieldCheck size={18} className="shrink-0 text-primary-700" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-primary-800">
                {account.role === "PLATFORM_SUPER_ADMIN" ? "Platform Super Admin" : "Platform Operations Admin"}
              </p>
              <p className="truncate text-xs text-neutral-600" title={account.email}>{account.email}</p>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

export function PageControls({ page, hasMore, onPage }: { page: number; hasMore: boolean; onPage: (value: number) => void }) {
  return <div className="mt-4 flex items-center gap-3">
    <button className={secondaryClass} disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
    <span className="text-sm">Page {page}</span>
    <button className={secondaryClass} disabled={!hasMore || page >= 100} onClick={() => onPage(page + 1)}>Next</button>
  </div>;
}

export function label(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}

export function date(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

export function HospitalTable({ hospitals }: { hospitals: PlatformHospital[] }) {
  if (!hospitals.length) return <p className={panelClass}>No hospitals found.</p>;
  return <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
    <table className="w-full text-left text-sm">
      <thead className="bg-neutral-50"><tr>{["Hospital", "Login slug", "Edition", "Provisioning", "Lifecycle", "Login", "Invitation", "Template", "Created"].map((name) =>
        <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold" key={name}>{name}</th>)}</tr></thead>
      <tbody>{hospitals.map((hospital) => <tr key={hospital.id} className="border-t border-neutral-100">
        <th scope="row" className="px-4 py-3"><Link className="text-primary-700 underline" href={"/platform/hospitals/" + hospital.id + (hospital.onboardingId ? "" : "?legacy=1")}>{hospital.name ?? "Hospital onboarding"}</Link></th>
        <td className="px-4 py-3">{hospital.slug ?? "—"}</td><td className="px-4 py-3">{hospital.edition ?? "—"}</td>
        <td className="px-4 py-3">{label(hospital.provisioning)}</td><td className="px-4 py-3">{hospital.lifecycleStatus ? label(hospital.lifecycleStatus.toLowerCase()) : "—"}</td><td className="px-4 py-3">{hospital.active ? "Active" : "Disabled"}</td>
        <td className="px-4 py-3">{label(hospital.invitation)}</td><td className="px-4 py-3">{label(hospital.template)}</td>
        <td className="whitespace-nowrap px-4 py-3">{date(hospital.createdAt)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function AuditTable({ events }: { events: PlatformAuditEvent[] }) {
  if (!events.length) return <p className={panelClass}>No audit events yet.</p>;
  return <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
    <table className="w-full text-left text-sm">
      <thead><tr>{["Time", "Category", "Action", "Subject ID", "Actor ID", "Reason"].map((name) => <th scope="col" key={name} className="px-4 py-3">{name}</th>)}</tr></thead>
      <tbody>{events.map((item) => <tr className="border-t border-neutral-100" key={item.id}>
        {[date(item.createdAt), label(item.category), label(item.action), item.subjectId ?? "—", item.actorId ?? "—", item.reason ? label(item.reason) : "—"].map((value, index) => <td key={index} className="px-4 py-3">{value}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}
