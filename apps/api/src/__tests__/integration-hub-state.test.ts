import { describe, expect, it } from "vitest";
import { catalogueEntry } from "../domain/integration/hub-catalogue.js";
import { deriveConfiguration, deriveHealth, deriveMode, deriveWebsiteLeads, type ConnectorFacts } from "../domain/integration/hub-state.js";

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
});

describe("Website Leads card state", () => {
  const website = catalogueEntry("website_leads")!;
  const live = (over: Partial<ConnectorFacts> = {}): ConnectorFacts => ({ status: "CONNECTING", mode: "LIVE", configuration: { formId: "website-contact-v1" }, secretKeys: ["intakeToken"], ...over });

  it("is an inbound lead-source card backed by the existing website_form connector", () => {
    expect(website).toMatchObject({ category: "ADS", connectorProvider: "website_form", connectorType: "ACQUISITION", connectorCapabilities: ["RECEIVE_FORM"], blockedReason: null, capability: null });
    // Nothing generic: the structured settings and the token have their own typed endpoints.
    expect(website.configurationFields).toEqual([]);
    expect(website.secretFields).toEqual([]);
  });

  it("is not configured until a connector exists, and only partly configured without a token", () => {
    expect(deriveWebsiteLeads(null)).toEqual({ enabled: true, configuration: "NOT_CONFIGURED", verified: false });
    expect(deriveWebsiteLeads(live({ secretKeys: [] }))).toMatchObject({ enabled: true, configuration: "PARTIAL" });
    expect(deriveWebsiteLeads(live())).toMatchObject({ enabled: true, configuration: "CONFIGURED" });
  });

  it("disabled is its own fact: configuration is still reported, the mode says Disabled", () => {
    const f = live({ status: "DISABLED" });
    const s = deriveWebsiteLeads(f);
    expect(s).toMatchObject({ enabled: false, configuration: "CONFIGURED" });
    expect(deriveMode(website, s.enabled, s.configuration, f)).toBe("DISABLED");
  });

  it("saved is not verified: a configured connector waiting for its first real submission is live-capable and health stays unknown", () => {
    const f = live();
    const s = deriveWebsiteLeads(f);
    expect(deriveMode(website, s.enabled, s.configuration, f)).toBe("LIVE_CAPABLE");
    expect(deriveHealth(website, f)).toBe("UNKNOWN");
  });

  it("a connector merely MARKED connected (a seed, a stale flag) with no real submission is not verified", () => {
    const marked = live({ status: "CONNECTED", lastEventAt: null });
    expect(deriveWebsiteLeads(marked).verified).toBe(false);
    expect(deriveWebsiteLeads(live({ status: "CONNECTED", lastEventAt: new Date() })).verified).toBe(true);
    expect(deriveWebsiteLeads(live({ status: "CONNECTING", lastEventAt: new Date() })).verified).toBe(false); // proof from before a change does not count
    expect(deriveWebsiteLeads(live({ status: "ERROR", lastEventAt: new Date() })).verified).toBe(false);
    expect(deriveWebsiteLeads(null).verified).toBe(false);
  });

  it("receiving submissions is live-configured and healthy; a processing error is unhealthy", () => {
    const ok = live({ status: "CONNECTED" });
    expect(deriveMode(website, true, "CONFIGURED", ok)).toBe("LIVE_CONFIGURED");
    expect(deriveHealth(website, ok)).toBe("HEALTHY");
    expect(deriveHealth(website, live({ status: "ERROR" }))).toBe("UNHEALTHY");
  });
});
