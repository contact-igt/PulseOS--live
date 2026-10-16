import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// The web app calls the API cross-origin with credentials. Every method a route uses must be allowed in the
// preflight, or the browser silently blocks the call (a DELETE once failed this way).
describe("CORS preflight (integration)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("allows the methods the API uses, with credentials, for the web origin", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/crm/allocation-rules/anything", headers: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", "access-control-request-method": "DELETE" } });
    expect(res.statusCode).toBe(204);
    const methods = String(res.headers["access-control-allow-methods"]).split(",").map((m) => m.trim());
    for (const m of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]) expect(methods).toContain(m);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("content-type");
  });
});

// WEB_ORIGIN can list several web addresses (the Railway address and the custom domain). Each listed origin works for
// CORS and for the cross-origin state-change check; any other origin is refused, and the header only ever names the caller.
describe("several web origins (integration)", () => {
  const A = "https://pulseosweb-production.up.railway.app";
  const B = "https://pulseos.invictusglobaltech.com";
  let app: FastifyInstance;
  let previous: string | undefined;
  beforeAll(async () => {
    previous = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = ` ${A}/ , ${B} `;
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previous;
    await app.close();
    await queryClient.end();
  });

  const preflight = (origin: string) => app.inject({ method: "OPTIONS", url: "/auth/login", headers: { origin, "access-control-request-method": "POST" } });
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/auth/logout", headers });

  it("answers each listed origin with that origin, credentials allowed, and varies on Origin", async () => {
    for (const o of [A, B]) {
      const res = await preflight(o);
      expect(res.statusCode, o).toBe(204);
      expect(res.headers["access-control-allow-origin"], o).toBe(o);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(res.headers.vary).toLowerCase()).toContain("origin");
    }
  });

  it("gives an unlisted origin no CORS permission", async () => {
    const res = await preflight("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("lets a state-changing request from either listed origin through, and blocks the rest", async () => {
    for (const o of [A, B]) expect((await post({ origin: o, "sec-fetch-site": "same-site" })).statusCode, o).not.toBe(403);
    const blocked = await post({ origin: "https://evil.example" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("cross_origin_request_blocked");
    expect((await post({ origin: `${B}.evil.com` })).statusCode).toBe(403);
  });
});
