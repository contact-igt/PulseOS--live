"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { ErrorState, Skeleton, Tabs } from "@pulseos/ui";
import { INTEGRATION_CATEGORY_LABEL, hasPermission, type IntegrationCategory } from "@pulseos/types";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { IntegrationCardView } from "./IntegrationCardView";
import { IntegrationDetailSheet } from "./IntegrationDetailSheet";
import { LogsPanel } from "./LogsPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { ConnectorsWorkbench } from "./ConnectorsWorkbench";

const CATEGORIES: IntegrationCategory[] = ["ADS", "CALLING", "MESSAGING", "ADVANCED"];

export function IntegrationHub() {
  const urlFilters = useUrlFilters();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const hub = useQuery({ queryKey: ["integration-hub"], queryFn: api.integrationHub });
  const [openKeyState, setOpenKey] = useState<string | null>(null);
  const openKey = openKeyState ?? (urlFilters.get("open") || null);
  const openCard = (key: string) => (key === "webhooks" ? urlFilters.set({ section: "advanced" }) : setOpenKey(key));
  const closeSheet = () => {
    setOpenKey(null);
    if (urlFilters.get("open")) urlFilters.set({ open: undefined });
  };

  const requested = urlFilters.get("section");
  const section = requested === "overview" || CATEGORIES.some((c) => c.toLowerCase() === requested) || !requested ? requested || "overview" : "overview";
  const view = urlFilters.get("view");
  const canSecrets = !!session.data && hasPermission(session.data.user.role, "MANAGE_INTEGRATION_SECRETS");

  if (view === "connectors") {
    return (
      <div className="space-y-3" data-testid="integrations-hub">
        <button type="button" onClick={() => urlFilters.set({ view: undefined })} className="text-xs text-primary-700 underline-offset-2 hover:underline" data-testid="back-to-hub">← Back to Integration Hub</button>
        <ConnectorsWorkbench />
      </div>
    );
  }

  const cards = hub.data ?? [];
  const visibleCategory = CATEGORIES.find((c) => c.toLowerCase() === section);
  const shown = visibleCategory ? cards.filter((c) => c.category === visibleCategory) : cards;

  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="integrations-hub">
      <Tabs
        variant="underline"
        ariaLabel="Integration categories"
        value={section}
        onChange={(k) => urlFilters.set({ section: k === "overview" ? undefined : k })}
        items={[{ key: "overview", label: "Overview", testId: "hub-tab-overview" }, ...CATEGORIES.map((c) => ({ key: c.toLowerCase(), label: INTEGRATION_CATEGORY_LABEL[c], testId: `hub-tab-${c.toLowerCase()}` }))]}
      />

      {hub.isLoading && <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>}
      {hub.isError && <ErrorState message="Could not load integrations." />}

      {hub.data && section === "overview" &&
        CATEGORIES.map((c) => (
          <section key={c} aria-labelledby={`hub-cat-${c}`} className="space-y-2">
            <h2 id={`hub-cat-${c}`} className="text-sm font-semibold text-ink">{INTEGRATION_CATEGORY_LABEL[c]}</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {cards.filter((x) => x.category === c).map((card) => <IntegrationCardView key={card.key} card={card} onOpen={() => openCard(card.key)} />)}
            </div>
          </section>
        ))}

      {hub.data && section !== "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.filter((c) => c.key !== "webhooks").map((card) => <IntegrationCardView key={card.key} card={card} onOpen={() => openCard(card.key)} />)}
          </div>
          {visibleCategory === "ADVANCED" && (
            <>
              <section className="space-y-2"><h2 className="text-sm font-semibold text-ink">Outbound webhooks</h2><WebhooksPanel canManage={canSecrets} /></section>
              <section className="space-y-2"><h2 className="text-sm font-semibold text-ink">Activity</h2><LogsPanel /></section>
              <p className="text-xs text-ink-2">
                Phone and WhatsApp lines, disposition mappings and raw connector events: <button type="button" className="text-primary-700 underline-offset-2 hover:underline" onClick={() => urlFilters.set({ view: "connectors" })} data-testid="open-connectors">Open connector details</button>
              </p>
            </>
          )}
        </div>
      )}

      {openKey && <IntegrationDetailSheet key={openKey} integrationKey={openKey} onClose={closeSheet} />}
    </div>
  );
}
