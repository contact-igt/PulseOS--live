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
