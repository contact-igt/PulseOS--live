"use client";

import Link from "next/link";
import { useState } from "react";
import { platformApi } from "@pulseos/api-client";
import { date, Failure, inputClass, label, Loading, PageControls, PageTitle, panelClass, secondaryClass, usePlatformAccount, usePlatformQuery } from "../platform-ui";

export default function Operations() {
  const account = usePlatformAccount();
  const allowed = account.data?.permissions.includes("hospital:lifecycle:read");
  const [status, setStatus] = useState<"" | "pending" | "failed">("");
  const [tenantId, setTenantId] = useState("");
  const [hospitalInput, setHospitalInput] = useState("");
  const [page, setPage] = useState(1);
  return <>
    <PageTitle title="Operations" />
    {allowed && <>
      <form className={panelClass + " grid items-end gap-3 sm:grid-cols-[1fr_2fr_auto]"} onSubmit={(event) => {
        event.preventDefault();
        setTenantId(hospitalInput.trim());
        setPage(1);
      }}>
        <label className="text-sm">Command status
          <select className={inputClass} value={status} onChange={(event) => {
            const value = event.target.value;
            setStatus(value === "pending" || value === "failed" ? value : "");
            setPage(1);
          }}>
            <option value="">Pending and failed</option><option value="pending">Pending</option><option value="failed">Failed</option>
          </select>
        </label>
        <label className="text-sm">Hospital tenant ID
          <input className={inputClass} value={hospitalInput} onChange={(event) => setHospitalInput(event.target.value)} maxLength={36}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" />
        </label>
        <button className={secondaryClass}>Filter by hospital</button>
      </form>
      <Exceptions status={status} tenantId={tenantId} page={page} setPage={setPage} />
    </>}
  </>;
}

function Exceptions({ status, tenantId, page, setPage }: {
  status: "" | "pending" | "failed"; tenantId: string; page: number; setPage: (page: number) => void;
}) {
  const query = usePlatformQuery(["messaging-exceptions", status, tenantId, String(page)],
    () => platformApi.messagingExceptions({ page, ...(status ? { status } : {}), ...(tenantId ? { tenantId } : {}) }));
  return <section className={panelClass + " mt-4 space-y-4"}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">WhatsNexus messaging exceptions</h2>
      <button className={secondaryClass} disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh list</button>
    </div>
    {query.isPending && <Loading />}
    {query.isError && <Failure error={query.error} />}
    {query.data?.items.length === 0 && <p>No matching commands.</p>}
    <ul className="divide-y divide-neutral-200">
      {query.data?.items.map((row) => <li key={row.id} className="grid gap-2 py-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <Link className="font-medium text-primary-700 underline" href={"/platform/hospitals/" + (row.onboardingId ?? row.tenantId) + (row.onboardingId ? "" : "?legacy=1")}>{row.hospitalName}</Link>
          <p className="break-all text-neutral-600">{row.id}</p>
        </div>
        <div><p>{label(row.action)} · {label(row.status)}</p><p>{row.classification ? label(row.classification) : "Awaiting processing"}</p></div>
        <div>
          {row.pendingMinutes !== null && <p>Pending {row.pendingMinutes} min</p>}
          <p>Last observation {row.verifiedAt ? date(row.verifiedAt) : "Unavailable"}</p>
          <p>Attempts {row.attempts}</p>
        </div>
      </li>)}
    </ul>
    {query.data && <PageControls page={page} hasMore={query.data.hasMore} onPage={setPage} />}
  </section>;
}
