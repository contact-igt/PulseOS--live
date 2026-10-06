"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { Button } from "@pulseos/ui";

// CCS's Webhook Configuration accepts only a URL and a method: no header, and its requests carried no credential. So the one
// secret that survives is a token PulseOS generates and places in the URL path. Unlike the CCS API key it unlocks nothing but this
// one inbox. It is shown ONCE, here, and PulseOS cannot show it again; replacing it makes the old address stop working.

const errorText = (e: unknown): string => {
  const code = (e as ApiError | undefined)?.message;
  if (code === "encryption_not_configured") return "Secure credential storage isn't set up on this server yet, so an address can't be created. Ask your PulseOS administrator to finish the server setup.";
  if (code === "forbidden") return "Only a Super Admin can create this address.";
  return "Could not create the address. Try again, and tell your administrator if it keeps happening.";
};

export function WebhookAddress({ integrationKey, tokenSet, canManage }: { integrationKey: string; tokenSet: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mint = useMutation({
    mutationFn: () => api.mintWebhookToken(integrationKey),
    onSuccess: (r) => {
      setAddress(r.webhookUrl);
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["integration-detail", integrationKey] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
  });

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false); // the address is selectable in the box below; nothing else to do
    }
  }

  return (
    <div className="space-y-2 rounded-card border border-line bg-surface p-3" data-testid="webhook-address">
      <span className="block text-xs font-semibold text-ink">Secure webhook address</span>
      <p className="text-[11px] text-ink-2">
        CCS can only be given a web address; it cannot send a password. This address carries a secret token that PulseOS generates, so only requests that use it are accepted. It is separate from your CCS API keys.
      </p>

      {address ? (
        <div className="space-y-2">
          <code className="block break-all rounded-control bg-neutral-100 px-2 py-1.5 font-mono text-xs font-medium text-ink select-all" data-testid="webhook-address-once">{address}</code>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-0" onClick={copy}>
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied ? "Copied" : "Copy address"}
            </Button>
          </div>
          <p className="rounded-control border border-warning-100 bg-warning-100/50 px-3 py-2 text-xs text-ink" role="status">
            This address is shown only once. Paste it into the Webhook URL field in CCS now. PulseOS cannot show it again; if you lose it, create a new one.
          </p>
        </div>
      ) : tokenSet ? (
        <p className="text-xs text-ink-2">A secure webhook address exists. For safety it is not shown again.</p>
      ) : (
        <p className="text-xs text-ink-2">No secure webhook address yet.</p>
      )}

      {!canManage ? (
        <p className="text-[11px] text-ink-3">Only a Super Admin can create or replace this address.</p>
      ) : confirming ? (
        <div className="space-y-2">
          <p className="text-xs text-ink">The old address stops working immediately. Update it in CCS straight away, or calls will be refused.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={mint.isPending} onClick={() => mint.mutate()}>{mint.isPending ? "Replacing…" : "Yes, replace it"}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        !address && (
          <Button size="sm" variant="primary" disabled={mint.isPending} onClick={() => (tokenSet ? setConfirming(true) : mint.mutate())}>
            {tokenSet ? "Replace address" : mint.isPending ? "Creating…" : "Create secure webhook address"}
          </Button>
        )
      )}
      {mint.isError && <p role="alert" className="text-xs text-danger-700">{errorText(mint.error)}</p>}
    </div>
  );
}
