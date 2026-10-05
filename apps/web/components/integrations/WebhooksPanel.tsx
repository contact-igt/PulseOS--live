"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, EmptyState, ErrorState, Skeleton, relativeTime } from "@pulseos/ui";
import { WEBHOOK_EVENT_TYPES, type WebhookCondition, type WebhookEventType } from "@pulseos/types";

const field = "h-11 w-full rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-9";
const ERRORS: Record<string, string> = {
  https_required: "The address must start with https://.",
  private_address: "The address must be a public host, not localhost or a private network.",
  invalid_url: "That is not a valid address.",
  credentials_in_url: "Remove the username/password from the address.",
  invalid_request: "Check the name, address and events.",
};

/** Super Admin only. Real events, simple conditions, signed deliveries — no scripting. */
export function WebhooksPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks, enabled: canManage });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [cond, setCond] = useState<{ field: string; op: WebhookCondition["op"]; value: string }>({ field: "", op: "eq", value: "" });
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  const create = useMutation({
    mutationFn: () => {
      const conditions: WebhookCondition[] = cond.field && cond.value ? [{ field: cond.field.trim(), op: cond.op, value: cond.op === "in" ? cond.value.split(",").map((v) => v.trim()).filter(Boolean) : cond.value.trim() }] : [];
      return api.createWebhook({ name, url, events, conditions });
    },
    onSuccess: (r) => {
      setSecret(r.signingSecret);
      setName(""); setUrl(""); setEvents([]); setCond({ field: "", op: "eq", value: "" }); setError(null);
      refresh();
    },
    onError: (e) => setError(ERRORS[(e as ApiError).message] ?? "Could not create the webhook."),
  });
  const [rowError, setRowError] = useState<string | null>(null);
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => api.updateWebhook(v.id, { enabled: v.enabled }), onSuccess: () => { setRowError(null); refresh(); }, onError: () => setRowError("Could not change that webhook — nothing was changed. Try again.") });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteWebhook(id), onSuccess: () => { setConfirmDelete(null); setRowError(null); refresh(); }, onError: () => { setConfirmDelete(null); setRowError("Could not delete that webhook — it is still there. Try again."); } });

  if (!canManage) return <p className="text-sm text-ink-2" data-testid="webhooks-restricted">Outbound webhooks can only be managed by a Super Admin.</p>;

  return (
    <div className="space-y-4" data-testid="webhooks-panel">
      {secret && (
        <div className="rounded-control border border-primary-200 bg-primary-50 px-3 py-2 text-xs" role="status" data-testid="webhook-secret-once">
          <p className="font-medium text-ink">Signing secret — copy it now, it is not shown again.</p>
          <code className="mt-1 block break-all">{secret}</code>
          <button type="button" className="mt-1 text-primary-700 underline-offset-2 hover:underline" onClick={() => setSecret(null)}>Done</button>
        </div>
      )}
      {rowError && <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/60 px-3 py-2 text-xs text-danger-700" data-testid="webhook-row-error">{rowError}</p>}
      {list.isLoading && <Skeleton className="h-16" />}
      {list.isError && <ErrorState message="Could not load webhooks." />}
      {list.data && list.data.length === 0 && <EmptyState message="No outbound webhooks yet." />}
      {list.data?.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-xs" data-testid={`webhook-${w.id}`}>
          <div className="min-w-0 flex-1 basis-56">
            <p className="font-medium text-ink">{w.name} <Badge tone={w.enabled ? "primary" : "neutral"}>{w.enabled ? "On" : "Off"}</Badge></p>
            <p className="truncate text-ink-2">{w.url}</p>
            <p className="text-ink-3">{w.events.join(", ")}</p>
            <p className="text-ink-3">Last delivery: {w.lastDeliveryAt ? `${w.lastDeliveryStatus?.toLowerCase()} · ${relativeTime(w.lastDeliveryAt)}` : "none yet"}</p>
          </div>
          <Button size="sm" variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: w.id, enabled: !w.enabled })}>{w.enabled ? "Turn off" : "Turn on"}</Button>
          {confirmDelete === w.id ? (
            <>
              <Button size="sm" variant="primary" disabled={remove.isPending} onClick={() => remove.mutate(w.id)} data-testid="confirm-delete-webhook">Confirm delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(w.id)}>Delete</Button>
          )}
        </div>
      ))}

      <form
        className="space-y-3 rounded-card border border-line bg-surface p-4"
        onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(); }}
      >
        <h4 className="text-sm font-semibold text-ink">New webhook</h4>
        <label className="block text-xs text-ink-2">Name<input value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${field}`} data-testid="webhook-name" /></label>
        <label className="block text-xs text-ink-2">Address (https)<input value={url} onChange={(e) => setUrl(e.target.value)} className={`mt-1 ${field}`} placeholder="https://" data-testid="webhook-url" /></label>
        <fieldset className="text-xs text-ink-2">
          <legend className="mb-1">Events</legend>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {WEBHOOK_EVENT_TYPES.map((t) => (
              <label key={t} className="flex min-h-11 items-center gap-2 sm:min-h-0">
                <input type="checkbox" checked={events.includes(t)} onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))} data-testid={`webhook-event-${t}`} />
                {t}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-xs text-ink-2">Only when field<input value={cond.field} onChange={(e) => setCond({ ...cond, field: e.target.value })} className={`mt-1 ${field}`} placeholder="e.g. sourceKey" /></label>
          <label className="text-xs text-ink-2">is<select value={cond.op} onChange={(e) => setCond({ ...cond, op: e.target.value as WebhookCondition["op"] })} className={`mt-1 ${field}`}><option value="eq">equal to</option><option value="neq">not equal to</option><option value="in">one of (comma separated)</option></select></label>
          <label className="text-xs text-ink-2">Value<input value={cond.value} onChange={(e) => setCond({ ...cond, value: e.target.value })} className={`mt-1 ${field}`} /></label>
        </div>
        {error && <p role="alert" className="text-xs text-danger-700" data-testid="webhook-error">{error}</p>}
        <Button type="submit" size="sm" variant="primary" disabled={create.isPending || !name.trim() || !url.trim() || events.length === 0} data-testid="create-webhook">Create webhook</Button>
      </form>
    </div>
  );
}
