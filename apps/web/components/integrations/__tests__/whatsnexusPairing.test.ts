import { describe, expect, it } from "vitest";
import { looksLikePairingCode, normalizePairingCode, pairingProblem } from "../whatsnexusPairing";

describe("normalizePairingCode", () => {
  it("removes the whitespace, line breaks and quotes a paste brings along", () => {
    expect(normalizePairingCode("  wnpair_VFQwMDE.abc \n")).toBe("wnpair_VFQwMDE.abc");
    expect(normalizePairingCode('"wnpair_VFQwMDE.abc"')).toBe("wnpair_VFQwMDE.abc");
    expect(normalizePairingCode("wnpair_VFQw\nMDE.abc")).toBe("wnpair_VFQwMDE.abc");
  });
});

describe("looksLikePairingCode", () => {
  it("accepts the shape WhatsNexus issues and nothing else", () => {
    expect(looksLikePairingCode("wnpair_VFQwMDE." + "a".repeat(32))).toBe(true);
    expect(looksLikePairingCode("wnpk_ab12cd34_" + "a".repeat(40))).toBe(false); // an API key is not a code
    expect(looksLikePairingCode("")).toBe(false);
    expect(looksLikePairingCode("wnpair_x")).toBe(false);
  });
});

describe("pairingProblem", () => {
  it.each([
    ["pair_invalid_code", /not valid|already been used/i],
    ["pair_code_expired", /expired/i],
    ["pair_binding_mismatch", /different (hospital|tenant)/i],
    ["pair_tenant_inactive", /not active/i],
    ["pair_integration_off", /not switched on|switched off/i],
    ["pair_callback_rejected", /public https/i],
    ["pair_rate_limited", /too many/i],
    ["pair_unreachable", /could not reach/i],
    ["pair_unexpected_response", /unexpected/i],
    ["public_url_not_configured", /PUBLIC_API_BASE_URL/],
    ["https_required", /https/i],
    ["private_address", /public/i],
    ["invalid_url", /address/i],
    ["forbidden", /super admin/i],
  ])("%s is explained in plain words", (reason, pattern) => {
    expect(pairingProblem(reason)).toMatch(pattern);
  });
  it("an unknown reason still gives a usable message, never the raw code", () => {
    expect(pairingProblem("zzz_weird")).toMatch(/could not connect/i);
    expect(pairingProblem("zzz_weird")).not.toContain("zzz_weird");
    expect(pairingProblem(undefined)).toMatch(/could not connect/i);
  });
});
