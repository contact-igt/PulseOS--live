import { describe, expect, it } from "vitest";
import { resolveBackTarget } from "../BackLink";

const fallback = { href: "/patients/abc", label: "Back" };

describe("resolveBackTarget", () => {
  it("maps a known ?from= key to its list route", () => {
    expect(resolveBackTarget("leads", fallback)).toEqual({ href: "/leads", label: "Back to Leads" });
  });

  it("uses the fallback when there is no ?from=", () => {
    expect(resolveBackTarget(null, fallback)).toEqual(fallback);
  });

  it("uses the fallback for an unknown key and never follows it as a URL", () => {
    expect(resolveBackTarget("https://evil.example", fallback)).toEqual(fallback);
    expect(resolveBackTarget("//evil.example", fallback)).toEqual(fallback);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("ignores the inherited object key %s", (key) => {
    expect(resolveBackTarget(key, fallback)).toEqual(fallback);
  });
});
