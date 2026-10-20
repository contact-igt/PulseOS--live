"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Minus } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Panel, Skeleton, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { ConfigurationBadge, CredentialBadge, EnabledBadge, HealthBadge, MODE_LABEL } from "../../../../../../../components/platform/integrationLabels";
import { ErrorPanel, Fact, PlatformPage, fmtAgo, fmtWhen } from "../../../../../../../components/platform/ui";

/**
 * Connector support view: state, mappings and safe event metadata. Never a credential value, ciphertext, payload or
 * recording link. To change anything, use Support Mode with edits enabled (the hospital's own Integration Hub).
 */
export default function TenantIntegrationPage() {
  const { id, key } = useParams<{ id: string; key: string }>();
  const q = useQuery({ queryKey: ["platform", "tenant", id, "integration", key], queryFn: () => platformApi.tenantIntegration(id, key) });
  const back = (
    <Link href={`/platform/tenants/${id}?tab=integrations`} className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
      <ArrowLeft size={14} /> {q.data?.tenant.name ?? "Tenant"}
    </Link>
  );
  if (q.isError)
    return (
      <PlatformPage title="Integration" back={back}>
        <ErrorPanel error={q.error} onRetry={() => q.refetch()} />
      </PlatformPage>
    );
  if (!q.data)
    return (
      <PlatformPage title="Loading…" back={back}>
        <Skeleton className="h-48 w-full" />
      </PlatformPage>
    );
  const d = q.data;
  const i = d.integration;

  return (
    <PlatformPage title={`${i.connectorName} · ${d.tenant.name}`} subtitle={i.purpose} back={back} testId="platform-integration-detail">
      <Panel title="State">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Enabled">
            <EnabledBadge enabled={i.enabled} />
          </Fact>
          <Fact label="Configuration">
            <ConfigurationBadge state={i.configuration} />
          </Fact>
          <Fact label="Credentials">
            <CredentialBadge state={i.credentialState} />
          </Fact>
          <Fact label="Health">
            <HealthBadge health={i.health} />
          </Fact>
          <Fact label="Mode">{MODE_LABEL[i.mode]}</Fact>
          <Fact label="Last valid event">{i.lastEventAt ? fmtWhen(i.lastEventAt) : "Never"}</Fact>
          <Fact label="Last sync">{fmtWhen(i.lastSyncAt)}</Fact>
          <Fact label="Events (24 h)">{d.eventTotals ? `${d.eventTotals.last24h} · ${d.eventTotals.failed24h} failed` : "—"}</Fact>
        </dl>
        {i.attention && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="warning">{i.attention}</Badge>
            {i.lastError && <span className="text-xs text-ink-2">{i.lastError}</span>}
          </p>
        )}
        <p className="mt-3 text-xs text-ink-2">To change this integration, open the tenant in Support Mode and enable edits — changes go through the hospital&apos;s own Integration Hub and are audited.</p>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Settings present" subtitle="Names only">
          {d.configurationFields.length + d.secretFields.length === 0 ? (
            <p className="text-sm text-ink-2">This integration has no settings.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {d.configurationFields.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-2">
                  <span>{f.label}</span>
                  <span className="flex items-center gap-1 text-xs text-ink-2">{f.set ? <><Check size={14} className="text-accent-700" aria-hidden="true" /> Set</> : <><Minus size={14} aria-hidden="true" /> Not set</>}</span>
                </li>
              ))}
              {d.secretFields.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-2" data-testid={`secret-${f.key}`}>
                  <span>
                    {f.label} <span className="text-[11px] text-ink-2">(credential)</span>
                  </span>
                  <span className="flex items-center gap-1 text-xs text-ink-2">{f.saved ? <><Check size={14} className="text-accent-700" aria-hidden="true" /> Saved</> : <><Minus size={14} aria-hidden="true" /> Not saved</>}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Lines & mappings">
          {d.endpoints.length === 0 && d.dispositionMappings.length === 0 && !d.recordings ? (
            <p className="text-sm text-ink-2">No phone lines or mappings.</p>
          ) : (
            <div className="space-y-3 text-sm">
              {d.endpoints.length > 0 && (
                <ul className="space-y-1">
                  {d.endpoints.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {e.label} <span className="font-mono text-xs text-ink-2">{e.publicNumber}</span>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-ink-2">
                        {e.branch ?? "No branch"} <Badge tone={e.active ? "success" : "neutral"}>{e.active ? "Active" : "Inactive"}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {d.dispositionMappings.length > 0 && (
                <p className="text-xs text-ink-2">
                  {d.dispositionMappings.length} disposition mapping(s): {d.dispositionMappings.map((m) => `${m.disposition} → ${m.action.toLowerCase().replace(/_/g, " ")}`).join("; ")}
                </p>
              )}
              {d.recordings && (
                <p className="text-xs text-ink-2" data-testid="recording-summary">
                  {d.recordings.calls} call(s), {d.recordings.withRecording} with a recording · last call {fmtAgo(d.recordings.lastCallAt)}. Recordings play only inside the hospital&apos;s app, with its permissions.
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>

      {d.webhooks.length > 0 && (
        <Panel title="Webhooks" padded={false}>
          <ul className="divide-y divide-neutral-100">
            {d.webhooks.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span>
                  {w.name} <span className="text-xs text-ink-2">· {w.events.length} event(s)</span>
                </span>
                <span className="flex gap-1.5">
                  <Badge tone={w.enabled ? "primary" : "neutral"}>{w.enabled ? "Enabled" : "Off"}</Badge>
                  {w.lastDelivery && <Badge tone={w.lastDelivery === "SENT" ? "success" : w.lastDelivery === "FAILED" ? "danger" : "neutral"}>{w.lastDelivery.toLowerCase()}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Recent events" subtitle="Time, direction and outcome only — never a payload" padded={false} data-testid="integration-events">
        {d.recentEvents.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-2">No events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[600px]">
              <TableHead>
                <tr>
                  <Th leading>Received</Th>
                  <Th>Direction</Th>
                  <Th>Outcome</Th>
                  <Th>Processed</Th>
                  <Th>Error</Th>
                </tr>
              </TableHead>
              <TableBody>
                {d.recentEvents.map((e, n) => (
                  <Tr key={n}>
                    <Td leading>{fmtWhen(e.at)}</Td>
                    <Td>{e.direction}</Td>
                    <Td>
                      <Badge tone={e.status === "failed" ? "danger" : e.status === "processed" ? "success" : "neutral"}>{e.status}</Badge>
                    </Td>
                    <Td>{fmtWhen(e.processedAt)}</Td>
                    <Td nowrap={false}>{e.error ?? <span className="text-ink-2">—</span>}</Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </PlatformPage>
  );
}
