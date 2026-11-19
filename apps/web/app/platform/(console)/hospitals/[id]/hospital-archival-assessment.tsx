"use client";

import { useQuery } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import type { HospitalArchivalAssessment } from "@pulseos/types";
import { date, Failure, label, Loading, panelClass } from "../../platform-ui";

const evidenceLabels: Record<keyof HospitalArchivalAssessment["evidence"], string> = {
  appointments: "Unresolved appointments", futureAppointments: "Upcoming unresolved appointments",
  pendingTasks: "Pending tasks", pendingNotifications: "Pending or processing notifications",
  unknownDispatches: "Unresolved notification submissions", pendingWebhooks: "Pending webhook deliveries",
  pendingCommands: "Pending messaging commands", recordedFailedCommands: "Recorded failed messaging commands",
  openConnectorEvents: "Received or failed integration events", heldMetaLeads: "Held Meta lead records",
  runningAdsSyncs: "Ad syncs recorded as running", pendingOrRunningCallWork: "Pending or running call processing",
};

export default function HospitalArchivalAssessmentPanel({ id, legacy }: { id: string; legacy: boolean }) {
  const query = useQuery({ queryKey: ["platform", "archival-assessment", id, legacy],
    queryFn: () => platformApi.archivalAssessment(id, legacy), retry: false });
  const data = query.data;
  const observed = data?.whatsNexus.observation;
  return <section className={panelClass + " mt-5 space-y-4"} aria-labelledby="archival-preparation">
    <h2 id="archival-preparation" className="text-lg font-semibold">Archival preparation</h2>
    {query.isPending && <Loading />}
    {query.isError && <Failure error={query.error} />}
    {data && <>
      <p className="text-sm">{label(data.lifecycle.state)} · Lifecycle version {data.lifecycle.version} · Assessed {date(data.assessedAt)}</p>
      <p className="text-sm">Invitation {label(data.onboarding.invitation)}{data.onboarding.delivery && (" · Email " + label(data.onboarding.delivery))}
        {data.onboarding.template && (" · Template " + label(data.onboarding.template))}</p>
      <p className="text-sm">{data.recordedRevenue ? "Local revenue evidence recorded. Finance review required." : "No local revenue evidence found. Outstanding obligations require independent review."}</p>
      <p className="text-sm">{observed
        ? `WhatsNexus recorded ${label(observed.state)} on ${date(observed.observedAt)}. ${observed.alignment === "historical"
          ? "Historical observation. Current pairing or lifecycle alignment could not be established."
          : `Matches the recorded pairing and lifecycle. ${observed.unresolvedPermits} unresolved permits at observation time.`}`
        : data.whatsNexus.binding ? "No verified WhatsNexus observation is available." : "No local WhatsNexus binding is recorded."}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(evidenceLabels) as (keyof typeof evidenceLabels)[]).map((key) =>
          <div key={key}><dt>{evidenceLabels[key]}</dt><dd className="font-medium">{data.evidence[key]}</dd></div>)}
      </dl>
      <h3 className="font-semibold">Blockers, missing evidence and approvals</h3>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        {data.findings.map((finding) => <li key={finding.reason}>
          <strong>{label(finding.classification)}</strong> · {finding.basis === "policy" ? "Proposed policy" : "Recorded evidence"} · {finding.reason}
        </li>)}
      </ul>
    </>}
  </section>;
}
