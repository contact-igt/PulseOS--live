"use client";

import { platformApi } from "@pulseos/api-client";
import Link from "next/link";
import { AuditTable, Failure, HospitalTable, Loading, PageTitle, panelClass, usePlatformAccount, usePlatformQuery } from "./platform-ui";

export default function Dashboard() {
  const account = usePlatformAccount();
  const query = usePlatformQuery(["dashboard"], platformApi.dashboard);
  const data = query.data;
  return <>
    <PageTitle title="Platform dashboard" />
    {query.isPending && <Loading />}
    {query.isError && <Failure error={query.error} />}
    {data && <>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[
          { label: "Total hospitals", value: data.total }, { label: "Lifecycle active", value: data.active },
          { label: "Pending onboarding", value: data.pending }, { label: "Login disabled", value: data.loginDisabled }, { label: "Suspended hospitals", value: data.suspended },
          { label: "Template failures", value: data.templateFailures }, { label: "Pending administrator invitations", value: data.pendingInvitations },
          { label: "Provisioning hospitals", value: data.provisioning }, { label: "Failed onboarding records", value: data.failedOnboarding },
          { label: "Pending messaging commands", value: data.pendingCommands }, { label: "Failed messaging commands", value: data.failedCommands },
          { label: "Commands pending at least 15 min", value: data.agedCommands }, { label: "Hospitals with degraded or failed live connectors", value: data.integrationProblems },
        ].map((metric) => <div key={metric.label} className={panelClass}><dt className="text-sm text-neutral-600">{metric.label}</dt><dd className="text-3xl font-semibold">{metric.value}</dd></div>)}
      </dl>
      {account.data?.permissions.includes("hospital:lifecycle:read") && <Link href="/platform/operations" className="mt-4 inline-block text-primary-700 underline">Review messaging exceptions</Link>}
      <h2 className="mb-3 mt-8 text-lg font-semibold">Recent hospital creations</h2>
      <HospitalTable hospitals={data.recentHospitals} />
      {account.data?.permissions.includes("audit:read") && <>
        <h2 className="mb-3 mt-8 text-lg font-semibold">Recent platform activity</h2>
        <AuditTable events={data.recentAudit} />
      </>}
    </>}
  </>;
}
