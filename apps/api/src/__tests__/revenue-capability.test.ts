import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_DEPENDENCIES, resolveCapabilities, validateCapabilityChange } from "@pulseos/types";

// Revenue tracking is a TENANT capability, not a global feature: every edition keeps it by default (nothing is deleted
// for other hospitals), and a tenant that does not want a revenue workflow (the Namokar pilot) switches it off.
describe("REVENUE_TRACKING capability", () => {
  it("exists and is on by default in both editions (no behaviour change for other hospitals)", () => {
    expect(CAPABILITIES).toContain("REVENUE_TRACKING");
    expect(resolveCapabilities("BETA_V1_CORE", {}).REVENUE_TRACKING).toBe(true);
    expect(resolveCapabilities("BETA_V2_GROWTH", {}).REVENUE_TRACKING).toBe(true);
  });

  it("a tenant override switches it off and the edition default cannot bring it back", () => {
    expect(resolveCapabilities("BETA_V1_CORE", { REVENUE_TRACKING: false }).REVENUE_TRACKING).toBe(false);
    expect(resolveCapabilities("BETA_V2_GROWTH", { REVENUE_TRACKING: false }).REVENUE_TRACKING).toBe(false);
  });

  it("an override only changes its own capability", () => {
    const base = resolveCapabilities("BETA_V1_CORE", {});
    const next = resolveCapabilities("BETA_V1_CORE", { REVENUE_TRACKING: false });
    for (const c of CAPABILITIES) expect(next[c], c).toBe(c === "REVENUE_TRACKING" ? false : base[c]);
  });

  it("marketing analytics (revenue attribution, ROAS) needs revenue tracking", () => {
    expect(CAPABILITY_DEPENDENCIES.MARKETING_ANALYTICS).toContain("REVENUE_TRACKING");
    const noRevenue = resolveCapabilities("BETA_V1_CORE", { REVENUE_TRACKING: false });
    expect(validateCapabilityChange(noRevenue, "MARKETING_ANALYTICS", true)).toEqual({ ok: false, reason: "requires", capabilities: ["REVENUE_TRACKING"] });
  });

  it("revenue tracking cannot be switched off under a tenant that still has marketing analytics", () => {
    const v2 = resolveCapabilities("BETA_V2_GROWTH", {});
    const res = validateCapabilityChange(v2, "REVENUE_TRACKING", false);
    expect(res).toMatchObject({ ok: false, reason: "required_by" });
  });

  it("a V1 tenant can switch it off and on freely (no dependants)", () => {
    const v1 = resolveCapabilities("BETA_V1_CORE", {});
    expect(validateCapabilityChange(v1, "REVENUE_TRACKING", false)).toEqual({ ok: true });
  });
});
