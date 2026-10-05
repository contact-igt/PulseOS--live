"use client";

import { Badge, relativeTime } from "@pulseos/ui";
import type { IntegrationCard } from "@pulseos/types";
import { BarChart3, Megaphone, MessageCircle, Phone, PhoneCall, Smartphone, Webhook } from "lucide-react";
import { CONFIG_LABEL, CONFIG_TONE, HEALTH_LABEL, HEALTH_TONE, MODE_LABEL, MODE_TONE } from "./hubLabels";

const ICON: Record<IntegrationCard["key"], typeof Phone> = {
  google_ads: BarChart3,
  meta_ads: Megaphone,
  runo: Phone,
  ccs_ivr: PhoneCall,
  whatsapp_meta_cloud: MessageCircle,
  whatsnexus: MessageCircle,
  sms: Smartphone,
  webhooks: Webhook,
};

/**
 * One integration, with its four facts side by side and never merged: Enabled (the hospital's switch), Configuration,
 * Health (only what the provider last confirmed) and Mode (how real the connection is).
 */
export function IntegrationCardView({ card, onOpen }: { card: IntegrationCard; onOpen: () => void }) {
  const Icon = ICON[card.key];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full min-w-0 flex-col gap-3 rounded-card border bg-surface p-4 text-left shadow-panel transition-all hover:bg-primary-50/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 ${
        card.isConnected ? "border-emerald-200 hover:border-emerald-300" : "border-line hover:border-primary-300"
      }`}
      data-testid={`hub-card-${card.key}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-primary-50 text-primary-700">
            <Icon size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{card.name}</h3>
            <p className="truncate text-[11px] text-ink-2">{card.provider}</p>
          </div>
        </div>
        {card.isConnected ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200 shadow-xs">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            Connected
          </span>
        ) : card.mode === "LIVE_CONFIGURED" || card.configuration === "CONFIGURED" ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 border border-amber-200">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Connecting
          </span>
        ) : null}
      </div>

      {card.phoneNumbers && card.phoneNumbers.length > 0 && (
        <div className="flex items-center gap-2 rounded-control bg-emerald-50/70 border border-emerald-200 px-2.5 py-1.5 text-xs text-emerald-900">
          <Phone size={13} className="text-emerald-700 shrink-0" />
          <span className="font-semibold text-ink">{card.phoneNumbers[0].number}</span>
          <span className="text-ink-2 truncate text-[11px]">({card.phoneNumbers[0].label})</span>
          {card.phoneNumbers.length > 1 && (
            <span className="ml-auto text-[10px] font-medium text-emerald-700 bg-emerald-100 rounded px-1.5 py-0.5">
              +{card.phoneNumbers.length - 1} more
            </span>
          )}
        </div>
      )}

      <p className="text-xs text-ink-2">{card.purpose}</p>
      {card.blockedReason && (
        <p className="rounded-control border border-danger-100 bg-danger-100/50 px-2 py-1 text-[11px] text-danger-700" data-testid={`hub-blocked-${card.key}`}>
          {card.blockedReason}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        <div>
          <dt className="text-ink-3">Enabled</dt>
          <dd>{card.capability ? <Badge tone={card.enabled ? "primary" : "neutral"}>{card.enabled ? "On" : "Off"}</Badge> : <span className="text-ink-2">Always available</span>}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Configuration</dt>
          <dd><Badge tone={CONFIG_TONE[card.configuration]}>{CONFIG_LABEL[card.configuration]}</Badge></dd>
        </div>
        <div>
          <dt className="text-ink-3">Health</dt>
          <dd><Badge tone={HEALTH_TONE[card.health]}>{HEALTH_LABEL[card.health]}</Badge></dd>
        </div>
        <div>
          <dt className="text-ink-3">Mode</dt>
          <dd><Badge tone={MODE_TONE[card.mode]}>{MODE_LABEL[card.mode]}</Badge></dd>
        </div>
      </dl>
      {card.lastEventAt && (
        <p className="text-[11px] text-ink-3">
          Last event: <span className="font-medium text-ink-2">{relativeTime(card.lastEventAt)}</span>
        </p>
      )}
    </button>
  );
}
