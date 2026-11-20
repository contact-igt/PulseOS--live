"use client";

import { platformApi } from "@pulseos/api-client";
import Link from "next/link";
import { Activity, ArrowUpRight, Building2, ClipboardList } from "lucide-react";
import { AuditTable, Failure, HospitalTable, Loading, PageTitle, usePlatformAccount, usePlatformQuery } from "./platform-ui";

export default function Dashboard() {
  const account = usePlatformAccount();
  const query = usePlatformQuery(["dashboard"], platformApi.dashboard);
  const data = query.data;
  return <>
    <PageTitle title="Platform dashboard" />
    {query.isPending && <Loading />}
    {query.isError && <Failure error={query.error} />}
    {data && <>
      <div className="space-y-4">
        {[
          { title: "Hospital lifecycle", icon: Building2, metrics: [
            { label: "Total hospitals", value: data.total }, { label: "Lifecycle active", value: data.active },
            { label: "Suspended hospitals", value: data.suspended }, { label: "Login disabled", value: data.loginDisabled },
          ] },
          { title: "Onboarding", icon: ClipboardList, metrics: [
            { label: "Pending onboarding", value: data.pending }, { label: "Provisioning hospitals", value: data.provisioning },
            { label: "Pending administrator invitations", value: data.pendingInvitations },
            { label: "Failed onboarding records", value: data.failedOnboarding }, { label: "Template failures", value: data.templateFailures },
          ] },
          { title: "Messaging and integrations", icon: Activity, metrics: [
            { label: "Pending messaging commands", value: data.pendingCommands }, { label: "Failed messaging commands", value: data.failedCommands },
            { label: "Commands pending at least 15 min", value: data.agedCommands }, { label: "Hospitals with degraded or failed live connectors", value: data.integrationProblems },
          ] },
        ].map(({ title, icon: Icon, metrics }) => <section key={title} className="overflow-hidden rounded-xl border border-primary-100 bg-white shadow-sm shadow-primary-900/5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-primary-100 px-4 py-3 sm:px-5">
            <h2 className="flex items-center gap-2.5 text-base font-semibold">
              <span className="grid size-8 place-items-center rounded-control bg-primary-50 text-primary-700"><Icon size={17} aria-hidden="true" /></span>
              {title}
            </h2>
            {Icon === Activity && account.data?.permissions.includes("hospital:lifecycle:read") && <Link href="/platform/operations"
              className="inline-flex items-center gap-1 rounded-control px-2 py-1.5 text-sm font-semibold text-primary-700 hover:bg-primary-50">
              Review messaging exceptions <ArrowUpRight size={15} aria-hidden="true" />
            </Link>}
          </div>
          <dl className="grid grid-cols-2 gap-px bg-primary-100 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
            {metrics.map(({ label, value }) => <div key={label} className="flex min-w-0 flex-col-reverse justify-end gap-1.5 bg-white px-4 py-3.5 sm:px-5">
              <dt className="text-sm leading-snug text-neutral-600">{label}</dt>
              <dd className="text-2xl font-semibold tabular-nums text-neutral-900">{value ?? "—"}</dd>
            </div>)}
          </dl>
        </section>)}
      </div>
      <h2 className="mb-3 mt-8 text-lg font-semibold">Recent hospital creations</h2>
      <HospitalTable hospitals={data.recentHospitals} />
      {account.data?.permissions.includes("audit:read") && <>
        <h2 className="mb-3 mt-8 text-lg font-semibold">Recent platform activity</h2>
        <AuditTable events={data.recentAudit} />
      </>}
    </>}
  </>;
}
