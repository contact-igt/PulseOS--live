"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { DATE_PRESETS, resolveDatePreset } from "@pulseos/types";
import { EmptyState, ErrorState, Skeleton, fmtDateTime, localDayKey } from "@pulseos/ui";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { periodPatch, readPeriodChoice } from "@/components/filters/periodFilter";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

const WHAT: Record<string, string> = {
  "capability.changed": "Changed a feature",
  "integration.configured": "Changed integration settings",
  "integration.secret_changed": "Changed integration credentials",
  "ads.sync_triggered": "Started an ad-account sync",
  "webhook.created": "Created a webhook",
  "webhook.updated": "Changed a webhook",
  "webhook.deleted": "Deleted a webhook",
  "template.updated": "Changed a message template",
  "reminder_rule.updated": "Changed a reminder rule",
  "crm_field.created": "Added a CRM field",
  "crm_field.updated": "Changed a CRM field",
  "crm_field.archived": "Archived a CRM field",
  "crm_field.reordered": "Re-ordered CRM fields",
  "workflow_outcome.created": "Added a workflow outcome",
  "workflow_outcome.updated": "Changed a workflow outcome",
  "workflow_outcome.archived": "Archived a workflow outcome",
  "workflow_outcome.reordered": "Re-ordered workflow outcomes",
  "followup_type.created": "Added a follow-up type",
  "followup_type.updated": "Changed a follow-up type",
  "followup_type.reordered": "Re-ordered follow-up types",
  "lead_source.created": "Added a lead source",
  "lead_source.updated": "Changed a lead source",
  "lead_source.reordered": "Re-ordered lead sources",
  "report.exported": "Exported a report",
};

/** A short, safe description of what changed (names of settings only, never values). */
function detail(m: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof m.enabled === "boolean") parts.push(m.enabled ? "turned on" : "turned off");
  if (typeof m.from === "boolean" && typeof m.to === "boolean") parts.push(`${m.from ? "on" : "off"} → ${m.to ? "on" : "off"}`);
  for (const k of ["settings", "protectedFieldNames", "changedFields", "changed"] as const) {
    const v = m[k];
    if (Array.isArray(v) && v.length > 0) parts.push(`${k === "protectedFieldNames" ? "credentials" : "fields"}: ${v.join(", ")}`);
  }
  if (typeof m.mode === "string") parts.push(`mode ${m.mode.toLowerCase()}`);
  if (typeof m.status === "string") parts.push(m.status.toLowerCase());
  return parts.join(" · ");
}

/** Settings → Activity. Who changed which setting and when. Hospital Admin and Super Admin. */
export function ActivitySection() {
  const tz = useHospitalTimeZone();
  const today = localDayKey(new Date(), tz);
  const [action, setAction] = useState("");
  const params = useSearchParams();
  const url = useUrlFilters();
  const period = useMemo(() => readPeriodChoice(new URLSearchParams(params.toString()), { prefix: "ac", presets: DATE_PRESETS }), [params]);
  const span = period.range === "custom" ? { from: period.from, to: period.to } : period.range ? resolveDatePreset(period.range as never, today) : {};
  const q = useQuery({ queryKey: ["activity-log", action, span.from, span.to], queryFn: () => api.activityLog({ ...(action ? { action } : {}), ...(span.from && span.to ? { from: span.from, to: span.to } : {}) }) });
  return (
    <div className="space-y-3" data-testid="activity-section">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-ink-2">
          What
          <select value={action} onChange={(e) => setAction(e.target.value)} className="h-11 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink sm:h-8 sm:text-xs" data-testid="activity-action">
            <option value="">Any change</option>
            {Object.entries(WHAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <PeriodControls presets={DATE_PRESETS} value={period} today={today} onChange={(next) => url.set(periodPatch(next, { prefix: "ac", defaultRange: "" }))} noneLabel="Any date" testIdPrefix="activity" maxSpanDays={366} />
      </div>
      {q.isLoading && <Skeleton className="h-24" />}
      {q.isError && <ErrorState message="Could not load the activity log." />}
      {q.data && q.data.length === 0 && <EmptyState message="No changes recorded for these filters." />}
      {q.data && q.data.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface text-xs">
          {q.data.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2" data-testid="activity-row">
              <span className="font-medium text-ink">{WHAT[e.action] ?? e.action}</span>
              {e.entityKey && <span className="text-ink-2">{e.entityKey}</span>}
              <span className="text-ink-2">{detail(e.metadata)}</span>
              <span className="ml-auto text-ink-3">{e.actorName ?? "System"} · {fmtDateTime(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
