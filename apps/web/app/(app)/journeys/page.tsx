"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SOURCE_LABEL } from "@/components/my-work/labels";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@pulseos/api-client";
import {
  Badge, Card, EmptyState, ErrorState, FilterBar, FilterSelect, MetricStrip, Skeleton, Table, TableBody, TableHead, Td, Th, Toolbar, Tr,
  formatInr, formatMoneyOrDash, fmtDate, JOURNEY_STAGE_LABEL, JOURNEY_STAGE_TONE,
} from "@pulseos/ui";
import { withFrom } from "@/components/shell/BackLink";
import { OwnerScopeControl, useOwnerScope } from "@/components/journey/OwnerScopeControl";
import { useCapability } from "@/lib/useEdition";

const STAGE_LABEL = JOURNEY_STAGE_LABEL;
const STAGE_TONE = JOURNEY_STAGE_TONE;

export default function JourneysPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [stageFilter, setStageFilter] = useState(searchParams.get("stage") ?? "");
  const [sourceFilter, setSourceFilter] = useState(searchParams.get("source") ?? "");
  const campaignFilter = searchParams.get("campaignId") ?? undefined;
  const [owner, setOwner] = useOwnerScope();
  // Money columns follow the hospital capabilities: no revenue workflow, no spend tracking = no rupee figures to show.
  const showRevenue = useCapability("REVENUE_TRACKING");
  const showSpend = useCapability("SPEND_ATTRIBUTION");
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const multiDoctor = (lookups.data?.doctors.length ?? 0) > 1; // one doctor: the column would repeat the same name on every row

  const summary = useQuery({ queryKey: ["journeys-summary"], queryFn: api.journeysSummary });
  const journeys = useQuery({
    queryKey: ["journeys", stageFilter, sourceFilter, campaignFilter, owner],
    queryFn: () => api.journeys({ stage: stageFilter || undefined, source: sourceFilter || undefined, campaignId: campaignFilter, owner: owner || undefined }),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="journeys-page">
      {summary.data && (
        <MetricStrip
          testId="journeys-summary-strip"
          cells={[
            { key: "active", label: "Active", value: summary.data.activeJourneys },
            { key: "appointments_pending", label: "Appointments pending", value: summary.data.appointmentsPending },
            { key: "consultations_pending", label: "Consultations pending", value: summary.data.consultationsPending },
            { key: "treatment_decisions_pending", label: "Treatment decisions pending", value: summary.data.treatmentDecisionsPending },
            ...(showRevenue ? [{ key: "revenue_opportunity", label: "Revenue opportunity", value: formatInr(summary.data.revenueOpportunity) }] : []),
            ...(showSpend ? [{ key: "spend_at_risk", label: "Spend at risk", value: formatInr(summary.data.spendAtRisk) }] : []),
          ]}
        />
      )}

      <Toolbar>
        <div className="flex flex-wrap items-center gap-2">
          <OwnerScopeControl value={owner} onChange={setOwner} owners={lookups.data?.owners ?? []} />
          <FilterBar>
            <FilterSelect aria-label="Filter by stage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} data-testid="journeys-stage-filter">
              <option value="">All stages</option>
              {(Object.keys(STAGE_LABEL) as (keyof typeof STAGE_LABEL)[]).map((st) => (
                <option key={st} value={st}>{STAGE_LABEL[st]}</option>
              ))}
            </FilterSelect>
            <FilterSelect aria-label="Filter by source" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} data-testid="journeys-source-filter">
              <option value="">All sources</option>
              {["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"].map((src) => (
                <option key={src} value={src}>{src}</option>
              ))}
            </FilterSelect>
            {(stageFilter || sourceFilter || owner) && (
              <button type="button" onClick={() => { setStageFilter(""); setSourceFilter(""); setOwner(""); }} className="text-xs text-ink-2 hover:text-ink">
                Clear filters
              </button>
            )}
          </FilterBar>
        </div>
      </Toolbar>

      <Card className="overflow-x-auto p-0">
        {journeys.isLoading && <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
        {journeys.isError && <div className="p-4"><ErrorState message="Could not load journeys." /></div>}
        {journeys.data && journeys.data.length === 0 && <div className="p-4"><EmptyState message="No journeys match these filters." /></div>}
        {journeys.data && journeys.data.length > 0 && (
          <Table className="min-w-[960px]">
            <TableHead>
              <tr>
                <Th leading>Patient</Th>
                <Th>Journey</Th>
                <Th>Source / Campaign</Th>
                <Th>Stage</Th>
                {multiDoctor && <Th>Doctor</Th>}
                <Th>Team Member</Th>
                <Th>Last Activity</Th>
                <Th>Next Action</Th>
                {showSpend && <Th align="right">Acq. Cost</Th>}
                {showRevenue && <Th align="right">Treatment Value</Th>}
              </tr>
            </TableHead>
            <TableBody>
              {journeys.data.map((j) => (
                <Tr key={j.id} onClick={() => router.push(withFrom(`/journeys/${j.id}`, "journeys"))} data-testid={`journey-row-${j.id}`}>
                  <Td leading>
                    <Link href={withFrom(`/journeys/${j.id}`, "journeys")} onClick={(e) => e.stopPropagation()} className="block font-medium text-ink hover:text-primary-700 hover:underline">
                      {j.patientName}
                    </Link>
                  </Td>
                  <Td className="text-neutral-600">{j.journeyType}</Td>
                  <Td className="text-neutral-600">
                    <span className="block">{SOURCE_LABEL[j.source] ?? j.source}</span>
                    {j.campaignName && <span className="block text-[11px] text-neutral-400">{j.campaignName}</span>}
                  </Td>
                  <Td><Badge tone={STAGE_TONE[j.stage] ?? "neutral"}>{STAGE_LABEL[j.stage] ?? j.stage}</Badge></Td>
                  {multiDoctor && <Td className="text-neutral-600">{j.doctorName ?? "—"}</Td>}
                  <Td className={j.ownerName ? "text-neutral-600" : "text-ink-2"}>{j.ownerName ?? "Unassigned"}</Td>
                  <Td className="text-neutral-600">{fmtDate(j.lastActivityAt)}</Td>
                  <Td className="text-neutral-600">{fmtDate(j.nextActionDueAt)}</Td>
                  {showSpend && <Td align="right">{formatMoneyOrDash(j.acquisitionCost)}</Td>}
                  {showRevenue && <Td align="right">{j.treatmentValue > 0 ? formatInr(j.treatmentValue) : "—"}</Td>}
                </Tr>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
