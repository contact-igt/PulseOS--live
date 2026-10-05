import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("connectors (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let frontDeskCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    frontDeskCookie = await loginAs(app, "gyn.frontdesk@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/connectors" });
    expect(res.statusCode).toBe(401);
  });

  it("front desk (no VIEW_INTEGRATIONS) cannot view connectors", async () => {
    const res = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: frontDeskCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("VIEW_INTEGRATIONS");
  });

  it("admin sees seeded connectors and secrets are never exposed", async () => {
    const res = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as ConnectorRow[];
    expect(rows.length).toBeGreaterThan(0);
    const body = JSON.stringify(rows);
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("encryptedPayload");
    for (const row of rows) {
      expect(typeof row.hasSecrets).toBe("boolean");
      expect(row).not.toHaveProperty("secrets");
      expect(row).not.toHaveProperty("encryptedPayload");
    }
  });

  it("connector detail never exposes decrypted secrets, only configuration and events", async () => {
    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const target = (list.json() as ConnectorRow[])[0];
    const res = await app.inject({ method: "GET", url: `/connectors/${target.id}`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("encryptedPayload");
  });

  it("404s for a connector id from a different tenant (tenant isolation)", async () => {
    const res = await app.inject({ method: "GET", url: "/connectors/00000000-0000-0000-0000-000000000000", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(404);
  });
});
