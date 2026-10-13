"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, ErrorState, SideSheet, Skeleton } from "@pulseos/ui";
import type { WhatsAppDelivery } from "@pulseos/types";
import { describeWhatsAppFailure } from "./whatsappFailure";

const BLOCKED: Record<string, string> = {
  NO_VALID_PHONE: "This patient has no valid WhatsApp number on file.",
  PROVIDER_NOT_CONFIGURED: "WhatsApp is not connected yet. Ask your Super Admin to finish setting it up in the Integration Hub.",
  TEMPLATE_UNAVAILABLE: "The follow-up message template is switched off.",
  MISSING_VARIABLES: "The message has details that are not filled in.",
};

const PROVIDER_LABEL: Record<string, string> = { whatsnexus: "WhatsNexus", meta: "WhatsApp Business (Meta)" };
const CATEGORY_LABEL: Record<string, string> = { utility: "Utility", marketing: "Marketing", authentication: "Authentication" };

/** What WhatsApp will really send: the provider's approved template, and what fills each placeholder for this patient. */
function DeliveryCard({ d }: { d: WhatsAppDelivery }) {
  return (
    <div className="space-y-2 rounded-card border border-line bg-surface p-3 text-xs" data-testid="whatsapp-delivery">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Sent as</span>
        <Badge tone={d.provider ? "primary" : "neutral"}>{d.provider ? PROVIDER_LABEL[d.provider] : "No WhatsApp provider connected"}</Badge>
      </div>
      <div>
        <p className="break-all text-sm font-medium text-ink" data-testid="whatsapp-template-name">{d.templateName}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          <span className="rounded-chip bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-2 ring-1 ring-inset ring-line">{d.language}</span>
          {d.category && <span className="rounded-chip bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-2 ring-1 ring-inset ring-line">{CATEGORY_LABEL[d.category]}</span>}
          <span className="rounded-chip bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-2 ring-1 ring-inset ring-line">{d.parameters.length} variable{d.parameters.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      {d.parameters.length > 0 && (
        <ol className="space-y-1" data-testid="whatsapp-parameters">
          {d.parameters.map((p) => (
            <li key={p.position} className="flex items-baseline gap-2">
              <code className="rounded bg-surface-muted px-1 font-mono text-[11px] text-ink-2">{`{{${p.position}}}`}</code>
              <span className="text-ink-3">{p.variable}</span>
              <span className="ml-auto text-right font-medium text-ink">{p.value || "—"}</span>
            </li>
          ))}
        </ol>
      )}
      {d.provider === "whatsnexus" && <p className="text-ink-3">WhatsApp delivers this approved template&apos;s own wording with the details above filled in. The text above is your Settings wording, shown as a guide.</p>}
    </div>
  );
}

/**
 * Staff choose to send a WhatsApp follow-up. They see exactly what the patient will receive first. Sending records the
 * message on the Journey timeline and never completes the follow-up — that stays a separate, deliberate action.
 */
export function SendWhatsAppSheet({ journeyId, onClose }: { journeyId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: ["whatsapp-preview", journeyId], queryFn: () => api.whatsappPreview(journeyId), retry: false });
  // One key per sheet: a double-click or a retry after a timeout can never send the message twice.
  const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const [key, setKey] = useState(newKey);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<{ summary: string; detail: string | null } | null>(null);

  async function send() {
    setState("sending");
    setError(null);
    try {
      const r = await api.sendWhatsApp(journeyId, key);
      setState(r.status === "SENT" || r.status === "DELIVERED" || r.status === "READ" ? "sent" : "idle");
      if (r.status === "FAILED" || r.status === "BLOCKED") {
        // The reason WhatsNexus gave (a paused template, a changed placeholder count …) is shown, not just "could not be sent".
        setError(describeWhatsAppFailure(r.reason));
        setKey(newKey()); // a deliberate retry after a definite failure is a new message, not a duplicate of the failed one
      }
      queryClient.invalidateQueries({ queryKey: ["journey", journeyId] });
      queryClient.invalidateQueries({ queryKey: ["timeline"] });
    } catch (e) {
      setState("idle");
      setError({ summary: e instanceof ApiError && BLOCKED[e.message] ? BLOCKED[e.message]! : "Couldn't send the message — try again.", detail: null });
    }
  }

  const p = preview.data;
  return (
    <SideSheet
      title="Send WhatsApp"
      subtitle="Review the message before it goes"
      onClose={onClose}
      testId="send-whatsapp-sheet"
      footer={
        state === "sent" ? (
          <Button variant="secondary" size="sm" onClick={onClose} data-testid="whatsapp-done">Done</Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={send} disabled={!p?.canSend || state === "sending"} data-testid="whatsapp-send">
              {state === "sending" ? "Sending…" : "Send message"}
            </Button>
          </>
        )
      }
    >
      {preview.isLoading && <Skeleton className="h-32" />}
      {preview.isError && <ErrorState message="Could not prepare the message." />}
      {p && (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-ink-2">To <span className="font-medium text-ink" data-testid="whatsapp-recipient">{p.recipient}</span> · {p.templateName}</p>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Message preview</p>
          <p className="whitespace-pre-wrap rounded-card border border-line bg-surface-info p-3 text-sm text-ink" data-testid="whatsapp-preview-text">{p.text}</p>
          {p.delivery && <DeliveryCard d={p.delivery} />}
          {p.blockedReason && <p role="alert" className="rounded-control border border-warning-100 bg-warning-100/60 px-3 py-2 text-xs text-warning-700" data-testid="whatsapp-blocked">{BLOCKED[p.blockedReason] ?? describeWhatsAppFailure(`${p.blockedReason}:`).summary.replace("The message could not be sent.", "This message cannot be sent right now.")}</p>}
          {state === "sent" && <p role="status" className="rounded-control border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-ink" data-testid="whatsapp-sent">Sent. It is on the Journey timeline. The follow-up is still open.</p>}
          {error && (
            <div role="alert" className="space-y-1 text-xs text-danger-700" data-testid="whatsapp-error">
              <p>{error.summary}</p>
              {error.detail && <p className="text-ink-2" data-testid="whatsapp-error-detail">Reason: {error.detail}</p>}
              <p className="text-ink-2">It has been recorded on the Journey; you can try again once it is fixed.</p>
            </div>
          )}
        </div>
      )}
    </SideSheet>
  );
}
