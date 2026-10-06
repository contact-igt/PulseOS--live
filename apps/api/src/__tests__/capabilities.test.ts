import { describe, expect, it } from "vitest";
import { CAPABILITIES, capabilityEnabled, resolveCapabilities, validateCapabilityChange } from "@pulseos/types";

describe("capability defaults by edition (a default bundle, not a fork)", () => {
  it("core analytics is on in both editions", () => {
    expect(resolveCapabilities("BETA_V1_CORE", {}).ANALYTICS_CORE).toBe(true);
    expect(resolveCapabilities("BETA_V2_GROWTH", {}).ANALYTICS_CORE).toBe(true);
  });

  it("V1 defaults: marketing, ads, inbox and conversation intelligence off; WhatsApp notifications on", () => {
    const v1 = resolveCapabilities("BETA_V1_CORE", {});
    for (const off of ["MARKETING_ANALYTICS", "GOOGLE_ADS", "META_ADS", "WHATSAPP_INBOX", "CONVERSATION_INTELLIGENCE", "CAMPAIGNS", "SPEND_ATTRIBUTION", "SMS_NOTIFICATIONS"] as const) expect(v1[off], off).toBe(false);
    expect(v1.CCS_IVR).toBe(true); // a V1 calling provider, switched on with Runo
    for (const on of ["ANALYTICS_CORE", "RUNO_CALLING", "WHATSAPP_NOTIFICATIONS"] as const) expect(v1[on], on).toBe(true);
  });

  it("V2 defaults: marketing, inbox, conversation intelligence on", () => {
    const v2 = resolveCapabilities("BETA_V2_GROWTH", {});
    for (const on of ["MARKETING_ANALYTICS", "GOOGLE_ADS", "META_ADS", "WHATSAPP_INBOX", "CONVERSATION_INTELLIGENCE", "WHATSAPP_NOTIFICATIONS", "CAMPAIGNS", "SPEND_ATTRIBUTION"] as const) expect(v2[on], on).toBe(true);
  });

  it("every capability has an answer", () => {
    for (const e of ["BETA_V1_CORE", "BETA_V2_GROWTH"] as const) expect(Object.keys(resolveCapabilities(e, {})).sort()).toEqual([...CAPABILITIES].sort());
  });
});

describe("tenant overrides are the runtime authority", () => {
  it("a V1 tenant can have marketing switched on, a V2 tenant can have it switched off", () => {
    expect(resolveCapabilities("BETA_V1_CORE", { MARKETING_ANALYTICS: true }).MARKETING_ANALYTICS).toBe(true);
    expect(resolveCapabilities("BETA_V2_GROWTH", { MARKETING_ANALYTICS: false }).MARKETING_ANALYTICS).toBe(false);
  });
  it("an override only changes its own capability", () => {
    const base = resolveCapabilities("BETA_V1_CORE", {});
    const next = resolveCapabilities("BETA_V1_CORE", { GOOGLE_ADS: true });
    for (const c of CAPABILITIES) expect(next[c], c).toBe(c === "GOOGLE_ADS" ? true : base[c]);
  });
  it("capabilityEnabled accepts an edition (defaults) or a resolved map", () => {
    expect(capabilityEnabled("BETA_V1_CORE", "MARKETING_ANALYTICS")).toBe(false);
    expect(capabilityEnabled(resolveCapabilities("BETA_V1_CORE", { MARKETING_ANALYTICS: true }), "MARKETING_ANALYTICS")).toBe(true);
  });
});

describe("dependency rules", () => {
  it("conversation intelligence needs the WhatsApp inbox: enabling it alone is refused with the reason", () => {
    const v1 = resolveCapabilities("BETA_V1_CORE", {});
    expect(validateCapabilityChange(v1, "CONVERSATION_INTELLIGENCE", true)).toEqual({ ok: false, reason: "requires", capabilities: ["WHATSAPP_INBOX"] });
    expect(validateCapabilityChange(resolveCapabilities("BETA_V1_CORE", { WHATSAPP_INBOX: true }), "CONVERSATION_INTELLIGENCE", true)).toEqual({ ok: true });
  });
  it("switching the inbox off while conversation intelligence is on is refused", () => {
    const v2 = resolveCapabilities("BETA_V2_GROWTH", {});
    expect(validateCapabilityChange(v2, "WHATSAPP_INBOX", false)).toEqual({ ok: false, reason: "required_by", capabilities: ["CONVERSATION_INTELLIGENCE"] });
  });
  it("WhatsApp notifications are independent of the inbox", () => {
    const v1 = resolveCapabilities("BETA_V1_CORE", { WHATSAPP_NOTIFICATIONS: true });
    expect(v1.WHATSAPP_INBOX).toBe(false);
    expect(validateCapabilityChange(resolveCapabilities("BETA_V2_GROWTH", {}), "WHATSAPP_NOTIFICATIONS", false)).toEqual({ ok: true });
  });
  it("spend attribution and campaigns need marketing analytics", () => {
    const v1 = resolveCapabilities("BETA_V1_CORE", {});
    expect(validateCapabilityChange(v1, "SPEND_ATTRIBUTION", true)).toMatchObject({ ok: false, reason: "requires", capabilities: ["MARKETING_ANALYTICS"] });
  });
  it("ads providers need marketing analytics (their only read surface); marketing without providers is a valid setup state", () => {
    expect(validateCapabilityChange(resolveCapabilities("BETA_V1_CORE", {}), "GOOGLE_ADS", true)).toMatchObject({ ok: false, reason: "requires" });
    expect(validateCapabilityChange(resolveCapabilities("BETA_V1_CORE", { MARKETING_ANALYTICS: true }), "GOOGLE_ADS", true)).toEqual({ ok: true });
    expect(validateCapabilityChange(resolveCapabilities("BETA_V1_CORE", {}), "MARKETING_ANALYTICS", true)).toEqual({ ok: true });
  });
  it("core analytics cannot be switched off", () => {
    expect(validateCapabilityChange(resolveCapabilities("BETA_V2_GROWTH", {}), "ANALYTICS_CORE", false)).toMatchObject({ ok: false, reason: "locked" });
  });
});
