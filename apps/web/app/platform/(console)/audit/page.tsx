"use client";

import { useState } from "react";
import { platformApi } from "@pulseos/api-client";
import { AuditTable, Failure, Loading, PageControls, PageTitle, usePlatformQuery } from "../platform-ui";

export default function PlatformAudit() {
  const [page, setPage] = useState(1);
  const query = usePlatformQuery(["audit", String(page)], () => platformApi.audit(page));
  return <>
    <PageTitle title="Platform audit log" />
    {query.isPending && <Loading />}
    {query.isError && <Failure error={query.error} />}
    {query.data && <>
      <AuditTable events={query.data.items} />
      <PageControls page={page} hasMore={query.data.hasMore} onPage={setPage} />
    </>}
  </>;
}
