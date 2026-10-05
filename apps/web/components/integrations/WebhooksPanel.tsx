"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, EmptyState, ErrorState, Skeleton, relativeTime } from "@pulseos/ui";
import {
  PULSEOS_MAPPABLE_FIELDS,
  WEBHOOK_EVENT_TYPES,
  type OutboundWebhookVm,
  type TestWebhookResult,
  type WebhookCondition,
  type WebhookEventType,
  type WebhookHeader,
  type WebhookHttpMethod,
  type WebhookPayloadMapping,
} from "@pulseos/types";

const inputClass =
  "h-9 w-full rounded-control border border-line-strong bg-surface px-3 text-xs text-ink outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 transition-colors";
const selectClass =
  "h-9 w-full rounded-control border border-line-strong bg-surface px-2 text-xs text-ink outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 transition-colors";

const ERRORS: Record<string, string> = {
  https_required: "The address must start with https://.",
  private_address: "The address must be a public host, not localhost or a private network.",
  invalid_url: "That is not a valid address.",
  credentials_in_url: "Remove the username/password from the address.",
  invalid_request: "Check the name, address and required fields.",
};

const DEFAULT_WHATSNEXUS_HEADERS: WebhookHeader[] = [
  { key: "x-api-key", value: "19679c7498ead76c8da6281171d4f7d2df5c7b9ebe8adfbecf1ff8c4a51575033" },
];

const DEFAULT_WHATSNEXUS_PAYLOADS: WebhookPayloadMapping[] = [
  { key: "call_Id", field: "call_Id", fallbackValue: "" },
  { key: "customerName", field: "customerName", fallbackValue: "" },
  { key: "phoneNumber", field: "phoneNumber", fallbackValue: "" },
  { key: "agentName", field: "agentName", fallbackValue: "" },
  { key: "createdAt", field: "createdAt", fallbackValue: "" },
  { key: "status", field: "status", fallbackValue: "OPEN" },
  { key: "typeOfEnquiry", field: "typeOfEnquiry", fallbackValue: "Follow-up" },
  { key: "source", field: "source", fallbackValue: "PULSE_OS" },
];

export function WebhooksPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks, enabled: canManage });

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [endpointPath, setEndpointPath] = useState("");
  const [httpMethod, setHttpMethod] = useState<WebhookHttpMethod>("POST");
  const [headers, setHeaders] = useState<WebhookHeader[]>([{ key: "", value: "" }]);
  const [payloads, setPayloads] = useState<WebhookPayloadMapping[]>([
    { key: "call_Id", field: "call_Id", fallbackValue: "" },
    { key: "customerName", field: "customerName", fallbackValue: "" },
    { key: "phoneNumber", field: "phoneNumber", fallbackValue: "" },
  ]);
  const [events, setEvents] = useState<WebhookEventType[]>([
    "interaction.logged",
    "whatsapp.followup_requested",
    "followup.created",
  ]);
  const [category, setCategory] = useState<"CUSTOM" | "WHATSNEXUS">("CUSTOM");

  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Live Test State
  const [testResult, setTestResult] = useState<TestWebhookResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const fullUrl = (() => {
    const base = url.trim().replace(/\/+$/, "");
    if (!base) return "";
    const path = endpointPath.trim().replace(/^\/+/, "");
    return path ? `${base}/${path}` : base;
  })();

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setUrl("");
    setEndpointPath("");
    setHttpMethod("POST");
    setHeaders([{ key: "", value: "" }]);
    setPayloads([
      { key: "call_Id", field: "call_Id", fallbackValue: "" },
      { key: "customerName", field: "customerName", fallbackValue: "" },
      { key: "phoneNumber", field: "phoneNumber", fallbackValue: "" },
    ]);
    setEvents(["interaction.logged", "whatsapp.followup_requested", "followup.created"]);
    setCategory("CUSTOM");
    setError(null);
    setTestResult(null);
  };

  const loadWhatsNexusPreset = () => {
    setName("Interaction");
    setUrl("https://invictusleadbackend-production.up.railway.app");
    setEndpointPath("/api/v1/pixeleye/webhook");
    setHttpMethod("POST");
    setHeaders(DEFAULT_WHATSNEXUS_HEADERS);
    setPayloads(DEFAULT_WHATSNEXUS_PAYLOADS);
    setEvents(["interaction.logged", "whatsapp.followup_requested", "followup.created"]);
    setCategory("WHATSNEXUS");
    setError(null);
  };

  const startEdit = (w: OutboundWebhookVm) => {
    setEditingId(w.id);
    setName(w.name);
    setUrl(w.url);
    setEndpointPath(w.endpointPath ?? "");
    setHttpMethod(w.httpMethod ?? "POST");
    setHeaders(w.headers && w.headers.length > 0 ? w.headers : [{ key: "", value: "" }]);
    setPayloads(w.payloadMapping && w.payloadMapping.length > 0 ? w.payloadMapping : [{ key: "", field: "customerName", fallbackValue: "" }]);
    setEvents(w.events);
    setCategory(w.webhookCategory ?? "CUSTOM");
    setError(null);
    setTestResult(null);
    window.scrollTo({ top: 300, behavior: "smooth" });
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });

  const create = useMutation({
    mutationFn: () => {
      const cleanHeaders = headers.filter((h) => h.key.trim() && h.value.trim());
      const cleanPayloads = payloads.filter((p) => p.key.trim() && p.field.trim());
      return api.createWebhook({
        name: name.trim(),
        url: url.trim(),
        endpointPath: endpointPath.trim() || null,
        httpMethod,
        headers: cleanHeaders,
        payloadMapping: cleanPayloads,
        webhookCategory: category,
        events,
        conditions: [],
        enabled: true,
      });
    },
    onSuccess: (r) => {
      setSecret(r.signingSecret);
      resetForm();
      refresh();
    },
    onError: (e) => setError(ERRORS[(e as ApiError).message] ?? "Could not create the webhook."),
  });

  const update = useMutation({
    mutationFn: (id: string) => {
      const cleanHeaders = headers.filter((h) => h.key.trim() && h.value.trim());
      const cleanPayloads = payloads.filter((p) => p.key.trim() && p.field.trim());
      return api.updateWebhook(id, {
        name: name.trim(),
        url: url.trim(),
        endpointPath: endpointPath.trim() || null,
        httpMethod,
        headers: cleanHeaders,
        payloadMapping: cleanPayloads,
        webhookCategory: category,
        events,
      });
    },
    onSuccess: () => {
      resetForm();
      refresh();
    },
    onError: (e) => setError(ERRORS[(e as ApiError).message] ?? "Could not update the webhook."),
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateWebhook(v.id, { enabled: v.enabled }),
    onSuccess: () => {
      setRowError(null);
      refresh();
    },
    onError: () => setRowError("Could not toggle webhook status."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      setConfirmDelete(null);
      setRowError(null);
      refresh();
    },
    onError: () => {
      setConfirmDelete(null);
      setRowError("Could not delete that webhook.");
    },
  });

  const handleTest = async () => {
    if (!url.trim()) {
      setError("Please specify a valid Webhook URL before testing.");
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const cleanHeaders = headers.filter((h) => h.key.trim() && h.value.trim());
      const cleanPayloads = payloads.filter((p) => p.key.trim() && p.field.trim());
      const res = await api.testWebhook({
        url: url.trim(),
        endpointPath: endpointPath.trim() || null,
        httpMethod,
        headers: cleanHeaders,
        payloadMapping: cleanPayloads,
      });
      setTestResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run webhook test.");
    } finally {
      setIsTesting(false);
    }
  };

  const addHeaderRow = () => setHeaders([...headers, { key: "", value: "" }]);
  const removeHeaderRow = (idx: number) => setHeaders(headers.filter((_, i) => i !== idx));
  const updateHeaderRow = (idx: number, patch: Partial<WebhookHeader>) => {
    setHeaders(headers.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  };

  const addPayloadRow = () => setPayloads([...payloads, { key: "", field: "customerName", fallbackValue: "" }]);
  const removePayloadRow = (idx: number) => setPayloads(payloads.filter((_, i) => i !== idx));
  const updatePayloadRow = (idx: number, patch: Partial<WebhookPayloadMapping>) => {
    setPayloads(payloads.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  if (!canManage) {
    return <p className="text-sm text-ink-2" data-testid="webhooks-restricted">Outbound webhooks can only be managed by a Super Admin.</p>;
  }

  return (
    <div className="space-y-6" data-testid="webhooks-panel">
      {/* Secret confirmation notice */}
      {secret && (
        <div className="rounded-control border border-primary-200 bg-primary-50 px-4 py-3 text-xs" role="status" data-testid="webhook-secret-once">
          <p className="font-semibold text-ink">Signing secret generated — copy it now, it is not displayed again.</p>
          <code className="mt-1.5 block select-all rounded border border-line bg-surface p-2 font-mono text-xs text-ink break-all">{secret}</code>
          <button type="button" className="mt-2 text-xs font-medium text-primary-700 hover:underline" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}

      {rowError && (
        <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/60 px-3 py-2 text-xs text-danger-700" data-testid="webhook-row-error">
          {rowError}
        </p>
      )}

      {/* Existing Webhooks List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Active Webhooks & Integrations</h3>
          <span className="text-xs text-ink-3">{list.data?.length ?? 0} configured</span>
        </div>

        {list.isLoading && <Skeleton className="h-24" />}
        {list.isError && <ErrorState message="Could not load webhooks." />}
        {list.data && list.data.length === 0 && <EmptyState message="No webhooks or event endpoints configured yet." />}

        {list.data?.map((w) => {
          const endpointDisplay = w.endpointPath ? `${w.url.replace(/\/+$/, "")}/${w.endpointPath.replace(/^\/+/, "")}` : w.url;
          return (
            <div key={w.id} className="rounded-card border border-line bg-surface p-4 transition-shadow hover:shadow-xs" data-testid={`webhook-${w.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-sm text-ink">{w.name}</span>
                    <Badge tone={w.enabled ? "primary" : "neutral"}>{w.enabled ? "Active" : "Disabled"}</Badge>
                    <Badge tone="neutral">{w.httpMethod ?? "POST"}</Badge>
                    {w.webhookCategory === "WHATSNEXUS" && (
                      <span className="inline-flex items-center gap-1 rounded bg-accent-orange/10 px-2 py-0.5 text-[11px] font-medium text-accent-orange">
                        WhatsNexus
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-xs text-ink-2 truncate max-w-xl" title={endpointDisplay}>{endpointDisplay}</p>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-3">
                    <span>Events: {w.events.join(", ")}</span>
                    {w.headers && w.headers.length > 0 && <span>• {w.headers.length} header{w.headers.length > 1 ? "s" : ""}</span>}
                    {w.payloadMapping && w.payloadMapping.length > 0 && <span>• {w.payloadMapping.length} payload mapping{w.payloadMapping.length > 1 ? "s" : ""}</span>}
                    <span>• Last delivery: {w.lastDeliveryAt ? `${w.lastDeliveryStatus?.toLowerCase()} · ${relativeTime(w.lastDeliveryAt)}` : "none yet"}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(w)} data-testid={`edit-webhook-${w.id}`}>
                    Edit
                  </Button>
                  <Button size="sm" variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: w.id, enabled: !w.enabled })}>
                    {w.enabled ? "Disable" : "Enable"}
                  </Button>
                  {confirmDelete === w.id ? (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="primary" disabled={remove.isPending} onClick={() => remove.mutate(w.id)} data-testid="confirm-delete-webhook">
                        Confirm
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(w.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Dynamic Endpoint Configuration Builder */}
      <div className="rounded-card border border-line bg-surface p-5 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div>
            <div className="text-xs text-ink-3 mb-0.5">
              Integrations &gt; Interaction Event &gt; {editingId ? "Edit Event" : "New Event Endpoint"}
            </div>
            <h3 className="text-base font-semibold text-ink">Endpoint Configuration</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadWhatsNexusPreset}
              className="inline-flex items-center gap-1.5 rounded-control border border-accent-orange/40 bg-accent-orange/10 px-3 py-1.5 text-xs font-semibold text-accent-orange transition-all hover:bg-accent-orange/20 active:scale-95"
              data-testid="load-whatsnexus-preset"
            >
              <span>⚡</span> Load WhatsNexus Preset
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="text-xs text-ink-2 underline-offset-2 hover:underline"
              >
                Cancel Edit
              </button>
            )}
          </div>
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (editingId) {
              update.mutate(editingId);
            } else {
              create.mutate();
            }
          }}
        >
          {/* Webhook Name */}
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">
              Webhook Name <span className="text-danger-600">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder="e.g. Interaction or WhatsNexus Follow-Up"
              required
              data-testid="webhook-name"
            />
          </div>

          {/* Webhook URL & Endpoint Path */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                Webhook URL <span className="text-danger-600">*</span>
              </label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={inputClass}
                placeholder="https://invictusleadbackend-production.up.railway.app"
                required
                data-testid="webhook-url"
              />
              <p className="mt-1 text-[11px] text-ink-3">The base URL of your webhook endpoint</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Endpoint Path</label>
              <input
                value={endpointPath}
                onChange={(e) => setEndpointPath(e.target.value)}
                className={inputClass}
                placeholder="/api/v1/pixeleye/webhook"
                data-testid="webhook-endpoint-path"
              />
              <p className="mt-1 text-[11px] text-ink-3">Optional path to append to the base URL</p>
            </div>
          </div>

          {/* Live Full URL Display */}
          {fullUrl && (
            <div className="rounded-control bg-surface-info border border-line px-3 py-2 text-xs font-mono text-ink">
              <span className="font-semibold text-ink-2 font-sans mr-2">Full URL :</span>
              {fullUrl}
            </div>
          )}

          {/* HTTP Method */}
          <div className="max-w-xs">
            <label className="block text-xs font-medium text-ink-2 mb-1">
              HTTP Method <span className="text-danger-600">*</span>
            </label>
            <select
              value={httpMethod}
              onChange={(e) => setHttpMethod(e.target.value as WebhookHttpMethod)}
              className={selectClass}
              data-testid="webhook-http-method"
            >
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="GET">GET</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>

          {/* Headers Section */}
          <div className="space-y-2 border-t border-line pt-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-2">Headers</h4>
              <span className="text-[11px] text-ink-3">e.g. x-api-key or Authorization</span>
            </div>

            <div className="overflow-hidden rounded-control border border-line">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-surface-muted text-ink-3">
                  <tr>
                    <th className="py-2 px-3 font-medium uppercase text-[10px] w-1/3">Key</th>
                    <th className="py-2 px-3 font-medium uppercase text-[10px]">Value</th>
                    <th className="py-2 px-2 w-10 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {headers.map((h, idx) => (
                    <tr key={idx} className="hover:bg-surface-muted/50">
                      <td className="p-2">
                        <input
                          value={h.key}
                          onChange={(e) => updateHeaderRow(idx, { key: e.target.value })}
                          placeholder="x-api-key"
                          className={inputClass}
                        />
                      </td>
                      <td className="p-2">
                        <input
                          value={h.value}
                          onChange={(e) => updateHeaderRow(idx, { value: e.target.value })}
                          placeholder="API Key or Bearer Token"
                          className={inputClass}
                        />
                      </td>
                      <td className="p-2 text-center">
                        <button
                          type="button"
                          onClick={() => removeHeaderRow(idx)}
                          className="text-ink-3 hover:text-danger-600 p-1 text-sm font-bold"
                          title="Remove Header"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              onClick={addHeaderRow}
              className="inline-flex items-center gap-1 rounded border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-surface-muted"
            >
              + Add New
            </button>
          </div>

          {/* Payloads Section */}
          <div className="space-y-2 border-t border-line pt-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-2">Payloads</h4>
                <p className="text-[11px] text-ink-3">Map request JSON keys to PulseOS fields (Patient, Staff, Journey)</p>
              </div>
            </div>

            <div className="overflow-hidden rounded-control border border-line">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-surface-muted text-ink-3">
                  <tr>
                    <th className="py-2 px-3 font-medium uppercase text-[10px] w-1/3">Key</th>
                    <th className="py-2 px-3 font-medium uppercase text-[10px] w-1/3">PulseOS Fields</th>
                    <th className="py-2 px-3 font-medium uppercase text-[10px]">Fallback Value</th>
                    <th className="py-2 px-2 w-10 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {payloads.map((p, idx) => (
                    <tr key={idx} className="hover:bg-surface-muted/50">
                      <td className="p-2">
                        <input
                          value={p.key}
                          onChange={(e) => updatePayloadRow(idx, { key: e.target.value })}
                          placeholder="call_Id, phoneNumber..."
                          className={inputClass}
                        />
                      </td>
                      <td className="p-2">
                        <select
                          value={p.field}
                          onChange={(e) => updatePayloadRow(idx, { field: e.target.value })}
                          className={selectClass}
                        >
                          {PULSEOS_MAPPABLE_FIELDS.map((mf) => (
                            <option key={mf.key} value={mf.key}>
                              {mf.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2">
                        <input
                          value={p.fallbackValue ?? ""}
                          onChange={(e) => updatePayloadRow(idx, { fallbackValue: e.target.value })}
                          placeholder="Optional fallback value"
                          className={inputClass}
                        />
                      </td>
                      <td className="p-2 text-center">
                        <button
                          type="button"
                          onClick={() => removePayloadRow(idx)}
                          className="text-ink-3 hover:text-danger-600 p-1 text-sm font-bold"
                          title="Remove Field"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              onClick={addPayloadRow}
              className="inline-flex items-center gap-1 rounded border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-surface-muted"
            >
              + Add New
            </button>
          </div>

          {/* Trigger Events */}
          <div className="space-y-2 border-t border-line pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-2">Trigger Events</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {WEBHOOK_EVENT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2 rounded border border-line bg-surface p-2 text-xs text-ink hover:bg-surface-muted/50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={events.includes(t)}
                    onChange={(e) =>
                      setEvents((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))
                    }
                    className="rounded border-line-strong text-primary-600 focus:ring-primary-500"
                    data-testid={`webhook-event-${t}`}
                  />
                  <span className="font-mono text-[11px]">{t}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Test Result Banner */}
          {testResult && (
            <div
              className={`rounded-control border p-3 text-xs ${
                testResult.ok ? "border-success-200 bg-success-50 text-success-800" : "border-danger-200 bg-danger-50 text-danger-800"
              }`}
            >
              <div className="flex items-center justify-between font-semibold mb-1">
                <span>
                  {testResult.ok ? "✓ Webhook Test Passed" : "✕ Webhook Test Failed"}: {testResult.status} {testResult.statusText}
                </span>
                <span className="font-mono text-[11px]">{testResult.latencyMs}ms</span>
              </div>
              <p className="font-mono text-[11px] truncate">Endpoint: {testResult.requestUrl}</p>
              {testResult.responseBody && (
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface p-2 text-[11px] text-ink border border-line">
                  {testResult.responseBody}
                </pre>
              )}
              {testResult.error && <p className="mt-1 font-medium text-danger-700">{testResult.error}</p>}
            </div>
          )}

          {error && <p role="alert" className="text-xs text-danger-700" data-testid="webhook-error">{error}</p>}

          {/* Form Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={isTesting || !url.trim()}
              onClick={handleTest}
              data-testid="test-webhook-btn"
            >
              {isTesting ? "Testing endpoint…" : "🧪 Test Webhook"}
            </Button>

            <div className="flex items-center gap-2">
              {editingId && (
                <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={create.isPending || update.isPending || !name.trim() || !url.trim() || events.length === 0}
                data-testid="save-webhook-btn"
              >
                {editingId
                  ? update.isPending
                    ? "Updating…"
                    : "Save Changes"
                  : create.isPending
                  ? "Creating…"
                  : "Create Webhook"}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
