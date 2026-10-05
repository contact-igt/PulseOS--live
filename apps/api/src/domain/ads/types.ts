import type { AdsProvider } from "@pulseos/types";

/** One day of one campaign, in the shape every provider is normalized to. Money is in the account's own currency (major units). */
export interface NormalizedAdFact {
  accountId: string;
  entityType: "CAMPAIGN";
  entityId: string;
  entityName: string;
  /** Provider-local calendar day, YYYY-MM-DD. */
  date: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** The provider's own "conversions" (Google). Not a lead, not a PulseOS outcome. */
  providerConversions: number | null;
  /** Meta: every action type with its count, kept raw so the lead mapping can be changed without a re-sync. */
  actions: Record<string, number> | null;
}

export class TransientAdsError extends Error {}

/**
 * One fetch for every ads call: a hard timeout, and network failures (reset, DNS, timeout) classified as transient so the
 * bounded retry applies. Read-only providers only: callers pass GET or a read-only POST (OAuth, GAQL SELECT).
 */
export async function adsFetch(url: string, init: RequestInit & { method: "GET" | "POST" }): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new TransientAdsError(`Ads request failed: ${err instanceof Error ? err.name : "network error"}`);
  }
}

/**
 * Read-only reporting. An adapter can fetch numbers and nothing else: no method creates, edits, pauses or deletes anything at
 * the provider, and no such method may ever be added to this interface.
 */
export interface AdsReportingProvider {
  provider: AdsProvider;
  fetchDailyFacts(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    range: { from: string; to: string },
  ): Promise<NormalizedAdFact[]>;
}
