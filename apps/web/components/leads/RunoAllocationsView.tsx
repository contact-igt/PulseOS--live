"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button, ErrorState, Skeleton } from "@pulseos/ui";

export function RunoAllocationsView() {
  const [page, setPage] = useState(1);
  const result = useQuery({ queryKey: ["runo-allocations", page], queryFn: () => api.runoAllocations(page) });
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Link href="/leads" className="text-sm text-primary-700 underline">Back to Leads</Link>
      <h1 className="text-xl font-semibold">Runo Allocations</h1>
      {result.isPending && <Skeleton className="h-32 w-full" />}
      {result.isError && (
        <div className="space-y-2">
          <ErrorState message="Could not load Runo allocations." />
          <Button onClick={() => void result.refetch()}>Retry</Button>
        </div>
      )}
      {result.data && (
        <>
          {result.data.rows.length === 0 ? (
            <p className="text-sm text-ink-2">{page === 1 ? "Import allocations in Integrations → Runo → Sync to see them here." : "No allocations on this page."}</p>
          ) : (
            <div className="overflow-x-auto rounded-card border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-100">
                  <tr>
                    {["Name", "Phone", "Status", "Assignee", "Source", "Branch", "Process", "Created on (IST)"].map((heading) => (
                      <th key={heading} scope="col" className="whitespace-nowrap px-3 py-2">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.data.rows.map((row) => (
                    <tr key={row.externalId} className="border-t border-line">
                      {[row.customerName, row.phone, row.status, row.assignee, row.source, row.branch, row.processName,
                        new Date(row.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }),
                      ].map((value, index) => <td key={index} className="px-3 py-2">{value ?? "—"}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(page > 1 || result.data.hasMore) && (
            <nav aria-label="Allocation pages" className="flex items-center gap-3 text-sm">
              <Button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span>Page {page}</span>
              <Button disabled={!result.data.hasMore} onClick={() => setPage(page + 1)}>Next</Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
