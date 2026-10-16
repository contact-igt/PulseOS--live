// @vitest-environment node
import { describe, expect, it } from "vitest";
import { afterLoginPath, loginHrefWithReturn, safeReturnPath } from "../authRedirect";

describe("safeReturnPath", () => {
  it("accepts an in-app path, with query", () => {
    expect(safeReturnPath("/patients/abc?tab=timeline")).toBe("/patients/abc?tab=timeline");
    expect(safeReturnPath("/command-centre")).toBe("/command-centre");
  });
  it("refuses anything that could leave the app", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "patients", "", null, undefined, "/%2f%2fevil", "/a\nb"]) {
      expect(safeReturnPath(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
  it("never returns to a public page: sign-in, sign-up or the landing page", () => {
    for (const p of ["/", "/login", "/login/acme", "/signup", "/login?from=/x"]) expect(safeReturnPath(p), p).toBeNull();
  });
});

describe("loginHrefWithReturn", () => {
  it("adds the page the person was on", () => {
    expect(loginHrefWithReturn("/login", "/patients/1")).toBe("/login?from=%2Fpatients%2F1");
    expect(loginHrefWithReturn("/login/acme", "/inbox")).toBe("/login/acme?from=%2Finbox");
  });
  it("leaves the plain sign-in address when there is nowhere sensible to return to", () => {
    expect(loginHrefWithReturn("/login", "/")).toBe("/login");
    expect(loginHrefWithReturn("/login", "//evil")).toBe("/login");
  });
});

describe("afterLoginPath", () => {
  it("returns to the requested page when this role may use it, else the role's home", () => {
    const allowed = (p: string) => p.startsWith("/patients");
    expect(afterLoginPath("/patients/9", "/front-desk", allowed)).toBe("/patients/9");
    expect(afterLoginPath("/settings", "/front-desk", allowed)).toBe("/front-desk");
    expect(afterLoginPath(null, "/front-desk", allowed)).toBe("/front-desk");
    expect(afterLoginPath("https://evil.example", "/front-desk", allowed)).toBe("/front-desk");
  });
});
