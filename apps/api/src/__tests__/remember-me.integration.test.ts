import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const PW = process.env.DEMO_PASSWORD;

describe.skipIf(!PW)("login: Remember me", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  beforeAll(async () => { app = await buildApp(); await app.ready(); t = await createTestTenant(db, app, "BETA_V1_CORE", PW!); });
  afterAll(async () => { await destroyTestTenant(db, t); await app.close(); await queryClient.end(); });

  async function login(remember?: boolean) {
    const [u] = await db.select().from(users).where(eq(users.id, t.userIds.FRONT_DESK!));
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: u!.email, password: PW, ...(remember === undefined ? {} : { remember }) } });
    expect(res.statusCode).toBe(200);
    const [s] = await db.select().from(sessions).where(eq(sessions.userId, u!.id)).orderBy(desc(sessions.createdAt)).limit(1);
    return { cookie: res.cookies.find((c) => c.name === "pulseos_session")!, hours: (s!.expiresAt.getTime() - Date.now()) / 3_600_000 };
  }

  it("off (default): a browser-session cookie and a 12-hour server session", async () => {
    for (const r of [undefined, false]) {
      const { cookie, hours } = await login(r);
      expect(cookie.expires).toBeUndefined();
      expect(hours).toBeGreaterThan(11.5);
      expect(hours).toBeLessThan(12.1);
    }
  });

  it("on: a persistent cookie and a 7-day server session", async () => {
    const { cookie, hours } = await login(true);
    expect(cookie.expires).toBeInstanceOf(Date);
    expect(hours).toBeGreaterThan(167);
    expect(hours).toBeLessThan(168.1);
  });
});
