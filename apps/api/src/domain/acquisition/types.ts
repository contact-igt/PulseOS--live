import type { ConnectorCapability } from "@pulseos/types";
import type { SourceChannelDb } from "../../db/schema.js";

// A normalized, provider-neutral lead — the shared shape every acquisition
// adapter (website form, Meta Lead Ads, Google Ads Lead Forms) parses its
// own webhook/payload format into. Domain code (attribution.service.ts)
// never reads a provider's raw payload directly, only this shape.
// Structurally compatible with TouchpointDetails (touchpoint.ts) — a
// NormalizedLead can be passed anywhere a TouchpointDetails is expected.
export interface NormalizedLead {
  externalLeadId: string;
  externalFormId: string | null;
  externalAccountId: string | null;
  externalCampaignId: string | null;
  externalAdGroupId: string | null;
  externalAdId: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: SourceChannelDb;
  medium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

export interface CampaignSyncRecord {
  externalCampaignId: string;
  externalAccountId: string | null;
  name: string;
  // Each adapter always knows its own channel (Meta always "meta", Google
  // always "google") — carried here rather than guessed from the provider
  // string by the generic sync service that persists these records, which
  // would mean matching a provider name outside the registry.
  source: SourceChannelDb;
  spendAmount: number;
  currency: string;
  startDate: Date;
  endDate: Date | null;
  status: "active" | "paused" | "ended";
}

// Aggregate, listing-level performance (Google Business Profile) — never
// contains anything a Patient could be created from.
export interface PerformanceSyncRecord {
  externalCampaignId: string | null;
  metricDate: Date;
  impressions: number | null;
  clicks: number | null;
  searchImpressions: number | null;
  websiteClicks: number | null;
  callClicks: number | null;
  directionRequests: number | null;
  raw: Record<string, unknown>;
}

export type ConversionFeedbackEventType =
  | "QUALIFIED_ENQUIRY"
  | "APPOINTMENT_BOOKED"
  | "APPOINTMENT_ATTENDED"
  | "CONSULTATION_COMPLETED"
  | "TREATMENT_ADVISED"
  | "TREATMENT_COMPLETED"
  | "REVENUE_RECORDED";

export interface ConversionFeedbackPayload {
  eventType: ConversionFeedbackEventType;
  externalCampaignId: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  occurredAt: Date;
  value: number | null;
  currency: string | null;
  idempotencyKey: string;
}

// What a lead webhook notification itself carries — provider ids only.
// Neither Meta nor Google put the submitted name/phone/email in the
// notification; that requires a separate authenticated fetch (see
// AcquisitionProviderAdapter.fetchLead below), which is why this is a
// distinct, smaller shape from NormalizedLead rather than the same one.
export interface LeadReference {
  externalLeadId: string;
  externalFormId: string | null;
  externalAdGroupId: string | null;
  externalAdId: string | null;
  occurredAt: Date;
}

// A provider's declared `capabilities` (persisted on its connector row) is
// what actually gates which of these optional methods callers may invoke —
// the registry (registry.ts) is the only place a provider string is ever
// matched to pick an adapter; every other domain call goes through this
// interface, never through a provider name.
export interface AcquisitionProviderAdapter {
  capabilities: ConnectorCapability[];
  verifyWebhookChallenge?(query: Record<string, string>, secrets: Record<string, unknown>): string | null;
  verifyWebhookSignature?(rawBody: string, signatureHeader: string | undefined, secrets: Record<string, unknown>): boolean;
  // A second, distinct webhook-auth shape: some providers (Google Lead
  // Forms) send a plaintext shared-secret field inside the JSON body itself
  // rather than an HMAC header — verified with a timing-safe comparison,
  // never `===`, matching Runo's x-api-key precedent.
  verifyWebhookKey?(payload: unknown, secrets: Record<string, unknown>): boolean;
  // Two-step providers (Meta: the notification carries only ids): parse ids,
  // then separately fetch the full submission.
  parseWebhookLeadReferences?(payload: unknown): LeadReference[];
  fetchLead?(ref: LeadReference, config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<NormalizedLead>;
  // One-step providers (Google: the webhook itself carries the full
  // submission) — no separate fetch call exists or is needed.
  parseWebhookLead?(payload: unknown): NormalizedLead[];
  syncCampaigns?(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<CampaignSyncRecord[]>;
  syncPerformance?(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<PerformanceSyncRecord[]>;
  // Turns PulseOS's own neutral ConversionFeedbackPayload into the
  // provider's actual wire request body (e.g. a Google Data Manager API
  // Event, a Meta Conversions API event) — pure and synchronous, so it can
  // be fully unit-tested without ever making a network call. Nothing in
  // this checkpoint calls the corresponding provider endpoint with this
  // body; sending real events is explicitly out of scope until real
  // credentials and consent-eligible traffic both exist.
  buildConversionPayload?(payload: ConversionFeedbackPayload, config: Record<string, unknown>): Record<string, unknown>;
}
