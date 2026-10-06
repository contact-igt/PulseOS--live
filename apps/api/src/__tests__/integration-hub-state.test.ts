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

  it("CCS IVR is active with telephony adapter", () => {
    expect(ccs.blockedReason).toBeNull();
    expect(ccs.connectorProvider).toBe("ccs_ivr");
    expect(deriveConfiguration(ccs, null)).toBe("NOT_CONFIGURED");
  });
  // The Railway screenshot: stored credentials the server cannot decrypt must never read as "Configured / Healthy / Connected".
  describe("credentials stored but unreadable (encryption key missing or changed)", () => {
    const ccsConnected: ConnectorFacts = { status: "CONNECTED", mode: "LIVE", configuration: {}, secretKeys: [] };
    const unreadable: ConnectorFacts = { ...ccsConnected, secretsUnreadable: true };

    it("is Partly configured and Degraded, even for a connector with no required credentials and a recent event", () => {
      const withKey: ConnectorFacts = { ...ccsConnected, secretKeys: ["apiKey"] };
      expect(deriveConfiguration(ccs, withKey)).toBe("CONFIGURED");
      expect(deriveHealth(ccs, withKey)).toBe("HEALTHY");
      expect(deriveConfiguration(ccs, unreadable)).toBe("PARTIAL");
      expect(deriveHealth(ccs, unreadable)).toBe("DEGRADED");
      expect(deriveMode(ccs, true, "PARTIAL", unreadable)).toBe("NOT_CONFIGURED");
    });

    it("keeps a worse status worse (ERROR stays Unhealthy)", () => {
      expect(deriveHealth(ccs, { ...unreadable, status: "ERROR" })).toBe("UNHEALTHY");
    });

    it("does not matter in fixture mode for providers that use no credentials there", () => {
      expect(deriveConfiguration(wa, { ...full, mode: "FIXTURE", secretsUnreadable: true })).toBe("CONFIGURED");
    });

    it("but CCS verifies every inbound call with its stored keys in every mode, so unreadable keys always count", () => {
      expect(deriveConfiguration(ccs, { ...unreadable, mode: "FIXTURE" })).toBe("PARTIAL");
    });
  });

  // The CCS webhook refuses every call report unless a stored key is presented, so a CCS connector with no key saved
  // cannot receive anything: it is not "Configured", and a stale Connected status is not "Healthy".
  describe("CCS needs at least one saved key to receive calls", () => {
    const noKeys: ConnectorFacts = { status: "CONNECTED", mode: "LIVE", configuration: { accountEmail: "a@b.test" }, secretKeys: [] };
    it.each([["apiKey"], ["secretKey"], ["integrationKey"]])("any one of the three keys (%s) is enough", (k) => {
      expect(deriveConfiguration(ccs, { ...noKeys, secretKeys: [k] })).toBe("CONFIGURED");
    });
    it("no key saved: Not configured, health Not verified, whatever the stored status says", () => {
      expect(deriveConfiguration(ccs, noKeys)).toBe("NOT_CONFIGURED");
      expect(deriveConfiguration(ccs, { ...noKeys, mode: "FIXTURE" })).toBe("NOT_CONFIGURED");
      expect(deriveHealth(ccs, noKeys)).toBe("UNKNOWN");
      expect(deriveMode(ccs, true, "NOT_CONFIGURED", noKeys)).toBe("NOT_CONFIGURED");
    });
    it("providers without that rule are unaffected", () => {
      expect(deriveConfiguration(catalogueEntry("runo")!, { ...noKeys, secretKeys: ["webhookSharedSecret"] })).toBe("CONFIGURED");
    });
  });
});
