import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CapabilityMap, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("tenant capabilities (integration)", () => {
  let app: FastifyInstance;
  let v1: TestTenant;
  let v2: TestTenant;
  let v1b: TestTenant;
  const call = (t: TestTenant, role: Role, method: "GET" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const put = (t: TestTenant, role: Role, key: string, enabled: boolean | null) => call(t, role, "PUT", `/capabilities/${key}`, { enabled });
  const session = async (t: TestTenant, role: Role) => ((await call(t, role, "GET", "/auth/session")).json() as { user: { capabilities: CapabilityMap } }).user.capabilities;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    v1 = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    v1b = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    v2 = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    for (const t of [v1, v1b, v2]) await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("core analytics works in V1 and V2 (and cannot be switched off)", async () => {
    for (const t of [v1, v2]) expect((await call(t, "HOSPITAL_ADMIN", "GET", "/reports/operations")).statusCode).toBe(200);
    const off = await put(v1, "SUPER_ADMIN", "ANALYTICS_CORE", false);
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe("locked");
  });

  it("the session carries the effective capabilities, and every signed-in role can read the list", async () => {
    expect((await session(v1, "FRONT_DESK")).MARKETING_ANALYTICS).toBe(false);
    expect((await session(v2, "FRONT_DESK")).MARKETING_ANALYTICS).toBe(true);
    const list = (await call(v1, "FRONT_DESK", "GET", "/capabilities")).json() as { edition: string; capabilities: { key: string; enabled: boolean; editable: boolean }[] };
    expect(list.edition).toBe("BETA_V1_CORE");
    expect(list.capabilities.every((c) => c.editable === false)).toBe(true); // Staff read, never edit
  });

  it("V1: marketing is off by default; a Super Admin switches it on → API and session follow; switching back blocks again", async () => {
    expect((await call(v1, "HOSPITAL_ADMIN", "GET", "/analytics/summary")).statusCode).toBe(403);
    expect((await call(v1, "HOSPITAL_ADMIN", "GET", "/analytics/summary")).json().error).toBe("feature_not_available");
    expect((await put(v1, "SUPER_ADMIN", "MARKETING_ANALYTICS", true)).statusCode).toBe(200);
    expect((await call(v1, "HOSPITAL_ADMIN", "GET", "/analytics/summary")).statusCode).toBe(200);
    expect((await session(v1, "HOSPITAL_ADMIN")).MARKETING_ANALYTICS).toBe(true);
    expect((await put(v1, "SUPER_ADMIN", "MARKETING_ANALYTICS", null)).statusCode).toBe(200); // back to the edition default
    expect((await call(v1, "HOSPITAL_ADMIN", "GET", "/analytics/summary")).statusCode).toBe(403);
  });

  it("V2: marketing is on by default; switching it off blocks the API", async () => {
    expect((await call(v2, "HOSPITAL_ADMIN", "GET", "/analytics/summary")).statusCode).toBe(200);
    // Spend attribution, campaigns and the ad providers depend on marketing analytics, so they go first.
    expect((await put(v2, "SUPER_ADMIN", "MARKETING_ANALYTICS", false)).statusCode).toBe(409);
    for (const k of ["SPEND_ATTRIBUTION", "CAMPAIGNS", "GOOGLE_ADS", "META_ADS"]) expect((await put(v2, "SUPER_ADMIN", k, false)).statusCode).toBe(200);
    expect((await put(v2, "SUPER_ADMIN", "MARKETING_ANALYTICS", false)).statusCode).toBe(200);
    expect((await call(v2, "HOSPITAL_ADMIN", "GET", "/analytics/summary")).statusCode).toBe(403);
    // Core analytics is untouched.
    expect((await call(v2, "HOSPITAL_ADMIN", "GET", "/reports/operations")).statusCode).toBe(200);
    for (const k of ["MARKETING_ANALYTICS", "SPEND_ATTRIBUTION", "CAMPAIGNS", "GOOGLE_ADS", "META_ADS"]) await put(v2, "SUPER_ADMIN", k, null);
  });

  it("one tenant's switches never touch another tenant", async () => {
    expect((await put(v1, "SUPER_ADMIN", "MARKETING_ANALYTICS", true)).statusCode).toBe(200);
    expect((await put(v1, "SUPER_ADMIN", "GOOGLE_ADS", true)).statusCode).toBe(200);
    expect((await session(v1b, "HOSPITAL_ADMIN")).GOOGLE_ADS).toBe(false);
    expect((await session(v1, "HOSPITAL_ADMIN")).GOOGLE_ADS).toBe(true);
    await put(v1, "SUPER_ADMIN", "GOOGLE_ADS", null);
    await put(v1, "SUPER_ADMIN", "MARKETING_ANALYTICS", null);
  });

  it("who may switch what: Staff and Doctor never; Admin only the operational ones; Super Admin all", async () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await put(v1, role, "SMS_NOTIFICATIONS", true)).statusCode, role).toBe(403);
    expect((await put(v1, "HOSPITAL_ADMIN", "MARKETING_ANALYTICS", true)).statusCode).toBe(403);
    expect((await put(v1, "HOSPITAL_ADMIN", "WHATSAPP_NOTIFICATIONS", false)).statusCode).toBe(200);
    expect((await session(v1, "HOSPITAL_ADMIN")).WHATSAPP_NOTIFICATIONS).toBe(false);
    await put(v1, "HOSPITAL_ADMIN", "WHATSAPP_NOTIFICATIONS", null);
    const adminList = (await call(v1, "HOSPITAL_ADMIN", "GET", "/capabilities")).json() as { capabilities: { key: string; editable: boolean }[] };
    expect(adminList.capabilities.filter((c) => c.editable).map((c) => c.key).sort()).toEqual(["CCS_IVR", "SMS_NOTIFICATIONS", "WHATSAPP_NOTIFICATIONS"]); // the operational switches an Admin may flip
    expect((await put(v1, "SUPER_ADMIN", "NOT_A_THING", true)).statusCode).toBe(404);
  });

  it("the inbox and conversation intelligence are gated separately, and notifications do not need the inbox", async () => {
    // V1: inbox off, notifications on.
    expect((await session(v1, "FRONT_DESK")).WHATSAPP_NOTIFICATIONS).toBe(true);
    expect((await call(v1, "FRONT_DESK", "GET", "/conversations")).statusCode).toBe(403);
    expect((await call(v1, "FRONT_DESK", "GET", "/conversations")).json().capability).toBe("WHATSAPP_INBOX");
    // Conversation intelligence cannot be switched on without the inbox …
    const bad = await put(v1, "SUPER_ADMIN", "CONVERSATION_INTELLIGENCE", true);
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ error: "requires", capabilities: ["WHATSAPP_INBOX"] });
    // … with the inbox on but intelligence off, the inbox works and the summary API stays blocked.
    expect((await put(v1, "SUPER_ADMIN", "WHATSAPP_INBOX", true)).statusCode).toBe(200);
    expect((await call(v1, "FRONT_DESK", "GET", "/conversations")).statusCode).toBe(200);
    expect((await call(v1, "FRONT_DESK", "GET", "/settings/conversation")).statusCode).toBe(403);
    expect((await put(v1, "SUPER_ADMIN", "CONVERSATION_INTELLIGENCE", true)).statusCode).toBe(200);
    expect((await call(v1, "FRONT_DESK", "GET", "/settings/conversation")).statusCode).toBe(200);
    // And the dependency protects the other way round.
    expect((await put(v1, "SUPER_ADMIN", "WHATSAPP_INBOX", false)).json().error).toBe("required_by");
    await put(v1, "SUPER_ADMIN", "CONVERSATION_INTELLIGENCE", null);
    await put(v1, "SUPER_ADMIN", "WHATSAPP_INBOX", null);
  });
});
