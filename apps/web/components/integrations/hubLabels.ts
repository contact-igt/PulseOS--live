import type { IntegrationConfigurationState, IntegrationHealth, IntegrationMode } from "@pulseos/types";

type Tone = "neutral" | "warning" | "danger" | "primary" | "success";

export const MODE_LABEL: Record<IntegrationMode, string> = {
  LIVE_CONFIGURED: "Live · configured",
  LIVE_CAPABLE: "Live-capable",
  SANDBOX: "Sandbox",
  FIXTURE: "Fixture (sample data)",
  BLOCKED: "Blocked",
  NOT_CONFIGURED: "Not configured",
  DISABLED: "Disabled",
};
export const MODE_TONE: Record<IntegrationMode, Tone> = {
  LIVE_CONFIGURED: "success",
  LIVE_CAPABLE: "primary",
  SANDBOX: "warning",
  FIXTURE: "neutral",
  BLOCKED: "danger",
  NOT_CONFIGURED: "neutral",
  DISABLED: "neutral",
};
export const CONFIG_LABEL: Record<IntegrationConfigurationState, string> = {
  CONFIGURED: "Configured",
  PARTIAL: "Partly configured",
  NOT_CONFIGURED: "Not configured",
  BLOCKED: "Blocked",
};
export const CONFIG_TONE: Record<IntegrationConfigurationState, Tone> = { CONFIGURED: "success", PARTIAL: "warning", NOT_CONFIGURED: "neutral", BLOCKED: "danger" };
export const HEALTH_LABEL: Record<IntegrationHealth, string> = { HEALTHY: "Healthy", DEGRADED: "Degraded", UNHEALTHY: "Unhealthy", UNKNOWN: "Not verified", NOT_APPLICABLE: "Not applicable" };
export const HEALTH_TONE: Record<IntegrationHealth, Tone> = { HEALTHY: "success", DEGRADED: "warning", UNHEALTHY: "danger", UNKNOWN: "neutral", NOT_APPLICABLE: "neutral" };
