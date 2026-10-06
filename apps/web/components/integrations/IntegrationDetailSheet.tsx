"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, ErrorState, SideSheet, Skeleton, Tabs, relativeTime } from "@pulseos/ui";
import { hasPermission, type IntegrationDetail, type IntegrationInboundState } from "@pulseos/types";
import { CONFIG_LABEL, CONFIG_TONE, HEALTH_LABEL, HEALTH_TONE, MODE_LABEL, MODE_TONE } from "./hubLabels";
import { LogsPanel } from "./LogsPanel";
import { CallDetailPanel, RecentCalls } from "./TelephonyCalls";
import { LinesAndTeam } from "./LinesAndTeam";
import { WebhookAddress } from "./WebhookAddress";

const field = "h-11 w-full rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-9";

type SectionKey = "overview" | "configuration" | "credentials" | "lines" | "mappings" | "webhooks" | "sync" | "activity" | "health";

const WEBHOOK_LABEL = { READY: "Ready", NOT_READY: "Not ready" } as const;
const CREDENTIAL_LABEL = { SAVED: "Saved", NOT_CONFIGURED: "Not configured", UNREADABLE: "Unreadable" } as const;

/** Inbound-webhook readiness as separate facts. There is no outbound call to "test", so nothing here claims a connection. */
export function InboundWebhookStatus({ inbound }: { inbound: IntegrationInboundState }) {
  return (
    <div className="space-y-2 rounded-control border border-line bg-surface p-3" data-testid="inbound-status">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-3">Inbound call reports</span>
      <dl className="grid grid-cols-3 gap-3 text-xs">
        <div><dt className="text-ink-3">Webhook</dt><dd className="mt-0.5"><Badge tone={inbound.webhook === "READY" ? "success" : "warning"}><span data-testid="inbound-webhook">{WEBHOOK_LABEL[inbound.webhook]}</span></Badge></dd></div>
        <div><dt className="text-ink-3">Credentials</dt><dd className="mt-0.5"><Badge tone={inbound.credentials === "SAVED" ? "success" : inbound.credentials === "UNREADABLE" ? "danger" : "neutral"}><span data-testid="inbound-credentials">{CREDENTIAL_LABEL[inbound.credentials]}</span></Badge></dd></div>
        <div><dt className="text-ink-3">Last valid call report</dt><dd className="mt-0.5 text-ink" data-testid="inbound-last-event">{inbound.lastValidEventAt ? relativeTime(inbound.lastValidEventAt) : "No call report yet"}</dd></div>
      </dl>
      <p className="text-[11px] text-ink-2">{inbound.note}</p>
    </div>
  );
}

function Overview({ d }: { d: IntegrationDetail }) {
  const queryClient = useQueryClient();
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const checkStatus = useMutation({
    mutationFn: () => api.checkIntegrationStatus(d.key),
    onSuccess: (res) => {
      setCheckMsg(res.message);
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
    onError: (e: any) => setCheckMsg(e?.message || "Status check failed."),
  });

  return (
    <div className="space-y-3 text-sm">
      {d.isConnected && (
        <div className="flex items-center justify-between rounded-card border border-emerald-200 bg-emerald-50/70 p-3 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <div>
              <p className="text-xs font-semibold text-emerald-800">Connection Verified & Live</p>
              <p className="text-[11px] text-emerald-700">Webhook events and telephony data are flowing properly.</p>
            </div>
          </div>
          <Badge tone="success">Connected</Badge>
        </div>
      )}
      {d.phoneNumbers && d.phoneNumbers.length > 0 && (
        <div className="rounded-control border border-line bg-surface p-3 space-y-1.5">
          <span className="block text-[11px] font-semibold text-ink-3 uppercase tracking-wide">Configured Phone Line(s)</span>
          <div className="space-y-1">
            {d.phoneNumbers.map((pn) => (
              <div key={pn.number} className="flex items-center justify-between text-xs bg-surface-muted rounded px-2.5 py-1.5 border border-line/60">
                <span className="font-semibold text-ink">📞 {pn.number}</span>
                <span className="text-ink-2 text-[11px]">{pn.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {d.inbound && <InboundWebhookStatus inbound={d.inbound} />}
      <p className="text-ink-2">{d.purpose}</p>
      {d.blockedReason && <p className="rounded-control border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs text-danger-700">{d.blockedReason}. Nothing can be enabled or configured until it is provided.</p>}
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-ink-3">Enabled</dt><dd className="mt-0.5">{d.capability ? <Badge tone={d.enabled ? "primary" : "neutral"}>{d.enabled ? "On" : "Off"}</Badge> : "Always available"}</dd></div>
        <div><dt className="text-ink-3">Configuration</dt><dd className="mt-0.5"><Badge tone={CONFIG_TONE[d.configuration]}>{CONFIG_LABEL[d.configuration]}</Badge></dd></div>
        <div><dt className="text-ink-3">Health</dt><dd className="mt-0.5"><Badge tone={HEALTH_TONE[d.health]}>{HEALTH_LABEL[d.health]}</Badge></dd></div>
        <div><dt className="text-ink-3">Mode</dt><dd className="mt-0.5"><Badge tone={MODE_TONE[d.mode]}>{MODE_LABEL[d.mode]}</Badge></dd></div>
      </dl>
      <div className="flex items-center justify-between pt-2 border-t border-line/60">
        <span className="text-xs text-ink-3">Connection status & check</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={checkStatus.isPending}
          onClick={() => { setCheckMsg(null); checkStatus.mutate(); }}
          data-testid="overview-check-status"
        >
          {checkStatus.isPending ? "Checking…" : "Check Status"}
        </Button>
      </div>
      {checkMsg && <p className="text-xs text-primary-700 bg-primary-50 rounded px-2.5 py-1.5 border border-primary-200" role="status">{checkMsg}</p>}
      {d.capability && (
        <p className="text-xs text-ink-2">
          The on/off switch lives in <Link href="/settings?section=features" className="text-primary-700 underline-offset-2 hover:underline">Settings → Features</Link>. Turning it on does not configure or connect anything.
        </p>
      )}
    </div>
  );
}

// Known API codes -> safe, useful words. Anything else (including a raw "internal_error") gets the generic line:
// codes, SQL and stack traces never reach the screen.
const SAVE_ERR: Record<string, string> = {
  encryption_not_configured: "Secure credential storage isn't set up on this server yet, so credentials can't be saved. Ask your PulseOS administrator to finish the server setup. What you typed is kept here.",
  secrets_unreadable: "The credentials already saved can't be read by this server. Enter them again and save.",
  forbidden: "Only a Super Admin can change credentials.",
  unknown_field: "One of the fields isn't recognised for this integration.",
  invalid_request: "Check the values — one of them is too long or malformed.",
  blocked: "This integration can't be configured yet.",
};
export const saveErrorMessage = (e: unknown): string => {
  const code = (e as ApiError | undefined)?.message ?? "";
  return SAVE_ERR[code] ?? "Credentials could not be saved. Your entries are still here — try again, and tell your administrator if it keeps happening.";
};

export function ConfigurationForm({ d, secrets }: { d: IntegrationDetail; secrets: boolean }) {
  const queryClient = useQueryClient();
  const fields = secrets ? d.secretFields : d.configurationFields;
  const [values, setValues] = useState<Record<string, string>>(() => (secrets ? {} : { ...d.configurationValues }));
  const [mode, setMode] = useState(d.connectorMode ?? "FIXTURE");
  const [message, setMessage] = useState<string | null>(null);
  const [ackLive, setAckLive] = useState(false);
  const goingLive = secrets && mode === "LIVE" && (d.connectorMode ?? "FIXTURE") !== "LIVE";
  const save = useMutation({
    mutationFn: () => api.configureIntegration(d.key, secrets ? { secrets: values, ...(mode !== (d.connectorMode ?? "FIXTURE") ? { mode } : {}) } : { configuration: values }),
    onSuccess: () => {
      setMessage("Saved.");
      if (secrets) setValues({});
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
    onError: (e: unknown) => setMessage(secrets ? saveErrorMessage(e) : SAVE_ERR[(e as ApiError)?.message] ?? "Could not save — check the values and your permission."),
  });
  const allowed = secrets ? d.canManageSecrets : d.canConfigure;
  if (fields.length === 0) return <p className="text-sm text-ink-2">{secrets ? "No credentials are needed." : "Nothing to configure."}</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        save.mutate();
      }}
    >
      {!allowed && <p className="text-xs text-ink-2">{secrets ? "Only a Super Admin can change credentials." : "You can view this, but not change it."}</p>}
      {secrets && d.secretsUnreadable && (
        <p role="alert" className="rounded-control border border-warning-100 bg-warning-100/50 px-3 py-2 text-xs text-ink">
          Credentials are saved for this integration but this server can&apos;t read them (its encryption key is missing or has changed), so they aren&apos;t in use. Re-enter them and save to fix this.
        </p>
      )}
      {fields.map((f) => {
        const hasSecret = "hasSecret" in f ? f.hasSecret : false;
        return (
          <label key={f.key} className="block text-xs text-ink-2">
            <span className="flex items-center justify-between gap-2">
              {f.label}
              {secrets && (d.secretsUnreadable && !hasSecret ? <Badge tone="warning">Saved · unreadable</Badge> : <Badge tone={hasSecret ? "success" : "neutral"}>{hasSecret ? "Secret saved" : "Not set"}</Badge>)}
            </span>
            <input
              type={secrets ? "password" : "text"}
              autoComplete="off"
              value={values[f.key] ?? ""}
              disabled={!allowed}
              placeholder={secrets && hasSecret ? "Leave blank to keep the saved secret" : undefined}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className={`mt-1 ${field}`}
              data-testid={`${secrets ? "secret" : "config"}-${f.key}`}
            />
            {f.help && <span className="mt-0.5 block text-[11px] text-ink-3">{f.help}</span>}
          </label>
        );
      })}
      {secrets && allowed && (
        <label className="block text-xs text-ink-2">
          Connection mode
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={`mt-1 ${field}`} data-testid="connection-mode">
            <option value="FIXTURE">Fixture — sample data, no provider contact</option>
            <option value="SANDBOX">Sandbox — the provider&apos;s test environment</option>
            <option value="LIVE">Live — the real provider</option>
          </select>
        </label>
      )}
      {goingLive && (
        <label className="flex items-start gap-2 rounded-control border border-warning-100 bg-warning-100/50 px-3 py-2 text-xs text-ink" data-testid="live-ack">
          <input type="checkbox" checked={ackLive} onChange={(e) => setAckLive(e.target.checked)} className="mt-0.5" />
          <span>I understand Live mode contacts the real provider: real patients receive messages and real accounts are read. Saving credentials does not by itself prove the connection works.</span>
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="primary" disabled={!allowed || save.isPending || (goingLive && !ackLive)} data-testid={`save-${secrets ? "credentials" : "configuration"}`}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {message && <span role="status" className="text-xs text-ink-2">{message}</span>}
      </div>
    </form>
  );
}

const SYNC_ERR: Record<string, string> = {
  feature_not_available: "This integration is switched off. Turn it on in Settings → Features.",
  not_configured: "Finish the configuration first.",
  sync_in_progress: "A sync is already running.",
  too_soon: "A sync just finished — wait a minute before syncing again.",
};

/** Telephony (IVR / Runo) sync and diagnostic section */
function TelephonySyncSection({ d }: { d: IntegrationDetail }) {
  const queryClient = useQueryClient();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const role = session.data?.user.role;
  const canPlay = !!role && hasPermission(role, "VIEW_CALL_RECORDING");
  const canDownload = !!role && hasPermission(role, "DOWNLOAD_CALL_RECORDING");

  const checkStatus = useMutation({
    mutationFn: () => api.checkIntegrationStatus(d.key),
    onSuccess: (res) => {
      setStatusMessage(res.message);
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
    onError: (e: any) => setStatusMessage(e?.message || "Status check failed."),
  });

  const testEvent = useMutation({
    mutationFn: () => api.testIntegrationEvent(d.key),
    onSuccess: (res) => {
      setTestMessage(res.message);
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
    onError: (e: any) => setTestMessage(e?.message || "Test event failed."),
  });

  if (openCallId) return <CallDetailPanel integrationKey={d.key} callId={openCallId} onBack={() => setOpenCallId(null)} canPlay={canPlay} canDownload={canDownload} />;

  return (
    <div className="space-y-4 text-sm" data-testid="telephony-sync-section">
      <div className="rounded-card border border-line bg-surface p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-ink">Inbound Event Stream</span>
          <Badge tone={d.health === "HEALTHY" ? "success" : "neutral"}>
            {d.health === "HEALTHY" ? "Live Stream Active" : "Waiting for Events"}
          </Badge>
        </div>
        <p className="text-xs text-ink-2">
          Telephony and IVR calls stream into PulseOS in real-time as calls occur. You can check endpoint readiness or send a test call event to verify that call data flows properly.
        </p>
        <dl className="grid grid-cols-2 gap-3 text-xs pt-1 border-t border-line/60">
          <div><dt className="text-ink-3">Last event</dt><dd className="font-medium text-ink">{d.lastEventAt ? relativeTime(d.lastEventAt) : "No events received yet"}</dd></div>
          <div><dt className="text-ink-3">Last verified</dt><dd className="font-medium text-ink">{d.lastSyncAt ? relativeTime(d.lastSyncAt) : "Never"}</dd></div>
        </dl>
      </div>

      <div className="space-y-2">
        <span className="block text-xs font-semibold text-ink">Sync & Diagnostic Actions</span>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={checkStatus.isPending}
            onClick={() => { setStatusMessage(null); checkStatus.mutate(); }}
            data-testid="telephony-check-status"
          >
            {checkStatus.isPending ? "Checking status…" : "Check Status"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={testEvent.isPending || !d.canConfigure}
            onClick={() => { setTestMessage(null); testEvent.mutate(); }}
            data-testid="telephony-test-call"
          >
            {testEvent.isPending ? "Sending test call…" : "Send test call event"}
          </Button>
        </div>
        {statusMessage && <p className="text-xs text-primary-700 bg-primary-50 rounded px-2.5 py-1.5 border border-primary-200" role="status">{statusMessage}</p>}
        {testMessage && <p className="text-xs text-emerald-700 bg-emerald-50 rounded px-2.5 py-1.5 border border-emerald-200" role="status">{testMessage}</p>}
      </div>

      <div className="space-y-2 border-t border-line pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-ink">Recent calls</span>
          <span className="text-[11px] text-ink-3">{(d.recentCalls ?? []).length} shown</span>
        </div>
        <RecentCalls calls={d.recentCalls ?? []} onOpen={setOpenCallId} />
      </div>
    </div>
  );
}

/** Read-only pull of reporting numbers. Nothing here changes anything at the ad platform. */
function SyncSection({ d }: { d: IntegrationDetail }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const key = d.key as "google_ads" | "meta_ads";
  const sync = useMutation({
    mutationFn: () => api.syncAds(key),
    onSuccess: (run) => {
      setMessage(run.status === "SUCCEEDED" ? `Synced ${run.rowsUpserted} daily rows.` : "The sync failed. Your previous numbers are unchanged.");
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
      queryClient.invalidateQueries({ queryKey: ["analytics", "ads"] });
    },
    onError: (e) => setMessage(SYNC_ERR[(e as ApiError).message] ?? "Could not start the sync."),
  });
  const can = d.canConfigure && d.enabled && d.configuration === "CONFIGURED";
  return (
    <div className="space-y-3 text-sm" data-testid="ads-sync-section">
      <p className="text-xs text-ink-2">Last synced: <span className="font-medium text-ink" data-testid="ads-last-synced">{d.lastSyncAt ? relativeTime(d.lastSyncAt) : "never"}</span>. Reporting only — PulseOS never creates, edits or pauses anything in the ad account.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" disabled={!can || sync.isPending} onClick={() => { setMessage(null); sync.mutate(); }} data-testid="ads-sync-now">{sync.isPending ? "Syncing…" : "Sync now"}</Button>
        {!can && <span className="text-xs text-ink-2">{!d.enabled ? "Switched off." : d.configuration !== "CONFIGURED" ? "Not configured yet." : "Only an Admin can sync."}</span>}
        {message && <span role="status" className="text-xs text-ink-2" data-testid="ads-sync-message">{message}</span>}
      </div>
      <ul className="divide-y divide-line rounded-card border border-line bg-surface text-xs">
        {(d.syncRuns ?? []).length === 0 && <li className="px-3 py-2 text-ink-2">No syncs yet.</li>}
        {(d.syncRuns ?? []).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="ads-sync-run">
            <Badge tone={r.status === "SUCCEEDED" ? "success" : r.status === "FAILED" ? "danger" : "neutral"}>{r.status.toLowerCase()}</Badge>
            <span className="text-ink-2">{r.rangeFrom} → {r.rangeTo} · {r.rowsUpserted} rows · {r.trigger.toLowerCase()}</span>
            <span className="ml-auto text-ink-3">{relativeTime(r.startedAt)}</span>
            {r.error && <span className="basis-full text-danger-700">{r.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Health({ d }: { d: IntegrationDetail }) {
  const queryClient = useQueryClient();
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const checkStatus = useMutation({
    mutationFn: () => api.checkIntegrationStatus(d.key),
    onSuccess: (res) => {
      setCheckMessage(res.message);
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
    onError: (e: any) => setCheckMessage(e?.message || "Status check failed."),
  });

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <Badge tone={HEALTH_TONE[d.health]}>{HEALTH_LABEL[d.health]}</Badge>
        <Button
          size="sm"
          variant="secondary"
          disabled={checkStatus.isPending}
          onClick={() => { setCheckMessage(null); checkStatus.mutate(); }}
          data-testid="health-check-status"
        >
          {checkStatus.isPending ? "Checking…" : "Check Status Now"}
        </Button>
      </div>
      {checkMessage && (
        <p className="rounded-control border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-800" role="status">
          {checkMessage}
        </p>
      )}
      <p className="text-xs text-ink-2">Health reflects the last verified connection state. Use &ldquo;Check Status Now&rdquo; to test endpoint readiness and verify configuration.</p>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-ink-3">Last event</dt><dd>{d.lastEventAt ? relativeTime(d.lastEventAt) : "Never"}</dd></div>
        <div><dt className="text-ink-3">Last sync</dt><dd>{d.lastSyncAt ? relativeTime(d.lastSyncAt) : "Never"}</dd></div>
      </dl>
      {d.lastError && <p className="rounded-control border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs text-danger-700">Last error: {d.lastError}</p>}
    </div>
  );
}

export function IntegrationDetailSheet({ integrationKey, onClose }: { integrationKey: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["integration-detail", integrationKey], queryFn: () => api.integrationDetail(integrationKey) });
  const [section, setSection] = useState<SectionKey>("overview");
  const d = q.data;
  const isTelephony = d?.key === "ccs_ivr" || d?.key === "runo";
  const sections: { key: SectionKey; label: string }[] = d
    ? [
        { key: "overview", label: "Overview" },
        ...(d.configurationFields.length ? [{ key: "configuration" as const, label: "Configuration" }] : []),
        ...(d.secretFields.length ? [{ key: "credentials" as const, label: "Credentials" }] : []),
        ...(d.key === "ccs_ivr" && d.connectorId && d.canManageSecrets ? [{ key: "lines" as const, label: "Lines & team" }] : []),
        ...(d.mappingNotes ? [{ key: "mappings" as const, label: "Mappings" }] : []),
        ...(d.webhookUrl ? [{ key: "webhooks" as const, label: "Webhooks" }] : []),
        ...(d.syncRuns || isTelephony ? [{ key: "sync" as const, label: "Sync" }] : []),
        ...(d.key !== "webhooks" && !d.blockedReason ? [{ key: "activity" as const, label: "Activity" }, { key: "health" as const, label: "Health" }] : []),
      ]
    : [];
  return (
    <SideSheet title={d?.name ?? "Integration"} subtitle={d?.provider} onClose={onClose} testId="integration-detail">
      {q.isLoading && <Skeleton className="h-40" />}
      {q.isError && <ErrorState message="Could not load this integration." />}
      {d && (
        <div className="space-y-4">
          <Tabs variant="underline" ariaLabel="Integration sections" value={section} onChange={(k) => setSection(k as SectionKey)} items={sections.map((s) => ({ ...s, testId: `detail-tab-${s.key}` }))} />
          {section === "overview" && <Overview d={d} />}
          {section === "configuration" && <ConfigurationForm d={d} secrets={false} />}
          {section === "credentials" && <ConfigurationForm d={d} secrets />}
          {section === "lines" && d.connectorId && <LinesAndTeam connectorId={d.connectorId} />}
          {section === "mappings" && <p className="text-sm text-ink-2">{d.mappingNotes}</p>}
          {section === "webhooks" && (
            <div className="space-y-3 text-sm">
              {d.key === "ccs_ivr" && <WebhookAddress integrationKey={d.key} tokenSet={!!d.inbound?.webhookTokenSet} canManage={d.canManageSecrets} />}
              <p className="text-xs text-ink-2">{d.key === "ccs_ivr" ? "The base address (it is not enough on its own: requests without the secret token are refused):" : "Give the provider this address to send events to PulseOS:"}</p>
              <code className="block break-all rounded-control bg-neutral-100 px-2 py-1.5 text-xs font-mono font-medium" data-testid="provider-webhook-url">{d.webhookUrl}</code>
              {d.webhookUrl?.includes("localhost") && (
                <div className="rounded-card border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 space-y-1">
                  <p className="font-semibold text-amber-900">Localhost address detected</p>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    Cloud IVR providers (like CCS IVR) cannot reach your local computer at <code className="font-mono text-amber-900">localhost</code>. To receive live calls locally, run an HTTPS tunnel (e.g. <code className="font-mono text-amber-900">ngrok http 4310</code>), set <code className="font-mono text-amber-900">PUBLIC_API_BASE_URL</code> in <code className="font-mono text-amber-900">apps/api/.env</code>, and paste the public URL into your CCS IVR webhook settings.
                  </p>
                </div>
              )}
              <p className="text-[11px] text-ink-3">Every request must carry a saved key or the secret token; anything else is refused before it is read.</p>
            </div>
          )}
          {section === "sync" && (isTelephony ? <TelephonySyncSection d={d} /> : <SyncSection d={d} />)}
          {section === "activity" && <LogsPanel provider={d.key} />}
          {section === "health" && <Health d={d} />}
        </div>
      )}
    </SideSheet>
  );
}
