import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { tenants, users } from "../db/schema.js";
import { hashPassword } from "../domain/auth/auth.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The dedicated pilot login (/login/namokar-v1 -> POST /auth/login/tenant/:slug) signs people into ONE hospital and nothing else:
// the tenant comes from the route's slug on the server, never from anything the person can choose or the body can carry.
describe.skipIf(!DEMO_PASSWORD)("tenant-branded login (integration)", () => {
  let app: FastifyInstance;
  let pilot: TestTenant;
  let other: TestTenant;
  const slug = `pilot-${randomUUID().slice(0, 8)}`;
  const sharedEmail = `shared-${randomUUID().slice(0, 8)}@pilot-test.local`;
  const pilotPassword = `${DEMO_PASSWORD}-pilot`;
  const otherPassword = `${DEMO_PASSWORD}-other`;
  const emailOf = (t: TestTenant, role: "SUPER_ADMIN" | "FRONT_DESK") => db.select({ email: users.email }).from(users).where(eq(users.id, t.userIds[role]!)).then((r) => r[0]!.email);

  const login = (s: string, payload: object) => app.inject({ method: "POST", url: `/auth/login/tenant/${s}`, payload });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    pilot = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await db.update(tenants).set({ loginSlug: slug, name: "Pilot Test Hospital" }).where(eq(tenants.id, pilot.tenantId));
    // The SAME email exists in both hospitals with different passwords: the route's tenant decides which one signs in.
    await db.update(users).set({ email: sharedEmail, passwordHash: await hashPassword(pilotPassword) }).where(eq(users.id, pilot.userIds.FRONT_DESK!));
    await db.update(users).set({ email: sharedEmail, passwordHash: await hashPassword(otherPassword) }).where(eq(users.id, other.userIds.FRONT_DESK!));
  });
  afterAll(async () => {
    for (const t of [pilot, other]) await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("publishes only display words for the branded page, and nothing for an unknown slug", async () => {
    const ok = await app.inject({ method: "GET", url: `/auth/tenants/${slug}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ slug, displayName: "Pilot Test Hospital" });
    expect((await app.inject({ method: "GET", url: "/auth/tenants/no-such-hospital" })).statusCode).toBe(404);
    // A hospital that has no login slug is unreachable by name.
    expect((await app.inject({ method: "GET", url: `/auth/tenants/${other.tenantId}` })).statusCode).toBe(404);
  });

  it("signs in a user of that hospital, with a session for that hospital", async () => {
    const res = await login(slug, { email: await emailOf(pilot, "SUPER_ADMIN"), password: DEMO_PASSWORD, remember: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ tenantId: pilot.tenantId, role: "SUPER_ADMIN", tenantName: "Pilot Test Hospital" });
    expect(res.cookies.find((c) => c.name === "pulseos_session")).toBeTruthy();
  });

  it("resolves a shared email inside the route's hospital, by that hospital's password", async () => {
    const mine = await login(slug, { email: sharedEmail, password: pilotPassword });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().user.tenantId).toBe(pilot.tenantId);
    // The other hospital's password for the same email does NOT work here.
    expect((await login(slug, { email: sharedEmail, password: otherPassword })).statusCode).toBe(401);
  });

  it("never signs in a user of a different hospital, and does not say why", async () => {
    const foreign = await login(slug, { email: await emailOf(other, "SUPER_ADMIN"), password: DEMO_PASSWORD });
    const wrong = await login(slug, { email: await emailOf(pilot, "SUPER_ADMIN"), password: "definitely-wrong" });
    const unknownUser = await login(slug, { email: "nobody@pilot-test.local", password: "x" });
    for (const r of [foreign, wrong, unknownUser]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "invalid_credentials" });
      expect(r.cookies.find((c) => c.name === "pulseos_session")).toBeUndefined();
    }
  });

  it("ignores a tenant id smuggled in the body, and an unknown slug behaves like bad credentials", async () => {
    const smuggled = await login(slug, { email: await emailOf(other, "SUPER_ADMIN"), password: DEMO_PASSWORD, tenantId: other.tenantId });
    expect(smuggled.statusCode).toBe(400); // strict body: unknown keys are refused, not honoured
    const unknown = await login("no-such-hospital", { email: await emailOf(pilot, "SUPER_ADMIN"), password: DEMO_PASSWORD });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: "invalid_credentials" });
  });

  it("a hospital without a login slug cannot be signed into through this route (sign-up and dev tenants stay out)", async () => {
    const res = await login(other.tenantId, { email: await emailOf(other, "SUPER_ADMIN"), password: DEMO_PASSWORD });
    expect(res.statusCode).toBe(401);
  });

  it("slugs are lower-case words only and unique", async () => {
    await expect(db.update(tenants).set({ loginSlug: slug }).where(eq(tenants.id, other.tenantId))).rejects.toThrow();
    await expect(db.execute(sql`update tenants set login_slug = 'Bad Slug!' where id = ${other.tenantId}::uuid`)).rejects.toThrow();
  });

  it("failed attempts are throttled per hospital + account", async () => {
    const email = await emailOf(pilot, "SUPER_ADMIN");
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login(slug, { email, password: `wrong-${i}` })).statusCode;
    expect(last).toBe(429);
  });
});
