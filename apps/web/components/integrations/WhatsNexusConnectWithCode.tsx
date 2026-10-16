"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button } from "@pulseos/ui";
import type { IntegrationDetail } from "@pulseos/types";
import { looksLikePairingCode, normalizePairingCode, pairingProblem } from "./whatsnexusPairing";

const field = "h-11 w-full rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-9";

/**
 * "Connect with code": a WhatsNexus super admin makes a one-time code; pasting it here lets the two servers exchange the API key
 * and callback secret directly, so nobody reads a secret off a screen or types one. The code is cleared as soon as it is used.
 */
export function WhatsNexusConnectWithCode({ d }: { d: IntegrationDetail }) {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(d.configurationValues?.baseUrl ?? "");
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const clean = normalizePairingCode(code);
  const shapeOk = looksLikePairingCode(clean);

  const pair = useMutation({
    mutationFn: () => api.pairIntegration(d.key, { baseUrl: baseUrl.trim(), code: clean }),
    onSuccess: () => {
      setCode(""); // a spent code has no further use and should not linger on screen
      setOutcome({ ok: true, text: "Connected. The credentials were saved. Next, in WhatsNexus send the test callback and enable the integration, then press Check Status here." });
      queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
      queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
    },
    onError: (e: unknown) => setOutcome({ ok: false, text: pairingProblem(e instanceof ApiError ? (e.status === 403 ? "forbidden" : e.message) : undefined) }),
  });

  if (!d.canManageSecrets) return null;
  return (
    <form
      className="mb-5 space-y-3 rounded-card border border-primary-200 bg-primary-50/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setOutcome(null);
        pair.mutate();
      }}
      data-testid="connect-with-code"
    >
      <div>
        <p className="text-sm font-semibold text-ink">Connect with code</p>
        <p className="text-xs text-ink-2">Ask a WhatsNexus super admin for a pairing code for this hospital, then paste it here. It works once and lasts 15 minutes. The API key and callback secret are exchanged directly between the two servers.</p>
      </div>
      <label className="block text-xs text-ink-2">
        WhatsNexus API base URL
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.whatsnexus.example" autoComplete="off" spellCheck={false} className={`mt-1 ${field}`} data-testid="pair-base-url" />
      </label>
      <label className="block text-xs text-ink-2">
        Pairing code
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="wnpair_…" autoComplete="off" spellCheck={false} className={`mt-1 ${field} font-mono`} data-testid="pair-code" />
        {clean && !shapeOk && <span role="alert" className="mt-0.5 block text-[11px] text-danger-700" data-testid="pair-shape-warning">This does not look like a pairing code. A pairing code starts with wnpair_ (an API key starts with wnpk_).</span>}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="primary" disabled={pair.isPending || !baseUrl.trim() || !shapeOk} data-testid="pair-submit">
          {pair.isPending ? "Connecting…" : "Connect"}
        </Button>
        {outcome && <span role={outcome.ok ? "status" : "alert"} className={`text-xs ${outcome.ok ? "text-ink-2" : "text-danger-700"}`} data-testid="pair-outcome">{outcome.text}</span>}
      </div>
    </form>
  );
}
