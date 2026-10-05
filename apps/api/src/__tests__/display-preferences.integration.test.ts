import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { users } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// "My display": interface size and text size belong to the PERSON, are independent of each other, and never leak to anyone else.
describe.skipIf(!DEMO_PASSWORD)("personal display preferences: interface size and text size (integration)", () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;

  const as = (t: TestTenant, role: Role, method: "GET" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const me = async (t: TestTenant, role: Role) => ((await as(t, role, "GET", "/auth/session")).json() as { user: { interfaceSize: string; textSize: string; surfaceStyle: string } }).user;
  const put = (t: TestTenant, role: Role, body: object) => as(t, role, "PUT", "/me/preferences", body);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    a = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    b = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    await destroyTestTenant(db, a);
    await destroyTestTenant(db, b);
    await app.close();
    await queryClient.end();
  });

  it("a person who never chose reads as Comfortable + Default", async () => {
    expect(await me(a, "FRONT_DESK")).toMatchObject({ interfaceSize: "comfortable", textSize: "default" });
  });

  it("each can be changed on its own and persists; the two are independent", async () => {
    expect((await put(a, "FRONT_DESK", { interfaceSize: "compact" })).json()).toEqual({ interfaceSize: "compact", textSize: "default" });
    expect(await me(a, "FRONT_DESK")).toMatchObject({ interfaceSize: "compact", textSize: "default" });
    expect((await put(a, "FRONT_DESK", { textSize: "xlarge" })).json()).toEqual({ interfaceSize: "compact", textSize: "xlarge" }); // Compact UI with Extra large text
    expect(await me(a, "FRONT_DESK")).toMatchObject({ interfaceSize: "compact", textSize: "xlarge" });
  });

  it("it is stored for the person, so a brand-new sign-in (another device) gets the same", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: (await db.select().from(users).where(eq(users.id, a.userIds.FRONT_DESK!)))[0]!.email, password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const s = (await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } })).json() as { user: { interfaceSize: string; textSize: string } };
    expect(s.user).toMatchObject({ interfaceSize: "compact", textSize: "xlarge" });
  });

  it("one person's choice never changes a colleague's, the doctor's, or another hospital's", async () => {
    await put(a, "FRONT_DESK", { interfaceSize: "large", textSize: "large" });
    await put(a, "PATIENT_COORDINATOR", { interfaceSize: "comfortable", textSize: "default" });
    await put(a, "DOCTOR", { interfaceSize: "compact", textSize: "large" });
    expect(await me(a, "FRONT_DESK")).toMatchObject({ interfaceSize: "large", textSize: "large" });
    expect(await me(a, "PATIENT_COORDINATOR")).toMatchObject({ interfaceSize: "comfortable", textSize: "default" });
    expect(await me(a, "DOCTOR")).toMatchObject({ interfaceSize: "compact", textSize: "large" });
    expect(await me(a, "HOSPITAL_ADMIN")).toMatchObject({ interfaceSize: "comfortable", textSize: "default" }); // never chose
    expect(await me(b, "FRONT_DESK")).toMatchObject({ interfaceSize: "comfortable", textSize: "default" });
  });

  it("it is not the hospital's setting: the hospital's interface style is untouched", async () => {
    const before = (await me(a, "HOSPITAL_ADMIN")).surfaceStyle;
    await put(a, "FRONT_DESK", { interfaceSize: "compact" });
    expect((await me(a, "HOSPITAL_ADMIN")).surfaceStyle).toBe(before);
    expect((await me(b, "HOSPITAL_ADMIN")).surfaceStyle).toBe(before);
  });

  it("only bounded names are accepted, and nobody can name another person or hospital", async () => {
    for (const bad of [{ interfaceSize: "huge" }, { textSize: "tiny" }, { textSize: 18 }, {}, { interfaceSize: "large", userId: b.userIds.FRONT_DESK }, { tenantId: b.tenantId, textSize: "large" }]) {
      expect((await put(a, "FRONT_DESK", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await me(b, "FRONT_DESK")).toMatchObject({ interfaceSize: "comfortable", textSize: "default" });
  });

  it("needs a signed-in person", async () => {
    expect((await app.inject({ method: "PUT", url: "/me/preferences", payload: { textSize: "large" } })).statusCode).toBe(401);
  });
});
