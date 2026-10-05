import { describe, expect, it } from "vitest";
import { catalogueEntry } from "../domain/integration/hub-catalogue.js";
import { deriveConfiguration, deriveHealth, deriveMode, type ConnectorFacts } from "../domain/integration/hub-state.js";

const wa = catalogueEntry("whatsapp_meta_cloud")!;
const ccs = catalogueEntry("ccs_ivr")!;
const full: ConnectorFacts = { status: "CONNECTED", mode: "LIVE", configuration: { phoneNumberId: "1" }, secretKeys: ["accessToken", "appSecret", "webhookVerifyToken"] };

describe("integration hub state", () => {
  it("keeps Enabled, Configuration and Health independent", () => {
    // Switched off but fully configured and healthy: the three facts disagree and all are reported.
    const cfg = deriveConfiguration(wa, full);
    expect(cfg).toBe("CONFIGURED");
    expect(deriveHealth(wa, full)).toBe("HEALTHY");
    expect(deriveMode(wa, false, cfg, full)).toBe("DISABLED");
    // Switched on but nothing configured.
    expect(deriveMode(wa, true, deriveConfiguration(wa, null), null)).toBe("NOT_CONFIGURED");
  });

  it("reports partial configuration and never assumes health", () => {
    const partial: ConnectorFacts = { ...full, status: "CONNECTING", secretKeys: ["accessToken"] };
    expect(deriveConfiguration(wa, partial)).toBe("PARTIAL");
    expect(deriveHealth(wa, partial)).toBe("UNKNOWN");
    expect(deriveMode(wa, true, "PARTIAL", partial)).toBe("NOT_CONFIGURED");
  });

  it("distinguishes fixture, sandbox, live-configured and live-capable", () => {
    expect(deriveMode(wa, true, "CONFIGURED", { ...full, mode: "FIXTURE" })).toBe("FIXTURE");
    expect(deriveMode(wa, true, "CONFIGURED", { ...full, mode: "SANDBOX" })).toBe("SANDBOX");
    expect(deriveMode(wa, true, "CONFIGURED", full)).toBe("LIVE_CONFIGURED");
    expect(deriveMode(wa, true, "CONFIGURED", { ...full, status: "ERROR" })).toBe("LIVE_CAPABLE");
    expect(deriveHealth(wa, { ...full, status: "ERROR" })).toBe("UNHEALTHY");
  });

  it("fixture mode needs only settings, never credentials (it contacts no provider)", () => {
    const fixture: ConnectorFacts = { status: "CONNECTED", mode: "FIXTURE", configuration: { phoneNumberId: "1" }, secretKeys: [] };
    expect(deriveConfiguration(wa, fixture)).toBe("CONFIGURED");
    expect(deriveConfiguration(wa, { ...fixture, mode: "LIVE" })).toBe("PARTIAL");
  });

  it("CCS IVR is blocked, with no adapter and no health", () => {
    expect(ccs.blockedReason).toBe("Provider API/Webhook documentation required");
    expect(ccs.connectorProvider).toBeNull();
    expect(deriveConfiguration(ccs, null)).toBe("BLOCKED");
    expect(deriveMode(ccs, true, "BLOCKED", null)).toBe("BLOCKED");
    expect(deriveHealth(ccs, null)).toBe("NOT_APPLICABLE");
  });
});
