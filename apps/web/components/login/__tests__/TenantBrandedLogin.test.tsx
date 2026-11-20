import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TenantLoginBranding } from "@pulseos/types";
import { DEFAULT_LOGIN_SUPPORT_TEXT, DEFAULT_LOGIN_TAGLINE } from "@pulseos/types";
import { TenantBrandedLogin, WorkspaceNotFound } from "../TenantBrandedLogin";
import { tenantBrandingSchema } from "../../../lib/tenantBranding";

const base: TenantLoginBranding = {
  slug: "namokar", displayName: "Namokar Eye & Oculoplasty Centre", shortName: "Namokar", logoPath: null, headline: null,
  tagline: "Every enquiry, call, appointment and follow-up for your patients, in one place.", badgeLabel: "V1 Pilot", supportText: DEFAULT_LOGIN_SUPPORT_TEXT,
};
const page = (over: Partial<TenantLoginBranding> = {}) => render(<TenantBrandedLogin branding={{ ...base, ...over }}><form aria-label="form-slot" /></TenantBrandedLogin>);

describe("TenantBrandedLogin: one layout, tenant-driven words", () => {
  it("shows PulseOS branding and the sign-in form without naming the hospital", () => {
    page();
    const lockup = screen.getByTestId("login-lockup");
    expect(lockup.textContent).toBe("PulseOS");
    expect(screen.getByTestId("login-tagline").textContent).toBe(base.tagline);
    expect(screen.getByTestId("tenant-login-pilot").textContent).toBe("V1 Pilot");
    expect(document.body.textContent).not.toContain("Namokar");
    expect(screen.getByTestId("login-support").textContent).toBe("Need help? Contact your administrator.");
    expect(screen.getByRole("form", { name: "form-slot" })).toBeTruthy(); // the interactive form is a slot, not part of this server component
  });

  it("keeps the workspace slug while omitting the configured hospital headline", () => {
    page({ slug: "rio", displayName: "RIO Children’s & Women’s Hospital", shortName: "RIO", badgeLabel: null, headline: "RIO Children’s & Women’s Hospital", tagline: DEFAULT_LOGIN_TAGLINE });
    expect(screen.getByTestId("login-tagline").textContent).toBe(DEFAULT_LOGIN_TAGLINE);
    expect(document.body.textContent).not.toContain("RIO");
    expect(screen.getByTestId("tenant-login").getAttribute("data-workspace")).toBe("rio");
  });

  it("no badge in the configuration means no badge on the page (nothing is hardcoded)", () => {
    page({ badgeLabel: null });
    expect(screen.queryByTestId("tenant-login-pilot")).toBeNull();
    expect(screen.getByTestId("login-note").textContent).toBe("");
  });

  it("omits a configured hospital logo", () => {
    page({ logoPath: "/brand/test-mark.svg" });
    expect(document.querySelector('img[src="/brand/test-mark.svg"]')).toBeNull();
  });

  it("never renders markup from the data: tenant text is text", () => {
    page({ tagline: "<img src=x onerror=alert(1)> hello", shortName: "<b>Bold</b>" });
    expect(screen.getByTestId("login-tagline").textContent).toBe("<img src=x onerror=alert(1)> hello");
    expect(document.querySelectorAll("img[src='x']")).toHaveLength(0);
    expect(document.querySelectorAll("b")).toHaveLength(0);
  });

  it("carries nothing of development or other hospitals", () => {
    page();
    expect(document.body.textContent).not.toMatch(/developer|demo|password for|create account|other hospital/i);
    expect(document.querySelectorAll("select, [data-testid='dev-login-block']")).toHaveLength(0);
  });

  it("decoration is hidden from assistive technology", () => {
    page();
    expect(document.querySelector("svg[aria-hidden='true']")).toBeTruthy();
  });

  it("the not-found state names no hospital", () => {
    render(<WorkspaceNotFound />);
    expect(screen.getByText("Workspace not found")).toBeTruthy();
    expect(screen.getByTestId("tenant-login-missing").textContent).not.toMatch(/namokar|hospital id|tenant/i);
  });
});

describe("tenantBrandingSchema: the only shape the page will render", () => {
  const ok = { ...base };
  it("accepts the public fields and drops anything else the API might add", () => {
    const parsed = tenantBrandingSchema.parse({ ...ok, tenantId: "secret", edition: "BETA_V1_CORE", email: "a@b.c" });
    expect(Object.keys(parsed).sort()).toEqual(["badgeLabel", "displayName", "headline", "logoPath", "shortName", "slug", "supportText", "tagline"]);
  });

  it("refuses a logo that is not a /brand file, and over-long or empty text", () => {
    for (const bad of [{ logoPath: "https://evil.example/x.svg" }, { logoPath: "/brand/../x.svg" }, { logoPath: "javascript:alert(1)" }, { tagline: "x".repeat(161) }, { displayName: "" }, { slug: "Bad Slug" }, { badgeLabel: "x".repeat(25) }]) {
      expect(tenantBrandingSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
