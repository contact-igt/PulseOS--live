import type { TenantHubCard } from "../integration/hub.service.js";

/**
 * Why a hospital's integration needs a person's attention, or null. Only CONFIGURED-but-broken signals count: a switched-off
 * or never-configured integration is a fact, not a problem. Enabled, configured, credentials, activity and health stay
 * separate dimensions everywhere else - this is only the "look at this" flag.
 */
export function integrationAttention(card: Pick<TenantHubCard, "enabled" | "blockedReason" | "credentialState" | "health" | "configuration" | "lastError" | "mode">): string | null {
  if (!card.enabled || card.blockedReason) return null;
  if (card.credentialState === "UNREADABLE") return "Credentials are saved but cannot be read";
  if (card.health === "UNHEALTHY") return "The provider reported an error";
  if (card.health === "DEGRADED") return "The connection is degraded";
  if (card.configuration === "PARTIAL") return "Only partly configured";
  if (card.lastError && card.configuration === "CONFIGURED" && card.mode !== "FIXTURE") return "The last event failed";
  return null;
}

export type IntegrationBucket = "healthy" | "attention" | "not_configured" | "other";

export function integrationBucket(card: Parameters<typeof integrationAttention>[0]): IntegrationBucket {
  if (integrationAttention(card)) return "attention";
  if (card.configuration === "NOT_CONFIGURED" || card.mode === "NOT_CONFIGURED") return "not_configured";
  if (card.health === "HEALTHY") return "healthy";
  return "other";
}

/** A real, configured connection (not sample data, not switched off). */
export function isConfiguredIntegration(card: Pick<TenantHubCard, "enabled" | "configuration" | "mode">): boolean {
  return card.enabled && card.configuration === "CONFIGURED" && (card.mode === "LIVE_CONFIGURED" || card.mode === "LIVE_CAPABLE" || card.mode === "SANDBOX");
}
