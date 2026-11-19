"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { platformApi } from "@pulseos/api-client";
import { buttonClass, Failure, HospitalTable, inputClass, Loading, PageControls, PageTitle, secondaryClass, usePlatformAccount, usePlatformQuery } from "../platform-ui";

export default function HospitalDirectory() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const account = usePlatformAccount();
  const query = usePlatformQuery(["hospitals", String(page), search], () => platformApi.hospitals(page, search));

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(String(new FormData(event.currentTarget).get("search") ?? "").trim());
    setPage(1);
  }

  return <>
    <PageTitle title="Hospitals">
      {account.data?.permissions.includes("hospital:create") && <Link className={buttonClass} href="/platform/hospitals/new">Create hospital</Link>}
    </PageTitle>
    <form onSubmit={applySearch} role="search" className="mb-4 flex max-w-lg items-end gap-2">
      <label className="flex-1 text-sm font-medium">Hospital name or login slug<input name="search" type="search" maxLength={120} className={inputClass} /></label>
      <button className={secondaryClass}>Search</button>
    </form>
    {query.isPending && <Loading />}
    {query.isError && <Failure error={query.error} />}
    {query.data && <HospitalTable hospitals={query.data.items} />}
    <PageControls page={page} hasMore={query.data?.hasMore ?? false} onPage={setPage} />
  </>;
}
