"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import {
  Badge, Button, EmptyState, ErrorState, SectionHeading, Skeleton, Table, TableBody, TableHead, Td, Th, Tr,
  relativeTime, CONNECTOR_STATUS_LABEL, CONNECTOR_STATUS_TONE, CONNECTOR_EVENT_STATUS_LABEL, CONNECTOR_EVENT_STATUS_TONE,
} from "@pulseos/ui";
import { capabilityEnabled, hasPermission } from "@pulseos/types";
import type { CommunicationEndpointType, CommunicationEndpointVm, ConnectorMode, ConnectorType } from "@pulseos/types";
import { Mail, MessageCircle, Phone, Radio, ShieldCheck, Target, Zap } from "lucide-react";

const TYPE_ICON: Record<ConnectorType, typeof Phone> = {
  MESSAGING: MessageCircle,
  TELEPHONY: Phone,
  ADS: Zap,
  EMAIL: Mail,
  STORAGE: Radio,
  HIS: ShieldCheck,
  ACQUISITION: Target,
};

const TYPE_LABEL: Record<ConnectorType, string> = {
  MESSAGING: "Messaging",
  TELEPHONY: "Telephony",
  ADS: "Ads",
  EMAIL: "Email",
  STORAGE: "Storage",
  HIS: "HIS",
  ACQUISITION: "Acquisition",
};

const STATUS_LABEL = CONNECTOR_STATUS_LABEL;
const STATUS_TONE = CONNECTOR_STATUS_TONE;

// A connected connector is only ever really "live" when its mode says so —
// FIXTURE/SANDBOX must never read as equivalent to a real production
// connection, no matter how healthy their status looks otherwise.
const MODE_LABEL: Record<ConnectorMode, string> = { FIXTURE: "Fixture", SANDBOX: "Sandbox", LIVE: "Live" };
const MODE_TONE: Record<ConnectorMode, "neutral" | "warning" | "primary"> = { FIXTURE: "neutral", SANDBOX: "warning", LIVE: "primary" };

const ENDPOINT_TYPE_LABEL: Record<CommunicationEndpointType, string> = { PHONE: "Phone", WHATSAPP: "WhatsApp" };

// The N-numbers-per-connector layer (a WABA can hold many phone_number_ids;
// a Runo integration can cover several SIM/reception lines) — only relevant
// for TELEPHONY/MESSAGING connectors, an ADS/EMAIL/STORAGE/HIS connector has
// no phone lines to configure here.
function EndpointsSection({ connectorId, canManage }: { connectorId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const endpoints = useQuery({ queryKey: ["connector-endpoints", connectorId], queryFn: () => api.communicationEndpoints(connectorId) });
  const branches = useQuery({ queryKey: ["branches"], queryFn: api.branches, enabled: canManage });

  const [showAddForm, setShowAddForm] = useState(false);
  const [newType, setNewType] = useState<CommunicationEndpointType>("PHONE");
  const [newPublicNumber, setNewPublicNumber] = useState("");
  const [newProviderRef, setNewProviderRef] = useState("");
  const [newDisplayLabel, setNewDisplayLabel] = useState("");
  const [newBranchId, setNewBranchId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["connector-endpoints", connectorId] });
  }

  async function toggleActive(endpoint: CommunicationEndpointVm) {
    setRowError(null);
    setTogglingId(endpoint.id);
    try {
      await api.updateCommunicationEndpoint(connectorId, endpoint.id, { isActive: !endpoint.isActive });
      invalidate();
    } catch {
      setRowError(`Could not update "${endpoint.displayLabel}" — try again.`);
    } finally {
      setTogglingId(null);
    }
  }

  function resetForm() {
    setNewType("PHONE");
    setNewPublicNumber("");
    setNewProviderRef("");
    setNewDisplayLabel("");
    setNewBranchId("");
  }

  async function addEndpoint() {
    if (!newPublicNumber.trim() || !newProviderRef.trim() || !newDisplayLabel.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.createCommunicationEndpoint(connectorId, {
        connectorId,
        type: newType,
        publicNumber: newPublicNumber.trim(),
        providerRef: newProviderRef.trim(),
        displayLabel: newDisplayLabel.trim(),
        branchId: newBranchId || null,
      });
      resetForm();
      setShowAddForm(false);
      invalidate();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setAddError("An endpoint with this provider reference already exists on this connector.");
      } else {
        setAddError("Could not add this endpoint — try again.");
      }
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title="Endpoints"
        subtitle={endpoints.data ? `${endpoints.data.length}` : undefined}
        action={
          canManage && !showAddForm ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setAddError(null);
                setShowAddForm(true);
              }}
              data-testid="add-endpoint-button"
            >
              Add endpoint
            </Button>
          ) : undefined
        }
      />

      {endpoints.isLoading && <Skeleton className="h-16" />}
      {endpoints.isError && <ErrorState message="Could not load endpoints." />}
      {endpoints.data && endpoints.data.length === 0 && <p className="text-xs text-ink-2">No endpoints configured for this connector yet.</p>}

      {rowError && <p className="mb-2 rounded-control border border-danger-100 bg-danger-100/60 px-2.5 py-1.5 text-xs text-danger-700">{rowError}</p>}

      {endpoints.data && endpoints.data.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line">
          <Table>
            <TableHead>
              <tr>
                <Th>Type</Th>
                <Th>Number</Th>
                <Th>Provider ref</Th>
                <Th>Label</Th>
                <Th>Branch</Th>
                <Th>Status</Th>
                {canManage && <Th align="right">Actions</Th>}
              </tr>
            </TableHead>
            <TableBody>
              {endpoints.data.map((e) => (
                <Tr key={e.id} className="hover:bg-transparent" data-testid={`endpoint-row-${e.id}`}>
                  <Td className="text-neutral-600">{ENDPOINT_TYPE_LABEL[e.type]}</Td>
                  <Td className="text-ink">{e.publicNumber}</Td>
                  <Td className="text-ink-2">{e.providerRef}</Td>
                  <Td className="text-ink">{e.displayLabel}</Td>
                  <Td className="text-ink-2">{e.branchName ?? "—"}</Td>
                  <Td>
                    <Badge tone={e.isActive ? "success" : "neutral"}>{e.isActive ? "Active" : "Inactive"}</Badge>
                  </Td>
                  {canManage && (
                    <Td align="right">
                      <button
                        type="button"
                        onClick={() => toggleActive(e)}
                        disabled={togglingId === e.id}
                        className="text-xs font-medium text-primary-700 hover:underline disabled:opacity-40"
                        data-testid={`endpoint-toggle-${e.id}`}
                      >
                        {togglingId === e.id ? "Saving…" : e.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </Td>
                  )}
                </Tr>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {canManage && showAddForm && (
        <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface-muted p-3">
          {addError && (
            <p className="rounded-control border border-danger-100 bg-danger-100/60 px-2.5 py-1.5 text-xs text-danger-700" data-testid="add-endpoint-error">
              {addError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as CommunicationEndpointType)}
              className="h-8 rounded-control border border-line-strong bg-surface px-2 text-xs text-ink"
              data-testid="new-endpoint-type"
            >
              <option value="PHONE">Phone</option>
              <option value="WHATSAPP">WhatsApp</option>
            </select>
            <input
              type="text"
              placeholder="Public number, e.g. +91…"
              value={newPublicNumber}
              onChange={(e) => setNewPublicNumber(e.target.value)}
              className="h-8 rounded-control border border-line-strong bg-surface px-2 text-xs text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500"
              data-testid="new-endpoint-public-number"
            />
            <input
              type="text"
              placeholder="Provider reference"
              value={newProviderRef}
              onChange={(e) => setNewProviderRef(e.target.value)}
              className="h-8 rounded-control border border-line-strong bg-surface px-2 text-xs text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500"
              data-testid="new-endpoint-provider-ref"
            />
            <input
              type="text"
              placeholder="Display label"
              value={newDisplayLabel}
              onChange={(e) => setNewDisplayLabel(e.target.value)}
              className="h-8 rounded-control border border-line-strong bg-surface px-2 text-xs text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500"
              data-testid="new-endpoint-display-label"
            />
            <select
              value={newBranchId}
              onChange={(e) => setNewBranchId(e.target.value)}
              className="h-8 rounded-control border border-line-strong bg-surface px-2 text-xs text-ink"
              data-testid="new-endpoint-branch"
            >
              <option value="">No branch</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={addEndpoint}
              disabled={adding || !newPublicNumber.trim() || !newProviderRef.trim() || !newDisplayLabel.trim()}
              data-testid="save-endpoint-button"
            >
              {adding ? "Adding…" : "Save endpoint"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowAddForm(false);
                setAddError(null);
                resetForm();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConnectorsWorkbench() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<"campaigns" | "performance" | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  // MANAGE_INTEGRATION_CONFIG gates operational config mutations server-side (raw secrets need MANAGE_INTEGRATION_SECRETS and have no UI here) — mirrored
  // here only to avoid showing dead controls, never as the actual
  // authorization boundary.
  const canManage = !!session.data && hasPermission(session.data.user.role, "MANAGE_INTEGRATION_CONFIG");
  // Campaign / spend sync belongs to the growth edition; a Beta V1 tenant neither sees nor can call it.
  const canSync = canManage && capabilityEnabled(session.data!.user.capabilities, "CAMPAIGNS");

  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  const effectiveSelectedId = selectedId ?? connectors.data?.[0]?.id ?? null;

  const detail = useQuery({
    queryKey: ["connector", effectiveSelectedId],
    queryFn: () => api.connector(effectiveSelectedId!),
    enabled: !!effectiveSelectedId,
  });

  async function runSync(kind: "campaigns" | "performance") {
    if (!effectiveSelectedId) return;
    setSyncing(kind);
    setSyncMessage(null);
    const result = kind === "campaigns" ? await api.syncConnectorCampaigns(effectiveSelectedId) : await api.syncConnectorPerformance(effectiveSelectedId);
    setSyncing(null);
    setSyncMessage(result.ok ? `Synced ${result.syncedCount} record${result.syncedCount === 1 ? "" : "s"}.` : (result.message ?? result.reason));
    queryClient.invalidateQueries({ queryKey: ["connector", effectiveSelectedId] });
    queryClient.invalidateQueries({ queryKey: ["connectors"] });
  }

  return (
    <div className="flex h-full flex-col gap-4" data-testid="integrations-page">
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <div className="flex max-h-80 w-full flex-shrink-0 flex-col overflow-hidden lg:max-h-none lg:w-96 rounded-card border border-line bg-surface shadow-panel">
        <div className="border-b border-line p-3">
          <SectionHeading title="Connectors" subtitle={connectors.data ? `${connectors.data.length}` : undefined} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {connectors.isLoading && <div className="space-y-2 p-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
          {connectors.isError && <div className="p-3"><ErrorState message="Could not load connectors." /></div>}
          {connectors.data?.map((c) => {
            const Icon = TYPE_ICON[c.type];
            const active = c.id === effectiveSelectedId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setSelectedId(c.id);
                  setSyncMessage(null);
                }}
                data-testid={`connector-row-${c.provider}`}
                className={`flex w-full items-start gap-2 border-b border-line px-3 py-2.5 text-left hover:bg-primary-50/60 ${active ? "border-l-2 border-l-primary-600 bg-primary-50" : "border-l-2 border-l-transparent"}`}
              >
                <Icon size={15} className="mt-0.5 flex-shrink-0 text-ink-2" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-ink">{c.displayName}</span>
                    <span className="whitespace-nowrap text-[10px] text-ink-2">{relativeTime(c.lastEventAt)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-2">{TYPE_LABEL[c.type]}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                    <Badge tone={MODE_TONE[c.mode]}>{MODE_LABEL[c.mode]}</Badge>
                    {c.capabilities.slice(0, 2).map((cap) => (
                      <span key={cap} className="rounded-chip bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
                        {cap.replace(/_/g, " ")}
                      </span>
                    ))}
                    {c.capabilities.length > 2 && <span className="text-[10px] text-ink-2">+{c.capabilities.length - 2}</span>}
                  </div>
                </div>
              </button>
            );
          })}
          {/* Not a connector row: CCS / IVRSMS has no live webhook or authenticated access yet, so it is listed as what it is — not configured — and is never selectable or "connectable" from here. */}
          <div className="border-t border-line bg-surface-muted px-3 py-2.5" data-testid="connector-row-ccs-ivrsms-not-configured">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-ink">CCS / IVRSMS</span>
              <Badge tone="neutral">Not configured</Badge>
            </div>
            <p className="mt-0.5 text-[11px] text-ink-2">Telephony · no live webhook or provider access yet, so nothing is connected.</p>
          </div>
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto rounded-card border border-line bg-surface p-5 shadow-panel">
        {!detail.data && !detail.isLoading && <EmptyState message="Select a connector to view its configuration." />}
        {detail.isLoading && <Skeleton className="h-64" />}
        {detail.data && (
          <div className="space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-ink">{detail.data.connector.displayName}</h2>
                <p className="mt-0.5 text-xs text-ink-2">
                  {TYPE_LABEL[detail.data.connector.type]} · provider key <code className="rounded bg-neutral-100 px-1 py-0.5 text-[11px]">{detail.data.connector.provider}</code>
                </p>
              </div>
              <span className="flex items-center gap-1.5">
                <Badge tone={STATUS_TONE[detail.data.connector.status]}>{STATUS_LABEL[detail.data.connector.status]}</Badge>
                <Badge tone={MODE_TONE[detail.data.connector.mode]}>{MODE_LABEL[detail.data.connector.mode]}</Badge>
              </span>
            </div>

            <div className="grid grid-cols-3 gap-4 border-y border-line py-4 text-xs">
              <div>
                <span className="block text-[11px] uppercase tracking-wide text-ink-2">Secrets configured</span>
                <span className="text-sm text-ink">{detail.data.connector.hasSecrets ? "Yes" : "No"}</span>
              </div>
              <div>
                <span className="block text-[11px] uppercase tracking-wide text-ink-2">Last event</span>
                <span className="text-sm text-ink">{relativeTime(detail.data.connector.lastEventAt)}</span>
              </div>
              <div>
                <span className="block text-[11px] uppercase tracking-wide text-ink-2">Last sync</span>
                <span className="text-sm text-ink">{relativeTime(detail.data.connector.lastSyncAt)}</span>
              </div>
            </div>

            {detail.data.connector.mode !== "LIVE" && (
              <div className="rounded-control border border-line bg-surface-info px-3 py-2 text-xs text-ink" data-testid="connector-mode-notice">
                <span className="font-semibold">{MODE_LABEL[detail.data.connector.mode]} mode.</span>{" "}
                {detail.data.connector.mode === "FIXTURE"
                  ? "Sample data only — this is not a live provider connection, whatever the status above says."
                  : "Provider sandbox — test traffic only, not a live production connection."}
              </div>
            )}

            {detail.data.connector.lastError && (
              <div className="rounded-control border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs text-danger-700">
                Last error: {detail.data.connector.lastError}
              </div>
            )}

            <div>
              <SectionHeading title="Capabilities" />
              <div className="flex flex-wrap gap-1.5">
                {detail.data.connector.capabilities.map((cap) => (
                  <span key={cap} className="rounded-chip bg-neutral-100 px-2 py-1 text-[11px] font-medium text-ink">
                    {cap.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>

            {(detail.data.connector.type === "TELEPHONY" || detail.data.connector.type === "MESSAGING") && (
              <EndpointsSection connectorId={detail.data.connector.id} canManage={canManage} />
            )}

            <div>
              <SectionHeading title="Configuration" subtitle="Non-secret metadata only" />
              {!detail.data.configuration && <p className="text-xs text-ink-2">No configuration set.</p>}
              {detail.data.configuration && (
                <dl className="space-y-1 text-xs">
                  {Object.entries(detail.data.configuration).map(([key, value]) => (
                    <div key={key} className="flex justify-between border-b border-neutral-50 pb-1">
                      <dt className="text-ink-2">{key}</dt>
                      <dd className="font-medium text-ink">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <div>
              <SectionHeading title="Recent events" subtitle={`${detail.data.recentEvents.length}`} />
              {detail.data.recentEvents.length === 0 && <p className="text-xs text-ink-2">No events recorded yet.</p>}
              {detail.data.recentEvents.length > 0 && (
                <div className="overflow-hidden rounded-card border border-line">
                  <Table>
                    <TableHead>
                      <tr>
                        <Th>Direction</Th>
                        <Th>Status</Th>
                        <Th>Event id</Th>
                        <Th>Received</Th>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {detail.data.recentEvents.map((e) => (
                        <Tr key={e.id} className="hover:bg-transparent">
                          <Td className="text-neutral-600">{e.direction}</Td>
                          <Td>
                            <Badge tone={CONNECTOR_EVENT_STATUS_TONE[e.status] ?? "neutral"}>{CONNECTOR_EVENT_STATUS_LABEL[e.status] ?? e.status}</Badge>
                          </Td>
                          <Td className="text-ink-2">{e.externalEventId}</Td>
                          <Td className="text-ink-2">{relativeTime(e.receivedAt)}</Td>
                        </Tr>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["connector", effectiveSelectedId] })}
                title="Reload this connector's status from PulseOS — does not contact the provider"
              >
                Reload Status
              </Button>
              {canSync && detail.data.connector.capabilities.includes("SYNC_CAMPAIGNS") && (
                <Button size="sm" variant="primary" onClick={() => runSync("campaigns")} disabled={syncing !== null} data-testid="sync-campaigns-button">
                  {syncing === "campaigns" ? "Syncing…" : "Sync Campaigns"}
                </Button>
              )}
              {canSync && detail.data.connector.capabilities.includes("SYNC_PERFORMANCE") && (
                <Button size="sm" variant="primary" onClick={() => runSync("performance")} disabled={syncing !== null} data-testid="sync-performance-button">
                  {syncing === "performance" ? "Syncing…" : "Sync Performance"}
                </Button>
              )}
              {syncMessage && <span className="text-xs text-ink-2">{syncMessage}</span>}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
