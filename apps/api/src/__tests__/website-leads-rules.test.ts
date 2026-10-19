import { describe, expect, it } from "vitest";
import { applyWebsiteForm, connectorStatusFor, generateIntakeToken, normalizeOrigin, readWebsiteForm, resolvePublicApiBase, websiteFormInputSchema } from "../domain/integration/website-leads-rules.js";

describe("normalizeOrigin", () => {
  it("reduces a site address to its bare origin", () => {
    expect(normalizeOrigin("https://www.Clinic.example/")).toBe("https://www.clinic.example");
    expect(normalizeOrigin("https://clinic.example:8443")).toBe("https://clinic.example:8443");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
  it("refuses anything that is not a plain http(s) origin", () => {
    for (const bad of ["", "clinic.example", "ftp://clinic.example", "javascript:alert(1)", "https://clinic.example/contact", "https://clinic.example?x=1", "https://user:pw@clinic.example", "https://*.clinic.example", "*", "null", "https://"]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });
  it("only allows plain http for localhost", () => {
    expect(normalizeOrigin("http://clinic.example")).toBeNull();
    expect(normalizeOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });
});

describe("websiteFormInputSchema", () => {
  const ok = { displayName: "Website Contact Form", formId: "website-contact-v1", enabled: true, requireService: false, fixedSource: false, allowedOrigins: ["https://clinic.example/"] };
  it("accepts a valid form and normalises its origins", () => {
    const r = websiteFormInputSchema.parse({ ...ok, allowedOrigins: ["https://Clinic.example/", "https://clinic.example"] });
    expect(r.allowedOrigins).toEqual(["https://clinic.example"]);
    expect(typeof r.requireService).toBe("boolean");
  });
  it("keeps booleans and arrays typed, never strings", () => {
    expect(websiteFormInputSchema.safeParse({ ...ok, requireService: "true" }).success).toBe(false);
    expect(websiteFormInputSchema.safeParse({ ...ok, allowedOrigins: "https://clinic.example" }).success).toBe(false);
  });
  it("rejects a bad form id, a bad origin, too many origins and unknown fields", () => {
    expect(websiteFormInputSchema.safeParse({ ...ok, formId: "Has Spaces" }).success).toBe(false);
    expect(websiteFormInputSchema.safeParse({ ...ok, formId: "x" }).success).toBe(false);
    expect(websiteFormInputSchema.safeParse({ ...ok, allowedOrigins: ["https://clinic.example/contact"] }).success).toBe(false);
    expect(websiteFormInputSchema.safeParse({ ...ok, allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://s${i}.example`) }).success).toBe(false);
    expect(websiteFormInputSchema.safeParse({ ...ok, tenantId: "other" }).success).toBe(false);
  });
  it("an empty origin list is allowed (server-to-server only)", () => {
    expect(websiteFormInputSchema.parse({ ...ok, allowedOrigins: [] }).allowedOrigins).toEqual([]);
  });
});

describe("readWebsiteForm", () => {
  it("gives the documented defaults for a connector that never had a form configured", () => {
    expect(readWebsiteForm({}, "DISABLED_NOT")).toMatchObject({ formId: "website-contact-v1", displayName: "Website Contact Form", requireService: false, fixedSource: false, allowedOrigins: [] });
  });
  it("reads typed values, and ignores values of the wrong type", () => {
    const r = readWebsiteForm({ formId: "ctt-1", formName: "Cataract page", requireService: true, fixedSource: "website", allowedOrigins: ["https://a.example", 5, "https://b.example"] }, "CONNECTED");
    expect(r).toMatchObject({ formId: "ctt-1", displayName: "Cataract page", requireService: true, fixedSource: true, allowedOrigins: ["https://a.example", "https://b.example"], enabled: true });
    expect(readWebsiteForm({ requireService: "true", allowedOrigins: "x" }, "CONNECTED")).toMatchObject({ requireService: false, allowedOrigins: [] });
  });
  it("is disabled only when the connector status says so", () => {
    expect(readWebsiteForm({}, "DISABLED").enabled).toBe(false);
    expect(readWebsiteForm({}, "ERROR").enabled).toBe(true);
  });
});

describe("applyWebsiteForm", () => {
  it("writes typed values and keeps every other key already on the connector", () => {
    const next = applyWebsiteForm({ formIds: ["a"], keepMe: 1 }, { displayName: "Contact", formId: "contact-1", description: null, enabled: true, requireService: true, fixedSource: true, allowedOrigins: ["https://a.example"] });
    expect(next).toMatchObject({ formIds: ["a"], keepMe: 1, formId: "contact-1", formName: "Contact", requireService: true, fixedSource: "website", allowedOrigins: ["https://a.example"], requireToken: true });
    expect(Array.isArray(next.allowedOrigins)).toBe(true);
  });
  it("removes the fixed source and description when they are switched off", () => {
    const next = applyWebsiteForm({ fixedSource: "website", description: "x" }, { displayName: "Contact", formId: "contact-1", description: null, enabled: true, requireService: false, fixedSource: false, allowedOrigins: [] });
    expect(next.fixedSource).toBeUndefined();
    expect(next.description).toBeUndefined();
    expect(next.requireService).toBe(false);
  });
});

describe("generateIntakeToken", () => {
  it("is long, url-safe, prefixed and different every time", () => {
    const a = generateIntakeToken();
    const b = generateIntakeToken();
    expect(a).toMatch(/^wlk_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("resolvePublicApiBase", () => {
  it("uses the configured public origin, ignoring trailing slashes", () => {
    expect(resolvePublicApiBase("https://api.pulseos.example", "production", undefined)).toBe("https://api.pulseos.example");
    expect(resolvePublicApiBase(" https://api.pulseos.example/// ", "production", undefined)).toBe("https://api.pulseos.example");
  });
  it("keeps a path prefix a reverse proxy mounts the API under", () => {
    expect(resolvePublicApiBase("https://pulseos.example/api/", "production", undefined)).toBe("https://pulseos.example/api");
  });
  it("falls back to localhost only outside production", () => {
    expect(resolvePublicApiBase(undefined, "development", undefined)).toBe("http://localhost:4310");
    expect(resolvePublicApiBase("", "test", "5000")).toBe("http://localhost:5000");
    expect(resolvePublicApiBase(undefined, "production", undefined)).toBeNull();
  });
  it("a value that is not an http(s) address is a misconfiguration, never a silent localhost", () => {
    for (const bad of ["api.pulseos.example", "ftp://api.example", "javascript:alert(1)", "https://", "https://api.example?x=1", "https://user:pw@api.example"]) {
      expect(resolvePublicApiBase(bad, "development", undefined), bad).toBeNull();
      expect(resolvePublicApiBase(bad, "production", undefined), bad).toBeNull();
    }
  });
});

describe("rollback-safe intake status", () => {
  const base = { enabled: true, hasToken: true, current: "NOT_CONFIGURED" } as const;
  const form = (enabled: boolean) => ({ displayName: "Contact", formId: "contact-1", description: null, enabled, requireService: false, fixedSource: false, allowedOrigins: [] });
  it("a form with no token is never left enabled: an older API release, which ignores requireToken, would accept anyone", () => {
    for (const current of ["NOT_CONFIGURED", "CONNECTING", "CONNECTED", "ERROR", "DEGRADED", "DISABLED"] as const) {
      expect(connectorStatusFor({ enabled: true, hasToken: false, current }), current).toBe("DISABLED");
    }
  });
  it("switched off is always disabled, with or without a token", () => {
    expect(connectorStatusFor({ ...base, enabled: false })).toBe("DISABLED");
    expect(connectorStatusFor({ ...base, enabled: false, hasToken: false })).toBe("DISABLED");
  });
  it("enabled with a token starts verification when it was off or new, and otherwise keeps what real traffic proved", () => {
    expect(connectorStatusFor({ ...base, current: "DISABLED" })).toBe("CONNECTING");
    expect(connectorStatusFor({ ...base, current: "NOT_CONFIGURED" })).toBe("CONNECTING");
    expect(connectorStatusFor({ ...base, current: "CONNECTED" })).toBe("CONNECTED");
    expect(connectorStatusFor({ ...base, current: "ERROR" })).toBe("ERROR");
  });
  it("the admin's own on/off choice is stored apart from the status and read back from there", () => {
    const off = applyWebsiteForm({}, form(false));
    expect(off.formEnabled).toBe(false);
    expect(readWebsiteForm(off, "DISABLED").enabled).toBe(false);
    const on = applyWebsiteForm({}, form(true));
    expect(on.formEnabled).toBe(true);
    // Enabled by choice but held DISABLED because there is no token yet: still reads as enabled.
    expect(readWebsiteForm(on, "DISABLED").enabled).toBe(true);
    // A connector that predates the setting: the status is all there is.
    expect(readWebsiteForm({}, "DISABLED").enabled).toBe(false);
    expect(readWebsiteForm({}, "CONNECTED").enabled).toBe(true);
  });
});
