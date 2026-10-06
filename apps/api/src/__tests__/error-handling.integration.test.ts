import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { EncryptionNotConfiguredError } from "../domain/security/encryption.js";
import type { FastifyInstance } from "fastify";

// An unexpected server error (e.g. a failed SQL query) must never echo its
// internal message — the query text, table names, ids — back to the browser.
// Expected 4xx responses keep their useful, non-sensitive codes.
describe("error responses", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    app.get("/__test/boom", async () => {
      throw new Error('Failed query: select "id", "timezone" from "tenants" where "tenants"."id" = $1 params: 609c113d');
    });
    app.get("/__test/no-encryption-key", async () => {
      throw new EncryptionNotConfiguredError();
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("a 500 carries a generic message and no internal detail", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string; message?: string };
    expect(body.error).toBe("internal_error");
    expect(res.body).not.toMatch(/select|tenants|timezone|609c113d|Failed query/i);
  });

  it("a missing or changed connector encryption key is a 503 with a specific, safe code (not an anonymous 500)", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/no-encryption-key" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "encryption_not_configured" });
    expect(res.body).not.toMatch(/CONNECTOR_ENCRYPTION_KEY/);
  });

  it("an empty JSON body still gets a 400 with its specific code (not a generic 500)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
  });

  it("an unauthenticated request keeps its 401", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/session" });
    expect(res.statusCode).toBe(401);
  });
});
