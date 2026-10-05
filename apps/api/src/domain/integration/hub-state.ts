import type { IntegrationConfigurationState, IntegrationHealth, IntegrationMode } from "@pulseos/types";
import type { CatalogueEntry } from "./hub-catalogue.js";

export interface ConnectorFacts {
  status: "NOT_CONFIGURED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "ERROR" | "DISABLED";
  mode: "FIXTURE" | "SANDBOX" | "LIVE";
  configuration: Record<string, unknown> | null;
  secretKeys: string[];
}

export function deriveConfiguration(entry: CatalogueEntry, connector: ConnectorFacts | null): IntegrationConfigurationState {
  if (entry.blockedReason) return "BLOCKED";
  if (entry.requiredConfig.length === 0 && entry.requiredSecrets.length === 0) return entry.connectorProvider ? (connector ? "CONFIGURED" : "NOT_CONFIGURED") : "CONFIGURED";
  if (!connector) return "NOT_CONFIGURED";
  const hasConfig = (k: string) => {
    const v = connector.configuration?.[k];
    return v !== undefined && v !== null && String(v).trim() !== "";
  };
  // Fixture mode never contacts a provider, so it needs no credentials: only the settings count.
  const secrets = connector.mode === "FIXTURE" ? [] : entry.requiredSecrets;
  const have = entry.requiredConfig.filter(hasConfig).length + secrets.filter((k) => connector.secretKeys.includes(k)).length;
  const need = entry.requiredConfig.length + secrets.length;
  if (need === 0) return "CONFIGURED";
  return have === 0 ? "NOT_CONFIGURED" : have === need ? "CONFIGURED" : "PARTIAL";
}

/** Health is only what the provider/connection last told us; unknown stays unknown (never assumed healthy). */
export function deriveHealth(entry: CatalogueEntry, connector: ConnectorFacts | null): IntegrationHealth {
  if (entry.blockedReason || !entry.connectorProvider) return "NOT_APPLICABLE";
  if (!connector) return "UNKNOWN";
  switch (connector.status) {
    case "CONNECTED": return "HEALTHY";
    case "DEGRADED": return "DEGRADED";
    case "ERROR": return "UNHEALTHY";
    default: return "UNKNOWN";
  }
}

/**
 * The honest label for how real the connection is.
 *  BLOCKED          nothing can be set up yet (documentation / provider missing)
 *  DISABLED         the hospital's switch is off (configuration and health are still reported separately)
 *  NOT_CONFIGURED   switched on but credentials/settings are not all there
 *  FIXTURE/SANDBOX  configured against sample data / the provider's test environment
 *  LIVE_CONFIGURED  live mode, fully configured and last reported connected
 *  LIVE_CAPABLE     live mode selected and configured, but not (yet) confirmed connected
 */
export function deriveMode(entry: CatalogueEntry, enabled: boolean, configuration: IntegrationConfigurationState, connector: ConnectorFacts | null): IntegrationMode {
  if (entry.blockedReason) return "BLOCKED";
  if (!enabled) return "DISABLED";
  if (!connector || configuration === "NOT_CONFIGURED" || configuration === "PARTIAL") {
    // Fixture mode needs no credentials by design: a fixture connector is honest about being sample data.
    if (connector?.mode === "FIXTURE") return "FIXTURE";
    return "NOT_CONFIGURED";
  }
  if (connector.mode === "FIXTURE") return "FIXTURE";
  if (connector.mode === "SANDBOX") return "SANDBOX";
  return connector.status === "CONNECTED" ? "LIVE_CONFIGURED" : "LIVE_CAPABLE";
}
