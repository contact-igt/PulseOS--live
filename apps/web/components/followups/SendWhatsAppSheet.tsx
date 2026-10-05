"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button, ErrorState, SideSheet, Skeleton } from "@pulseos/ui";

const BLOCKED: Record<string, string> = {
  NO_VALID_PHONE: "This patient has no valid WhatsApp number on file.",
  PROVIDER_NOT_CONFIGURED: "WhatsApp is not connected yet. Ask your Super Admin to finish setting it up in the Integration Hub.",
  TEMPLATE_UNAVAILABLE: "The follow-up message template is switched off.",
  MISSING_VARIABLES: "The message has details that are not filled in.",
};

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
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setState("sending");
    setError(null);
    try {
      const r = await api.sendWhatsApp(journeyId, key);
      setState(r.status === "SENT" || r.status === "DELIVERED" || r.status === "READ" ? "sent" : "idle");
      if (r.status === "FAILED" || r.status === "BLOCKED") {
        setError("The message could not be sent. It has been recorded; you can try again.");
        setKey(newKey()); // a deliberate retry after a definite failure is a new message, not a duplicate of the failed one
      }
      queryClient.invalidateQueries({ queryKey: ["journey", journeyId] });
      queryClient.invalidateQueries({ queryKey: ["timeline"] });
    } catch (e) {
      setState("idle");
      setError(e instanceof ApiError && BLOCKED[e.message] ? BLOCKED[e.message]! : "Couldn't send the message — try again.");
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
          <p className="whitespace-pre-wrap rounded-card border border-line bg-surface-info p-3 text-sm text-ink" data-testid="whatsapp-preview-text">{p.text}</p>
          {p.blockedReason && <p role="alert" className="rounded-control border border-warning-100 bg-warning-100/60 px-3 py-2 text-xs text-warning-700" data-testid="whatsapp-blocked">{BLOCKED[p.blockedReason] ?? "This message cannot be sent right now."}</p>}
          {state === "sent" && <p role="status" className="rounded-control border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-ink" data-testid="whatsapp-sent">Sent. It is on the Journey timeline. The follow-up is still open.</p>}
          {error && <p role="alert" className="text-xs text-danger-700" data-testid="whatsapp-error">{error}</p>}
        </div>
      )}
    </SideSheet>
  );
}
