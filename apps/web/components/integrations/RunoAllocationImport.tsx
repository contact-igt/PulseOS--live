"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button } from "@pulseos/ui";

const messages: Record<string, string> = {
  runo_key_unavailable: "Save a Runo API key in Credentials first.",
  runo_key_rejected: "Runo rejected the API key. Check the key in Credentials.",
  runo_date_or_process_invalid: "Enter a past date and the exact Runo process name.",
  runo_process_mismatch: "Runo returned a different process. Check the process name in Runo.",
  runo_unexpected_response: "Runo returned an incomplete or unexpected allocation list. Try the import again.",
};

export function RunoAllocationImport() {
  const [date, setDate] = useState("");
  const [processName, setProcessName] = useState("");
  const queryClient = useQueryClient();
  const importAllocations = useMutation({
    mutationFn: api.importRunoAllocations,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runo-allocations"] }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    importAllocations.mutate({ date, processName: processName.trim() });
  }
  return (
    <form className="space-y-3 rounded-card border border-line p-3" onSubmit={submit}>
      <h3 className="text-sm font-semibold">Runo allocations</h3>
      <p className="text-sm text-ink-2">Import all allocations available for a past date and one Runo process.</p>
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-sm">
          Allocation date
          <input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-control border border-line px-2 py-1.5" />
        </label>
        <label className="grid gap-1 text-sm">
          Runo process
          <input required maxLength={300} placeholder="Default process" value={processName} onChange={(event) => setProcessName(event.target.value)} className="rounded-control border border-line px-2 py-1.5" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={importAllocations.isPending || !processName.trim() || !date}>
          {importAllocations.isPending ? "Importing…" : "Import Allocations"}
        </Button>
        <Link href="/leads?sourceView=runo" className="text-sm text-primary-700 underline">View Runo allocations</Link>
      </div>
      {importAllocations.data && <p role="status" className="text-sm">{importAllocations.data.imported} allocations imported or updated.</p>}
      {importAllocations.error && <p role="alert" className="text-sm text-red-700">{messages[importAllocations.error.message] ?? "Could not import allocations. Try again."}</p>}
    </form>
  );
}
