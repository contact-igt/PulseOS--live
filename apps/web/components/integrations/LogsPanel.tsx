"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Badge, EmptyState, ErrorState, Skeleton, localDayKey, relativeTime } from "@pulseos/ui";
import { DATE_PRESETS, resolveDatePreset } from "@pulseos/types";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { periodPatch, readPeriodChoice } from "@/components/filters/periodFilter";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

const PROVIDERS = [
  { key: "", label: "All providers" },
  { key: "whatsapp_meta_cloud", label: "WhatsApp" },
  { key: "whatsnexus", label: "WhatsNexus" },
  { key: "runo", label: "Runo" },
  { key: "ccs_ivr", label: "CCS IVR" },
  { key: "google_ads", label: "Google Ads" },
  { key: "meta_ads", label: "Meta Ads" },
  { key: "webhooks", label: "Webhooks" },
];
const STATUSES = ["", "received", "processed", "sent", "pending", "failed", "duplicate"];
const input = "h-11 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-8 sm:text-xs";

/** Redacted activity from every integration. Provider, status and date filters; credentials never appear. */
export function LogsPanel({ provider: fixedProvider }: { provider?: string }) {
  const [provider, setProvider] = useState(fixedProvider ?? "");
  const [status, setStatus] = useState("");
  const tz = useHospitalTimeZone();
  const today = localDayKey(new Date(), tz);
  // The period lives in the URL (refresh, back/forward and shared links restore it); "Any date" is the default.
  const params = useSearchParams();
  const url = useUrlFilters();
  const period = useMemo(() => readPeriodChoice(new URLSearchParams(params.toString()), { prefix: "lg", presets: DATE_PRESETS }), [params]);
  // The shared presets resolve to hospital-local days; the API takes the resolved day span.
  const span = period.range === "custom" ? { from: period.from, to: period.to } : period.range ? resolveDatePreset(period.range as never, today) : {};
  const q = useQuery({ queryKey: ["integration-logs", provider, status, span.from, span.to], queryFn: () => api.integrationLogs({ provider, status, ...(span.from && span.to ? { from: span.from, to: span.to } : {}) }) });

  return (
    <div className="space-y-3" data-testid="integration-logs">
      <div className="flex flex-wrap items-end gap-2">
        {!fixedProvider && (
          <label className="flex flex-col gap-1 text-[11px] text-ink-2">
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className={input} data-testid="logs-provider">
              {PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[11px] text-ink-2">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={input} data-testid="logs-status">
            {STATUSES.map((s) => <option key={s} value={s}>{s || "Any status"}</option>)}
          </select>
        </label>
        <PeriodControls presets={DATE_PRESETS} value={period} today={today} onChange={(next) => url.set(periodPatch(next, { prefix: "lg", defaultRange: "" }))} noneLabel="Any date" testIdPrefix="logs" maxSpanDays={366} />
      </div>
      {q.isLoading && <Skeleton className="h-24" />}
      {q.isError && <ErrorState message="Could not load activity." />}
      {q.data && q.data.length === 0 && <EmptyState message="No activity for these filters." />}
      {q.data && q.data.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface text-xs">
          {q.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="log-row">
              <Badge tone={r.status === "failed" ? "danger" : r.status === "processed" || r.status === "sent" ? "success" : "neutral"}>{r.status}</Badge>
              <span className="font-medium text-ink">{r.provider.replace(/_/g, " ")}</span>
              <span className="text-ink-2">{r.direction} · {r.summary}</span>
              {r.error && <span className="basis-full text-danger-700">{r.error}</span>}
              <span className="ml-auto text-ink-3">{relativeTime(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
