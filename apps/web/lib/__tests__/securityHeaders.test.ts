// @vitest-environment node
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

async function headers(): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!();
  return Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
}
const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

describe("security headers", () => {
  it("lets the Inbox show photos served by the PulseOS API (and template header images), and play its audio and video", async () => {
    const csp = (await headers())["Content-Security-Policy"]!;
    expect(directive(csp, "img-src")).toContain("http://localhost:4310");
    expect(directive(csp, "img-src")).toContain("https:");
    expect(directive(csp, "media-src")).toContain("http://localhost:4310");
    expect(directive(csp, "media-src")).toContain("https:");
    // still local-only sources otherwise
    expect(directive(csp, "img-src")).toContain("'self'");
  });

  it("allows this app, and only this app, to use the microphone (voice messages); everything else stays off", async () => {
    const policy = (await headers())["Permissions-Policy"]!;
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("geolocation=()");
    expect(policy).toContain("payment=()");
  });

  it("keeps the rest of the policy closed", async () => {
    const h = await headers();
    const csp = h["Content-Security-Policy"]!;
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "script-src")).not.toContain("https:");
    expect(directive(csp, "connect-src")).not.toContain("https:");
    expect(h["X-Frame-Options"]).toBe("DENY");
  });
});
