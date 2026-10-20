import { Badge } from "@pulseos/ui";
import type { CredentialState, IntegrationConfigurationState, IntegrationHealth, IntegrationMode } from "@pulseos/types";

// Enabled, configured, credentials, activity and health are separate facts and are never collapsed into one "Connected".
// Every state carries its words, never colour alone.

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return <Badge tone={enabled ? "primary" : "neutral"}>{enabled ? "Enabled" : "Off"}</Badge>;
}

const CONFIG: Record<IntegrationConfigurationState, { label: string; tone: "neutral" | "warning" | "success" | "primary" }> = {
  CONFIGURED: { label: "Configured", tone: "success" },
  PARTIAL: { label: "Partly configured", tone: "warning" },
  NOT_CONFIGURED: { label: "Not configured", tone: "neutral" },
  BLOCKED: { label: "Not available yet", tone: "neutral" },
};
export function ConfigurationBadge({ state }: { state: IntegrationConfigurationState }) {
  return <Badge tone={CONFIG[state].tone}>{CONFIG[state].label}</Badge>;
}

const CRED: Record<CredentialState, { label: string; tone: "neutral" | "danger" | "success" }> = {
  NONE: { label: "Not saved", tone: "neutral" },
  SAVED: { label: "Saved", tone: "success" },
  UNREADABLE: { label: "Saved but unreadable", tone: "danger" },
};
export function CredentialBadge({ state }: { state: CredentialState }) {
  return <Badge tone={CRED[state].tone}>{CRED[state].label}</Badge>;
}

const HEALTH: Record<IntegrationHealth, { label: string; tone: "neutral" | "warning" | "danger" | "success" }> = {
  HEALTHY: { label: "Healthy", tone: "success" },
  DEGRADED: { label: "Degraded", tone: "warning" },
  UNHEALTHY: { label: "Failing", tone: "danger" },
  UNKNOWN: { label: "Unknown", tone: "neutral" },
  NOT_APPLICABLE: { label: "—", tone: "neutral" },
};
export function HealthBadge({ health }: { health: IntegrationHealth }) {
  if (health === "NOT_APPLICABLE") return <span className="text-ink-2">—</span>;
  return <Badge tone={HEALTH[health].tone}>{HEALTH[health].label}</Badge>;
}

export const MODE_LABEL: Record<IntegrationMode, string> = {
  LIVE_CONFIGURED: "Live",
  LIVE_CAPABLE: "Live, not yet confirmed",
  SANDBOX: "Sandbox",
  FIXTURE: "Sample data",
  BLOCKED: "Not available yet",
  NOT_CONFIGURED: "Not configured",
  DISABLED: "Switched off",
};
