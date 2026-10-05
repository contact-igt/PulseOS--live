import { beforeEach, describe, expect, it } from "vitest";
import { loginPathFor, rememberLoginPage, rememberedLoginPath } from "../loginPage";

describe("loginPathFor", () => {
  it("sends a hospital's people back to its own page, and everyone else to the general one", () => {
    expect(loginPathFor("namokar")).toBe("/login/namokar");
    expect(loginPathFor(null)).toBe("/login");
    expect(loginPathFor(undefined)).toBe("/login");
  });

  it("never follows anything but a plain slug", () => {
    for (const bad of ["../admin", "//evil.example", "https://evil.example", "a b", "Namokar", "x", "-bad", "bad-", "a".repeat(60), "/login/x"]) expect(loginPathFor(bad), bad).toBe("/login");
  });
});

describe("remembered sign-in page", () => {
  beforeEach(() => window.localStorage.clear());

  it("remembers the hospital's page for an expired session, and forgets it for a hospital without one", () => {
    rememberLoginPage("namokar");
    expect(rememberedLoginPath()).toBe("/login/namokar");
    rememberLoginPage(null);
    expect(rememberedLoginPath()).toBe("/login");
  });

  it("ignores a tampered stored value", () => {
    window.localStorage.setItem("pulseos.loginPage", "//evil.example");
    expect(rememberedLoginPath()).toBe("/login");
  });
});
