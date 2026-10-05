"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import {
  Badge, Card, ConnectorModeBadge, EmptyState, ErrorState, MetricStrip, Panel, Skeleton, Table, TableBody, TableHead, Td, Th, Tr,
  formatInr, formatMoneyOrDash, formatRoas, fmtDateWithYear as fmtDate, JOURNEY_STAGE_LABEL, JOURNEY_STAGE_TONE,
} from "@pulseos/ui";
import { BackLink, withFrom } from "@/components/shell/BackLink";
import { runLabel, runStatusLabel } from "@/components/campaigns/runs";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

export default function CampaignDetailPage() {
  const timeZone = useHospitalTimeZone();
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const performance = useQuery({
    queryKey: ["campaign-performance", campaignId],
    // Same row shape as the Campaigns list (incl. the run window for the header).
    queryFn: () => api.campaignViewRows({ campaignId }),
  });
  const campaign = performance.data?.[0];

  const journeyList = useQuery({
    queryKey: ["journeys", { campaignId }],
    queryFn: () => api.journeys({ campaignId }),
    enabled: performance.isSuccess && !!campaign,
  });

  if (performance.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-5">
        <Skeleton className="h-20" />
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (performance.isError) {
    return <ErrorState message="Could not load this campaign." />;
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-6xl space-y-5">
        <BackLink fallback="/campaigns" fallbackLabel="Back to Campaigns" />
        <ErrorState message="This campaign could not be found." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="campaign-detail-page">
      <BackLink fallback="/campaigns" fallbackLabel="Back to Campaigns" />

      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">{campaign.campaignName}</h1>
              <ConnectorModeBadge mode={campaign.connectorMode} />
            </div>
            <p className="mt-1 text-sm text-ink-2">
              {campaign.source}
              {campaign.specialtyLabel ? ` · ${campaign.specialtyLabel}` : ""}
            </p>
            <p className="mt-0.5 text-xs text-ink-2" data-testid="campaign-run-window">
              Runs {runLabel(campaign, timeZone)}
              {campaign.endDate && <> · {runStatusLabel(campaign)}</>}
            </p>
          </div>
          {journeyList.data && journeyList.data.length > 0 && (
            <span className="text-xs text-ink-2">
              First attributed {fmtDate([...journeyList.data].sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt))[0].lastActivityAt)}
            </span>
          )}
        </div>
      </Card>

      <div className="space-y-2">
        {/* Primary: same 6-cell shape as the root Campaigns page's efficiency
            strip, so the two screens read as one product. A 10-cell strip
            here previously left an orphaned cell on its own row at every
            breakpoint (10 doesn't divide evenly by 3 or 6). */}
        <MetricStrip
          testId="campaign-detail-metrics"
          cells={[
            { key: "spend", label: "Spend", value: formatInr(campaign.spend) },
            { key: "leads", label: "Leads", value: campaign.leads },
            { key: "appointments", label: "Appointments", value: campaign.appointments },
            { key: "treatmentCompleted", label: "Treatments", value: campaign.treatmentCompleted },
            { key: "revenue", label: "Revenue", value: formatInr(campaign.revenue) },
            { key: "roas", label: "ROAS", value: formatRoas(campaign.roas) },
          ]}
        />
        {/* Secondary: derived cost/volume detail — Tx Advised stays visible
            via each journey row's stage badge below, not duplicated here. */}
        <Card tone="info" className="grid grid-cols-2 gap-2 px-4 py-2.5 sm:grid-cols-4" data-testid="campaign-detail-metrics-secondary">
          {[
            { key: "consultations", label: "Consultations", value: campaign.consultations },
            { key: "cpl", label: "Cost / Lead", value: formatMoneyOrDash(campaign.cpl) },
            { key: "cpa", label: "Cost / Appointment", value: formatMoneyOrDash(campaign.costPerAppointment) },
            { key: "cpt", label: "Cost / Treatment", value: formatMoneyOrDash(campaign.costPerTreatment) },
          ].map((cell) => (
            <div key={cell.key} data-testid={`metric-${cell.key}`}>
              <span className="block text-sm font-semibold tabular-nums text-ink">{cell.value}</span>
              <span className="block text-[11px] text-ink-2">{cell.label}</span>
            </div>
          ))}
        </Card>
      </div>

      <Panel title="Attribution / Journeys" subtitle={journeyList.data ? `${journeyList.data.length} journeys` : undefined} padded={false}>
        {journeyList.isLoading && <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>}
        {journeyList.isError && <ErrorState message="Could not load attributed journeys." />}
        {journeyList.data && journeyList.data.length === 0 && <EmptyState message="No journeys attributed to this campaign yet." />}
        {journeyList.data && journeyList.data.length > 0 && (
          <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHead>
              <tr>
                <Th leading>Patient</Th>
                <Th>Journey type</Th>
                <Th>Stage</Th>
                <Th>Doctor</Th>
                <Th>Last activity</Th>
                <Th align="right">Treatment value</Th>
              </tr>
            </TableHead>
            <TableBody>
              {journeyList.data.map((row) => (
                <Tr key={row.id} data-testid={`campaign-journey-row-${row.id}`}>
                  <Td leading>
                    <Link href={withFrom(`/patients/${row.patientId}`, "campaigns")} className="font-medium text-primary-700 hover:underline">
                      {row.patientName}
                    </Link>
                  </Td>
                  <Td>
                    <Link href={withFrom(`/journeys/${row.id}`, "campaigns")} className="text-ink hover:text-primary-700 hover:underline" data-testid={`campaign-journey-link-${row.id}`}>
                      {row.journeyType}
                    </Link>
                  </Td>
                  <Td><Badge tone={JOURNEY_STAGE_TONE[row.stage] ?? "neutral"}>{JOURNEY_STAGE_LABEL[row.stage] ?? row.stage}</Badge></Td>
                  <Td className="text-ink-2">{row.doctorName ?? "—"}</Td>
                  <Td className="text-ink-2">{fmtDate(row.lastActivityAt)}</Td>
                  <Td align="right">{formatInr(row.treatmentValue)}</Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}
