"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { ErrorState, Skeleton, fmtDate, fmtDateTime, formatInr, relativeTime } from "@pulseos/ui";
import type { JourneyDetailVm } from "@pulseos/types";
import { leadInsightRows } from "./insightRows";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}

/**
 * How this lead is doing, read-only, from the journey's own record: where it came from, how fast it was reached, what
 * happens next and what has happened. Nothing here is edited; each part has its own action elsewhere.
 */
export function LeadInsights({ journeyId }: { journeyId: string }) {
  const detail = useQuery({ queryKey: ["journey", journeyId], queryFn: () => api.journeyDetail(journeyId), staleTime: 15_000 });

  if (detail.isLoading) return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>;
  if (detail.isError || !detail.data) return <ErrorState message="Could not load the insights for this lead." />;
  const d: JourneyDetailVm = detail.data;
  const rows = leadInsightRows(d, new Date());
  const recent = d.timeline.slice(0, 6);
  const openTasks = d.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");

  return (
    <div className="space-y-6" data-testid="lead-insights">
      <section aria-labelledby="insight-summary">
        <h3 id="insight-summary" className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
          Summary
        </h3>
        <dl className="divide-y divide-line">
          <Row label="Stage">{rows.stageLabel}</Row>
          <Row label="Lead age">{rows.ageLabel}</Row>
          <Row label="Last interaction">{relativeTime(d.journey.lastInteractionAt)}</Row>
          <Row label="Last outcome">{d.journey.lastOutcome ? `${d.journey.lastOutcome.label} · ${relativeTime(d.journey.lastOutcome.at)}` : "—"}</Row>
        </dl>
      </section>

      <section aria-labelledby="insight-origin">
        <h3 id="insight-origin" className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
          Where it came from
        </h3>
        <dl className="divide-y divide-line">
          <Row label="Original source">{d.journey.sourceLabel ?? d.journey.source}</Row>
          <Row label="Campaign">{d.journey.campaign?.name ?? "None"}</Row>
          <Row label="Team member">{d.journey.owner?.name ?? "Unassigned"}</Row>
        </dl>
      </section>

      <section aria-labelledby="insight-next">
        <h3 id="insight-next" className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
          What happens next
        </h3>
        <dl className="divide-y divide-line">
          <Row label="Next action">{d.journey.nextAction ? `${d.journey.nextAction.label} · ${fmtDateTime(d.journey.nextAction.dueAt)}` : "—"}</Row>
          <Row label="Open follow-ups">{openTasks.length}</Row>
          <Row label="Appointments">{rows.appointmentLabel}</Row>
          <Row label="Calls">{d.journey.callStats.total === 0 ? "None yet" : `${d.journey.callStats.total} (${d.journey.callStats.connected} connected)`}</Row>
          {d.treatments && <Row label="Treatments">{d.treatments.length === 0 ? "None" : d.treatments.map((t) => t.treatmentLabel).join(", ")}</Row>}
          {d.revenue && <Row label="Revenue">{formatInr(d.revenue.total)}</Row>}
        </dl>
      </section>

      <section aria-labelledby="insight-recent">
        <h3 id="insight-recent" className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
          Recent activity
        </h3>
        {recent.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((e) => (
              <li key={e.id} className="py-1.5 text-sm">
                <span className="text-ink">{e.title}</span>
                <span className="block text-[11px] text-ink-2">{fmtDate(e.occurredAt)} · {relativeTime(e.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
