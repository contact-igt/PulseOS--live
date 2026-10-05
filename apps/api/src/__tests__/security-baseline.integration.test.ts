import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Web-security baseline for the API: a state-changing request must come from the app's own origin, responses carry
// the standard hardening headers, and the passwordless developer sign-in only answers on the loopback interface.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

describe.skipIf(!DEMO_PASSWORD)("API security baseline (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  // No cookie: the origin check runs before authentication, and a successful logout would end the shared test session.
  const post = (headers: Record<string, string>, url = "/auth/logout") => app.inject({ method: "POST", url, headers });

  describe("cross-origin state changes", () => {
    it("rejects a state-changing request from a foreign Origin", async () => {
      const res = await post({ origin: "https://evil.example" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("cross_origin_request_blocked");
    });

    it("rejects a cross-site fetch that carries no Origin", async () => {
      const res = await post({ "sec-fetch-site": "cross-site" });
      expect(res.statusCode).toBe(403);
    });

    it("rejects a same-site but cross-origin request (a sibling subdomain or port)", async () => {
      const res = await post({ origin: "http://localhost:9999", "sec-fetch-site": "same-site" });
      expect(res.statusCode).toBe(403);
    });

    it("allows the app's own origin", async () => {
      const res = await post({ origin: WEB_ORIGIN, "sec-fetch-site": "same-site" });
      expect(res.statusCode).not.toBe(403);
    });

    it("allows a non-browser client that sends neither header (server-to-server, tests)", async () => {
      const res = await post({});
      expect(res.statusCode).not.toBe(403);
    });

    it("does not touch reads", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/session", headers: { origin: "https://evil.example" }, cookies: { pulseos_session: cookie } });
      expect(res.statusCode).not.toBe(403);
    });

    it("leaves provider webhooks and the public website form to their own authentication", async () => {
      const hook = await app.inject({ method: "POST", url: "/webhooks/meta/00000000-0000-4000-8000-000000000000", headers: { origin: "https://graph.facebook.com" }, payload: {} });
      expect(hook.statusCode).not.toBe(403);
      const form = await app.inject({ method: "POST", url: "/forms/website/00000000-0000-4000-8000-000000000000", headers: { origin: "https://hospital-site.example" }, payload: {} });
      expect(form.statusCode).not.toBe(403);
    });
  });

  describe("response headers", () => {
    it("sets nosniff, no-referrer, no framing and a locked-down CSP on API responses", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    });

    it("does not cache authenticated JSON", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } });
      expect(String(res.headers["cache-control"])).toContain("no-store");
    });
  });

  describe("developer sign-in", () => {
    it("never mints a session for a non-loopback caller", async () => {
      const res = await app.inject({ method: "POST", url: "/auth/dev-login", remoteAddress: "203.0.113.9", payload: { role: "HOSPITAL_ADMIN" } });
      expect([403, 404]).toContain(res.statusCode);
      expect(res.cookies.find((c) => c.name === "pulseos_session")).toBeUndefined();
    });
  });
});
