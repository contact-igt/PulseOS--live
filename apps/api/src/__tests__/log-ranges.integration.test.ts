import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Activity log and Integration logs take hospital-day ranges. A malformed, half-given or inverted range is a 400 -
// it must never silently turn into "show everything".

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("log date ranges (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  const get = (url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

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

  it.each([
    ["a malformed date", "from=yesterday&to=today"],
    ["an impossible date", "from=2026-02-31&to=2026-03-01"],
    ["only a start", "from=2026-09-01"],
    ["only an end", "to=2026-09-01"],
    ["an inverted range", "from=2026-09-10&to=2026-09-01"],
    ["a range over a year", "from=2024-01-01&to=2026-01-01"],
  ])("rejects %s with 400", async (_n, query) => {
    expect((await get(`/activity-log?${query}`)).statusCode, `activity ${query}`).toBe(400);
    expect((await get(`/integrations/logs?${query}`)).statusCode, `integration ${query}`).toBe(400);
  });

  it("accepts a valid range, and no range at all", async () => {
    for (const q of ["", "?from=2026-09-01&to=2026-09-30", "?from=2026-10-03&to=2026-10-03"]) {
      expect((await get(`/activity-log${q}`)).statusCode, `activity ${q}`).toBe(200);
      expect((await get(`/integrations/logs${q}`)).statusCode, `integration ${q}`).toBe(200);
    }
  });
});
