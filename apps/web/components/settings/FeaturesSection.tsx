"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CapabilityState } from "@pulseos/api-client";
import { Badge, ErrorState, Skeleton } from "@pulseos/ui";

const REASON_TEXT: Record<string, string> = {
  requires: "Turn on what it depends on first.",
  required_by: "Another feature that is on needs this one — turn that off first.",
  locked: "This feature is always on.",
  forbidden: "Only a Super Admin can change this feature.",
};

/**
 * Settings → Features. Three independent facts per feature: Enabled (the switch, a commercial/operational
 * choice), Configuration and Health (what makes it work — set up in the Integration Hub). Enabled never implies the others.
 */
export function FeaturesSection() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });
  const [error, setError] = useState<string | null>(null);
  // What the person just chose, shown until the server answers (React state flushes inside the click; query-cache updates do not).
  const [chosen, setChosen] = useState<Record<string, boolean>>({});

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => api.setCapability(key, enabled),
    // The switch moves at once; a refusal (dependency, permission) puts it back and says why.
    onSettled: async (_d, _e, v) => {
      await queryClient.invalidateQueries({ queryKey: ["capabilities"] });
      setChosen((cur) => {
        const { [v.key]: _gone, ...rest } = cur;
        return rest;
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["capabilities"] });
      queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (e: Error) => setError(REASON_TEXT[e.message] ?? "Could not change that feature."),
  });

  // Applied synchronously in the change handler (a controlled switch would otherwise snap back for a frame).
  function flip(key: string, enabled: boolean) {
    setChosen((cur) => ({ ...cur, [key]: enabled }));
    toggle.mutate({ key, enabled });
  }

  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.isError || !q.data) return <ErrorState message="Could not load features." />;

  const label = (key: string) => q.data.capabilities.find((c) => c.key === key)?.label ?? key;

  return (
    <div className="space-y-3" data-testid="features-section">
      <p className="text-xs text-ink-2">
        {q.data.edition === "BETA_V2_GROWTH" ? "Beta V2 Growth" : "Beta V1 Core"} sets the starting features. Each can be switched here for this hospital.
      </p>
      {error && (
        <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/60 px-2.5 py-1.5 text-xs text-danger-700" data-testid="features-error">
          {error}
        </p>
      )}
      <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
        {q.data.capabilities.map((c: CapabilityState) => (
          <li key={c.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3" data-testid={`feature-${c.key}`}>
            <div className="min-w-0 flex-1 basis-56">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{c.label}</span>
                {c.overridden && <Badge tone="primary">Changed for this hospital</Badge>}
              </div>
              <p className="text-xs text-ink-2">{c.description}</p>
              {c.dependsOn.length > 0 && <p className="text-[11px] text-ink-3">Needs {c.dependsOn.map(label).join(", ")}</p>}
            </div>
            <div className="flex items-center gap-3 text-xs">
              {c.provider && (
                <Link href={`/integrations?open=${c.provider}`} className="inline-flex items-center text-primary-700 underline-offset-2 hover:underline max-sm:min-h-11" data-testid={`feature-setup-${c.key}`}>
                  Set up in Integration Hub
                </Link>
              )}
              <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
                <span className="text-ink-2">{(chosen[c.key] ?? c.enabled) ? "On" : "Off"}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={chosen[c.key] ?? c.enabled}
                  disabled={!c.editable}
                  aria-label={`${c.label} enabled`}
                  onChange={(e) => flip(c.key, e.target.checked)}
                  className="h-5 w-9 cursor-pointer accent-primary-600 disabled:cursor-not-allowed max-sm:h-11 max-sm:w-11"
                  data-testid={`feature-toggle-${c.key}`}
                />
              </label>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
