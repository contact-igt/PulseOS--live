"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { ErrorState, Skeleton, Tabs } from "@pulseos/ui";
import { INTEGRATION_CATEGORY_LABEL, hasPermission, type IntegrationCategory } from "@pulseos/types";
import { Radio } from "lucide-react";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { IntegrationCardView } from "./IntegrationCardView";
import { IntegrationDetailSheet } from "./IntegrationDetailSheet";
import { LogsPanel } from "./LogsPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { ConnectorsWorkbench } from "./ConnectorsWorkbench";

const CATEGORIES: IntegrationCategory[] = ["ADS", "CALLING", "MESSAGING", "ADVANCED"];
const VALID_SECTIONS = ["overview", "connected", "calling", "messaging", "ads", "activity", "advanced"];

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
  const section = requested && VALID_SECTIONS.includes(requested.toLowerCase()) ? requested.toLowerCase() : "overview";
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
  const connectedCards = cards.filter((c) => c.isConnected);
  const connectedCount = connectedCards.length;

  const visibleCategory = CATEGORIES.find((c) => c.toLowerCase() === section);
  const shown = visibleCategory ? cards.filter((c) => c.category === visibleCategory) : cards;

  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="integrations-hub">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-1">
        <Tabs
          variant="underline"
          ariaLabel="Integration categories"
          value={section}
          onChange={(k) => urlFilters.set({ section: k === "overview" ? undefined : k })}
          items={[
            { key: "overview", label: "Overview", testId: "hub-tab-overview" },
            {
              key: "connected",
              label: `Connected${connectedCount > 0 ? ` (${connectedCount})` : ""}`,
              testId: "hub-tab-connected",
            },
            { key: "calling", label: INTEGRATION_CATEGORY_LABEL["CALLING"], testId: "hub-tab-calling" },
            { key: "messaging", label: INTEGRATION_CATEGORY_LABEL["MESSAGING"], testId: "hub-tab-messaging" },
            { key: "ads", label: INTEGRATION_CATEGORY_LABEL["ADS"], testId: "hub-tab-ads" },
            { key: "activity", label: "Activity Logs", testId: "hub-tab-activity" },
            { key: "advanced", label: INTEGRATION_CATEGORY_LABEL["ADVANCED"], testId: "hub-tab-advanced" },
          ]}
        />
        <Link
          href="/connectors"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-xs hover:bg-surface-hover hover:border-line-strong transition-colors"
          data-testid="hub-to-connectors-link"
        >
          <Radio size={14} className="text-primary-600" />
          Connectors & Phone Lines →
        </Link>
      </div>

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

      {hub.data && section === "connected" && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Active Connected Services ({connectedCards.length})</h2>
            <p className="text-xs text-ink-2">Live integrations with verified phone lines and webhook event flow</p>
          </div>
          {connectedCards.length === 0 ? (
            <div className="rounded-card border border-dashed border-line p-8 text-center">
              <p className="text-sm font-medium text-ink">No integrations currently connected.</p>
              <p className="mt-1 text-xs text-ink-2">Configure credentials or send a webhook event to activate an integration.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {connectedCards.map((card) => (
                <IntegrationCardView key={card.key} card={card} onOpen={() => openCard(card.key)} />
              ))}
            </div>
          )}
        </section>
      )}

      {hub.data && section === "activity" && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Integration & Telephony Activity Logs</h2>
            <p className="text-xs text-ink-2">Incoming webhooks, call dispatches, lead ingestions, and provider status events</p>
          </div>
          <LogsPanel />
        </section>
      )}

      {hub.data && section !== "overview" && section !== "connected" && section !== "activity" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.filter((c) => c.key !== "webhooks").map((card) => <IntegrationCardView key={card.key} card={card} onOpen={() => openCard(card.key)} />)}
          </div>
          {visibleCategory === "ADVANCED" && (
            <div className="space-y-5">
              <section className="space-y-2"><h2 className="text-sm font-semibold text-ink">Outbound webhooks</h2><WebhooksPanel canManage={canSecrets} /></section>
              <div className="rounded-card border border-line bg-surface-muted p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-ink">Phone Lines, Hardware Connectors & Raw Dispatch Events</p>
                  <p className="text-xs text-ink-2">Manage telephone DID numbers, WhatsApp phone numbers, and provider dispatch history.</p>
                </div>
                <Link
                  href="/connectors"
                  className="inline-flex items-center gap-1.5 rounded-control bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 transition-colors shadow-xs"
                  data-testid="open-connectors-page-link"
                >
                  Open Connectors & Lines →
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {openKey && <IntegrationDetailSheet key={openKey} integrationKey={openKey} onClose={closeSheet} />}
    </div>
  );
}
