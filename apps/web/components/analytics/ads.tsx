"use client";

import Link from "next/link";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdsAnalytics, AdsCampaignRow } from "@pulseos/types";
import { ADS_PROVIDER_LABEL } from "@pulseos/types";
import { Badge, CHART_INK, ChartEmptyState, ChartTooltipCard, Table, TableBody, TableHead, TableShell, Td, Th, Tr, fmtCountNum, fmtDayShort, fmtInrAxis, fmtPct, fmtRoasX, formatInr, niceMoneyAxis, relativeTime } from "@pulseos/ui";

const dash = "—";
const inr = (n: number | null) => (n === null ? dash : formatInr(n));

const UNAVAILABLE: Record<NonNullable<AdsAnalytics["unavailable"]>, { title: string; body: string; cta?: { href: string; label: string } }> = {
  NO_PROVIDER_ENABLED: { title: "Ad accounts are not switched on", body: "Turn on Google Ads or Meta Ads to see spend and campaign results next to what PulseOS recorded.", cta: { href: "/settings?section=features", label: "Open Settings → Features" } },
  NO_DATA_YET: { title: "No ad data for this period yet", body: "Connect the ad account and run a sync, or widen the date range. Numbers appear only once the provider has reported them.", cta: { href: "/integrations?section=ads", label: "Open the Integration Hub" } },
  NO_PROVIDER_FOR_SOURCE: { title: "No ad account for this source", body: "The source filter excludes every switched-on ad account. Choose Google, Meta or all sources." },
  NOT_SLICEABLE: { title: "Ad accounts cannot be split by branch, service or campaign", body: "Ad spend is reported per account and campaign ids differ from PulseOS campaigns, so it is hidden while one of these filters is on. Clear it to see ad data." },
  MIXED_CURRENCY: { title: "These accounts report in different currencies", body: "Totals and costs are not shown because they would add unlike amounts. Filter to one source." },
};

const SETUP_LABEL = { NOT_ENABLED: "Not switched on", NOT_CONFIGURED: "Not configured", NEVER_SYNCED: "Not synced yet", READY: "Connected" } as const;

function ProviderStrip({ data }: { data: AdsAnalytics }) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Ad accounts" data-testid="ads-providers">
      {data.providers.map((p) => (
        <li key={p.provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-surface px-3 py-2 text-xs" data-testid={`ads-provider-${p.provider}`}>
          <span className="text-sm font-medium text-ink">{p.name}</span>
          <Badge tone={p.setup === "READY" ? "success" : "neutral"}>{SETUP_LABEL[p.setup]}</Badge>
          {p.setup !== "NOT_ENABLED" && <Badge tone={p.mode === "FIXTURE" ? "neutral" : p.mode === "SANDBOX" ? "warning" : "primary"}>{p.mode === "FIXTURE" ? "Sample data" : p.mode === "SANDBOX" ? "Sandbox" : "Live"}</Badge>}
          <span className="text-ink-2" data-testid={`ads-last-synced-${p.provider}`}>{p.lastSyncedAt ? `Last synced ${relativeTime(p.lastSyncedAt)}` : "Never synced"}</span>
          {p.lastSyncStatus === "FAILED" && <span className="basis-full text-danger-700">Last sync failed{p.lastSyncError ? `: ${p.lastSyncError}` : ""}. The numbers below are from the previous successful sync.</span>}
        </li>
      ))}
    </ul>
  );
}

function Kpi({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-card border border-line bg-surface px-3 py-2.5" data-testid={testId}>
      <p className="truncate text-[11px] uppercase tracking-wide text-ink-2">{label}</p>
      <p className="mt-0.5 truncate text-lg font-semibold tracking-tight text-ink">{value}</p>
      {hint && <p className="text-[11px] leading-4 text-ink-3">{hint}</p>}
    </div>
  );
}

export function AdsKpis({ data }: { data: AdsAnalytics }) {
  const t = data.totals!;
  const m = data.matched;
  const cov = data.coverage;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi testId="ads-kpi-spend" label="Ad spend" value={formatInr(t.spend)} hint="Reported by the ad platform" />
        <Kpi testId="ads-kpi-clicks" label="Clicks" value={fmtCountNum(t.clicks)} hint={`${fmtCountNum(t.impressions)} impressions`} />
        <Kpi testId="ads-kpi-conversions" label="Platform conversions" value={t.providerConversions === null ? dash : fmtCountNum(t.providerConversions)} hint="As the platform counts them — not PulseOS outcomes" />
        <Kpi testId="ads-kpi-roas" label="ROAS (matched)" value={m ? fmtRoasX(m.roas) : dash} hint={m ? `${formatInr(m.revenue)} revenue / ${formatInr(m.spend)} spend` : "No campaign matched to PulseOS yet"} />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="ads-pulseos-costs">
        <Kpi testId="ads-kpi-cpl" label="Cost per lead" value={inr(m?.costPerLead ?? null)} hint={m ? `${m.leads} PulseOS leads` : undefined} />
        <Kpi testId="ads-kpi-cpa" label="Cost per appointment" value={inr(m?.costPerAppointment ?? null)} hint={m ? `${m.appointments} appointments` : undefined} />
        <Kpi testId="ads-kpi-cpc" label="Cost per consultation" value={inr(m?.costPerConsultation ?? null)} hint={m ? `${m.consultations} consultations` : undefined} />
        <Kpi testId="ads-kpi-cpt" label="Cost per treatment" value={inr(m?.costPerTreatment ?? null)} hint={m ? `${m.treatments} treatments` : undefined} />
      </div>
      <p className="text-[11px] leading-4 text-ink-2" data-testid="ads-coverage">
        {cov.matchedCampaigns === 0
          ? "None of these campaigns is linked to PulseOS enquiries yet, so costs per lead, appointment, consultation and treatment, and ROAS, are not shown rather than guessed."
          : `Costs and ROAS use the ${cov.matchedCampaigns} of ${cov.totalCampaigns} campaigns PulseOS can link to its own enquiries (${formatInr(cov.matchedSpend)} of ${formatInr(cov.totalSpend)} spend). A cost needs at least one outcome to divide by.`}
      </p>
    </div>
  );
}

export function AdsSpendChart({ data, height = 240 }: { data: AdsAnalytics; height?: number }) {
  if (data.daily.length === 0) return <ChartEmptyState height={height} message="No daily ad data" hint="Run a sync to load it." />;
  const rows = data.daily.map((d) => ({ label: fmtDayShort(d.date), ...d }));
  const axis = niceMoneyAxis(Math.max(...rows.map((r) => r.spend), 0));
  return (
    <div data-testid="ads-spend-chart">
      <div style={{ height }} className="w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height }}>
          <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: CHART_INK.baseline }} tick={{ fontSize: 11, fill: CHART_INK.secondary }} interval="equidistantPreserveStart" minTickGap={14} tickMargin={6} />
            <YAxis width={44} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART_INK.secondary }} tickFormatter={fmtInrAxis} domain={[0, axis.max]} ticks={axis.ticks} />
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as (typeof rows)[number];
                return <ChartTooltipCard title={fmtDayShort(r.date)} rows={[{ key: "s", label: "Ad spend", color: CHART_INK.accent, value: formatInr(r.spend) }, { key: "c", label: "Clicks", color: CHART_INK.context, value: fmtCountNum(r.clicks) }]} />;
              }}
            />
            <Area type="monotone" dataKey="spend" stroke={CHART_INK.accent} fill={CHART_INK.accent} fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* The same numbers as text: the chart itself is a pointer aid; assistive tech and keyboard users read this. */}
      <table className="sr-only" data-testid="ads-spend-table">
        <caption>Ad spend and clicks per day</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Ad spend</th><th scope="col">Clicks</th></tr></thead>
        <tbody>{data.daily.map((d) => <tr key={d.date}><th scope="row">{fmtDayShort(d.date)}</th><td>{formatInr(d.spend)}</td><td>{fmtCountNum(d.clicks)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Row({ c }: { c: AdsCampaignRow }) {
  return (
    <Tr className="hover:bg-transparent" data-testid={`ads-row-${c.entityId}`}>
      <Td className="max-w-[16rem]"><span className="block truncate font-medium text-ink" title={c.name}>{c.name}</span><span className="text-[11px] text-ink-2">{ADS_PROVIDER_LABEL[c.provider]}</span></Td>
      <Td className="text-right tabular-nums">{formatInr(c.spend)}</Td>
      <Td className="text-right tabular-nums">{fmtCountNum(c.clicks)}</Td>
      <Td className="text-right tabular-nums">{c.ctr === null ? dash : fmtPct(c.ctr)}</Td>
      <Td className="text-right tabular-nums">{inr(c.cpc)}</Td>
      <Td className="text-right tabular-nums" title="As the platform counts it">{c.providerMappedLeads !== null ? `${fmtCountNum(c.providerMappedLeads)} mapped` : c.providerConversions !== null ? fmtCountNum(c.providerConversions) : dash}</Td>
      <Td className="text-right tabular-nums">{c.pulseos ? fmtCountNum(c.pulseos.leads) : <span className="text-ink-3">Not linked</span>}</Td>
      <Td className="text-right tabular-nums">{inr(c.costPerLead)}</Td>
      <Td className="text-right tabular-nums">{fmtRoasX(c.roas)}</Td>
    </Tr>
  );
}

export function AdsCampaignTable({ data }: { data: AdsAnalytics }) {
  return (
    <TableShell>
      <Table>
        <TableHead>
          <tr>
            <Th>Campaign</Th><Th className="text-right">Spend</Th><Th className="text-right">Clicks</Th><Th className="text-right">CTR</Th><Th className="text-right">CPC</Th>
            <Th className="text-right">Platform conversions</Th><Th className="text-right">PulseOS leads</Th><Th className="text-right">Cost / lead</Th><Th className="text-right">ROAS</Th>
          </tr>
        </TableHead>
        <TableBody>{data.campaigns.map((c) => <Row key={`${c.provider}-${c.entityId}`} c={c} />)}</TableBody>
      </Table>
    </TableShell>
  );
}

/** Setup / empty states. Never zeros: an unavailable number is a sentence that says why. */
export function AdsUnavailable({ reason }: { reason: NonNullable<AdsAnalytics["unavailable"]> }) {
  const u = UNAVAILABLE[reason];
  return (
    <div className="rounded-card border border-dashed border-line-strong bg-surface-info/50 px-4 py-6 text-center" data-testid={`ads-unavailable-${reason}`}>
      <p className="text-sm font-semibold text-ink">{u.title}</p>
      <p className="mx-auto mt-1 max-w-xl text-xs text-ink-2">{u.body}</p>
      {u.cta && <Link href={u.cta.href} className="mt-2 inline-block text-xs text-primary-700 underline-offset-2 hover:underline">{u.cta.label}</Link>}
    </div>
  );
}

export { ProviderStrip };
