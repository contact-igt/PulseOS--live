import { render, screen, within } from "@testing-library/react";
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
  it("shows PulseOS × client, the client's name, the tagline, the badge and the workspace sentence", () => {
    page();
    const lockup = screen.getByTestId("login-lockup");
    expect(within(lockup).getByText("×")).toBeTruthy();
    expect(within(lockup).getByTestId("login-client-name").textContent).toBe("Namokar");
    expect(screen.getByTestId("login-headline").textContent).toBe("Namokar Eye & Oculoplasty Centre");
    expect(screen.getByTestId("login-tagline").textContent).toBe(base.tagline);
    expect(screen.getByTestId("tenant-login-pilot").textContent).toBe("V1 Pilot");
    expect(screen.getByTestId("tenant-login-workspace").textContent).toBe("You are signing into Namokar’s PulseOS workspace.");
    expect(screen.getByTestId("login-support").textContent).toBe("Need help? Contact your administrator.");
    expect(screen.getByRole("form", { name: "form-slot" })).toBeTruthy(); // the interactive form is a slot, not part of this server component
  });

  it("a different hospital uses the SAME layout with its own words", () => {
    page({ slug: "rio", displayName: "RIO Children’s & Women’s Hospital", shortName: "RIO", badgeLabel: null, headline: "RIO Children’s & Women’s Hospital", tagline: DEFAULT_LOGIN_TAGLINE });
    expect(screen.getByTestId("login-client-name").textContent).toBe("RIO");
    expect(screen.getByTestId("login-tagline").textContent).toBe(DEFAULT_LOGIN_TAGLINE);
    expect(screen.getByTestId("tenant-login-workspace").textContent).toContain("RIO’s PulseOS workspace");
    expect(screen.getByTestId("tenant-login").getAttribute("data-workspace")).toBe("rio");
  });

  it("no badge in the configuration means no badge on the page (nothing is hardcoded)", () => {
    page({ badgeLabel: null });
    expect(screen.queryByTestId("tenant-login-pilot")).toBeNull();
    expect(screen.getByTestId("login-note").textContent).toBe("");
  });

  it("no logo: the typographic name is the fallback and nothing else is needed", () => {
    page({ logoPath: null });
    expect(screen.getByTestId("login-client-name")).toBeTruthy();
    expect(screen.queryByTestId("login-client-logo")).toBeNull();
  });

  it("a logo: the approved mark replaces the name, as an image of the file itself, with the hospital's name as its text alternative", () => {
    page({ logoPath: "/brand/test-mark.svg" });
    const logo = screen.getByTestId("login-client-logo").querySelector("img")!;
    expect(logo.getAttribute("src")).toBe("/brand/test-mark.svg");
    expect(logo.getAttribute("alt")).toBe("Namokar Eye & Oculoplasty Centre");
    expect(logo.className).toContain("object-contain"); // never stretched
    expect(logo.getAttribute("style")).toBeNull(); // no recolouring or filters
    expect(screen.queryByTestId("login-client-name")).toBeNull();
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
