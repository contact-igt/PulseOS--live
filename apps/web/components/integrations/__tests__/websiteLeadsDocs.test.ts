// @vitest-environment node
import { describe, expect, it } from "vitest";
import { API_FIELDS, RESPONSES, curlExample, isLocalUrl, nodeExample, originsFromText, originsToText, sampleJson, samplePayload } from "../websiteLeadsDocs";

const URL_ = "https://api.pulseos.example/forms/website/11111111-2222-4333-8444-555555555555";

describe("sample payload", () => {
  it("contains exactly the fields the intake endpoint supports, with the configured form id", () => {
    const p = samplePayload("cataract-page-1");
    expect(Object.keys(p).sort()).toEqual(["clickIds", "email", "formId", "language", "message", "name", "pageUrl", "phone", "referralCode", "service", "submissionId", "utm"].sort());
    expect(p.formId).toBe("cataract-page-1");
    expect(Object.keys(p.utm).sort()).toEqual(["campaign", "content", "medium", "source", "term"]);
    expect(Object.keys(p.clickIds).sort()).toEqual(["fbclid", "gbraid", "gclid", "wbraid"]);
  });
  it("never invents fields from other products", () => {
    const text = sampleJson("website-contact-v1");
    for (const bad of ["your_company", "your_subject", "custom_status", "your_street", "your_name", "tenantId", "connectorId"]) expect(text).not.toContain(bad);
    expect(JSON.parse(text).phone).toMatch(/^\+\d+$/);
  });
  it("the documented field table agrees with the sample", () => {
    const required = API_FIELDS.filter((f) => f.required).map((f) => f.name).sort();
    expect(required).toEqual(["formId", "name", "phone", "submissionId"]);
    for (const f of API_FIELDS) expect(Object.keys(samplePayload("website-contact-v1")).concat(["branchId"])).toContain(f.name);
  });
});

describe("request examples", () => {
  it("curl names the endpoint and header and takes the token from the environment, never a literal", () => {
    const c = curlExample(URL_, "website-contact-v1");
    expect(c).toContain(URL_);
    expect(c).toContain("X-PulseOS-Intake-Token: $PULSEOS_INTAKE_TOKEN");
    expect(c).not.toMatch(/wlk_/);
  });
  it("the server-side example reads the token and URL from server environment and keeps one submission id across retries", () => {
    const n = nodeExample("website-contact-v1");
    expect(n).toContain("process.env.PULSEOS_INTAKE_TOKEN");
    expect(n).toContain("process.env.PULSEOS_WEBSITE_INTAKE_URL");
    expect(n).not.toMatch(/wlk_/);
    expect(n).toMatch(/submissionId/);
  });
  it("documents only the real responses", () => {
    expect(RESPONSES.map((r) => r.status)).toEqual([200, 401, 403, 404, 422, 429, 500]);
  });
});

describe("allowed origins text", () => {
  it("turns one-per-line (or comma separated) text into a clean list, and back", () => {
    expect(originsFromText("https://a.example\n  https://b.example/ , https://a.example\n\n")).toEqual(["https://a.example", "https://b.example/"]);
    expect(originsToText(["https://a.example", "https://b.example"])).toBe("https://a.example\nhttps://b.example");
    expect(originsFromText("")).toEqual([]);
  });
});

describe("isLocalUrl", () => {
  it("flags an address a hospital website cannot reach", () => {
    expect(isLocalUrl("http://localhost:4310/forms/website/x")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:4310/x")).toBe(true);
    expect(isLocalUrl(URL_)).toBe(false);
  });
});
