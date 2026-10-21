"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, Panel, Skeleton } from "@pulseos/ui";
import { ErrorPanel, Fact, PlatformPage, fmtAgo, fmtWhen } from "../../../../components/platform/ui";

// Baked in at build time (next.config.ts): the web build's own commit and time. Never a path or a secret.
const WEB_COMMIT = process.env.NEXT_PUBLIC_BUILD_COMMIT || null;
const WEB_BUILT_AT = process.env.NEXT_PUBLIC_BUILD_TIME || null;

function Status({ ok, okLabel = "OK", badLabel = "Down" }: { ok: boolean; okLabel?: string; badLabel?: string }) {
  return <Badge tone={ok ? "success" : "danger"}>{ok ? okLabel : badLabel}</Badge>;
}

/** What can honestly be said about the platform right now. Not an infrastructure monitor. */
export default function HealthPage() {
  const q = useQuery({ queryKey: ["platform", "health"], queryFn: platformApi.health, refetchInterval: 60_000 });
  return (
    <PlatformPage
      title="Platform Health"
      subtitle="Live checks of this deployment. Real status only; nothing estimated."
      testId="platform-health"
      actions={
        <Button onClick={() => q.refetch()} disabled={q.isFetching}>
          <RotateCw size={14} /> {q.isFetching ? "Checking…" : "Check again"}
        </Button>
      }
    >
      {q.isError ? (
        <ErrorPanel error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Panel title="API">
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Status">
                  <Status ok={q.data.api.ok} />
                </Fact>
                <Fact label="Environment">{q.data.api.environment}</Fact>
                <Fact label="Version">{q.data.api.version}</Fact>
                <Fact label="Commit">{q.data.api.commit ? <span className="font-mono">{q.data.api.commit}</span> : <span className="text-ink-2">Not provided by the build</span>}</Fact>
                <Fact label="Process started">{fmtWhen(q.data.api.startedAt)}</Fact>
                <Fact label="Checked">{fmtAgo(q.data.checkedAt)}</Fact>
              </dl>
            </Panel>
            <Panel title="Web">
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Status">
                  <Status ok />
                </Fact>
                <Fact label="Commit">{WEB_COMMIT ? <span className="font-mono">{WEB_COMMIT.slice(0, 12)}</span> : <span className="text-ink-2">Not provided by the build</span>}</Fact>
                <Fact label="Built">{WEB_BUILT_AT ? fmtWhen(WEB_BUILT_AT) : "—"}</Fact>
              </dl>
            </Panel>
            <Panel title="Database">
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Connectivity">
                  <Status ok={q.data.database.ok} okLabel="Reachable" badLabel="Unreachable" />
                </Fact>
                <Fact label="Round trip">{q.data.database.latencyMs} ms</Fact>
                <Fact label="Migrations">
                  {q.data.migrations.applied ?? "—"} applied
                  {q.data.migrations.pending ? (
                    <span className="ml-1">
                      <Badge tone="warning">{q.data.migrations.pending} pending</Badge>
                    </span>
                  ) : null}
                </Fact>
                <Fact label="Newest migration (authored)">{fmtWhen(q.data.migrations.newestMigrationAt)}</Fact>
              </dl>
            </Panel>
            <Panel title="Background work">
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Job runner">{q.data.jobs.runner === "enabled" ? <Badge tone="success">Running in this API process</Badge> : <Badge>Disabled here (JOBS_DISABLED)</Badge>}</Fact>
                <Fact label="Email">{q.data.email.provider === "none" ? <Badge tone="warning">No provider configured</Badge> : q.data.email.provider === "local_outbox" ? "Local outbox (development)" : q.data.email.provider}</Fact>
              </dl>
            </Panel>
            <Panel title="Connector events">
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Received (24 h)">{q.data.connectorEvents.received24h}</Fact>
                <Fact label="Failed (24 h)">
                  {q.data.connectorEvents.failed24h > 0 ? <Badge tone="danger">{q.data.connectorEvents.failed24h} failed</Badge> : "0"}
                </Fact>
                <Fact label="Waiting to process">{q.data.connectorEvents.waiting}</Fact>
                <Fact label="Oldest waiting">{q.data.connectorEvents.oldestWaitingAt ? fmtAgo(q.data.connectorEvents.oldestWaitingAt) : "—"}</Fact>
                <Fact label="Last processed">{fmtAgo(q.data.connectorEvents.lastProcessedAt)}</Fact>
              </dl>
            </Panel>
            <Panel title="Outbound webhooks">
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Delivered (24 h)">{q.data.outboundWebhooks.sent24h}</Fact>
                <Fact label="Failed (24 h)">{q.data.outboundWebhooks.failed24h > 0 ? <Badge tone="danger">{q.data.outboundWebhooks.failed24h} failed</Badge> : "0"}</Fact>
              </dl>
            </Panel>
          </div>
          <Panel title="Recent integration errors" subtitle="Last 7 days · redacted" padded={false} data-testid="health-errors">
            {q.data.recentIntegrationErrors.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-2">No integration errors in the last 7 days.</p>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {q.data.recentIntegrationErrors.map((e, i) => (
                  <li key={i} className="px-4 py-2.5 text-sm">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <Link href={`/platform/tenants/${e.tenantId}?tab=integrations`} className="font-medium text-ink hover:text-primary-700">
                          {e.tenantName}
                        </Link>
                        <span className="text-ink-2"> · {e.connector}</span>
                      </span>
                      <span className="text-xs text-ink-2">{fmtAgo(e.at)}</span>
                    </span>
                    {e.error && <span className="mt-0.5 block break-words text-xs text-ink-2">{e.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </PlatformPage>
  );
}
