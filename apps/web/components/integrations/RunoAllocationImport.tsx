"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button } from "@pulseos/ui";

const messages: Record<string, string> = {
  runo_key_unavailable: "Save a Runo API key in Credentials first.",
  runo_key_rejected: "Runo rejected the API key. Check the key in Credentials.",
  runo_date_or_process_invalid: "Use past dates and the exact Runo process name.",
  runo_process_mismatch: "Runo returned a different process. Check the process name in Runo.",
  runo_unexpected_response: "Runo returned an incomplete or unexpected allocation list. Try the import again.",
};

export function RunoAllocationImport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [processName, setProcessName] = useState("");
  const [progress, setProgress] = useState<{ date: string; completedDays: number; imported: number } | null>(null);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kolkata", dateStyle: "short" }).format(new Date());
  const validRange = Boolean(from && to && from <= to && to < today);
  const queryClient = useQueryClient();
  const importAllocations = useMutation({
    mutationFn: async (input: { from: string; to: string; processName: string }) => {
      let imported = 0;
      let completedDays = 0;
      const day = new Date(`${input.from}T00:00:00Z`);
      const end = new Date(`${input.to}T00:00:00Z`);
      while (day <= end) {
        const date = day.toISOString().slice(0, 10);
        setProgress({ date, completedDays, imported });
        const result = await api.importRunoAllocations({ date, processName: input.processName });
        imported += result.imported;
        completedDays += 1;
        day.setUTCDate(day.getUTCDate() + 1);
      }
      return { imported, completedDays };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["runo-allocations"] }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validRange || !processName.trim() || importAllocations.isPending) return;
    setProgress(null);
    importAllocations.mutate({ from, to, processName: processName.trim() });
  }
  return (
    <form className="space-y-3 rounded-card border border-line p-3" onSubmit={submit}>
      <h3 className="text-sm font-semibold">Runo allocations</h3>
      <p className="text-sm text-ink-2">Choose the earliest allocation date and an end date before today. Keep this tab open while PulseOS imports every day in the range.</p>
      <fieldset disabled={importAllocations.isPending} className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-sm">
          From
          <input required type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} className="rounded-control border border-line px-2 py-1.5" />
        </label>
        <label className="grid gap-1 text-sm">
          Through
          <input required type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} className="rounded-control border border-line px-2 py-1.5" />
        </label>
        <label className="grid gap-1 text-sm">
          Runo process
          <input required maxLength={300} placeholder="Default process" value={processName} onChange={(event) => setProcessName(event.target.value)} className="rounded-control border border-line px-2 py-1.5" />
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={importAllocations.isPending || !processName.trim() || !validRange}>
          {importAllocations.isPending ? "Importing…" : "Import Allocations"}
        </Button>
        {!importAllocations.isPending && <Link href="/leads?sourceView=runo" className="text-sm text-primary-700 underline">View Runo allocations</Link>}
      </div>
      {from && to && !validRange && <p className="text-sm text-red-700">Choose an end date on or after the start date and before today.</p>}
      {importAllocations.isPending && progress && <p role="status" className="text-sm">Importing {progress.date}. {progress.completedDays} days complete, {progress.imported} allocations imported or updated.</p>}
      {importAllocations.data && <p role="status" className="text-sm">{importAllocations.data.imported} allocations imported or updated across {importAllocations.data.completedDays} days.</p>}
      {importAllocations.error && (
        <p role="alert" className="text-sm text-red-700">
          {progress && `Import stopped on ${progress.date}. `}
          {messages[importAllocations.error.message] ?? "Could not import allocations. Try again."}
          {progress && progress.completedDays > 0 && " Earlier dates are saved. Set From to the date shown above to resume."}
        </p>
      )}
    </form>
  );
}
