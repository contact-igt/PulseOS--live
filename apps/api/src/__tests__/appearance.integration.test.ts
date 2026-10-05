import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { tenants } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// Settings > Appearance: ONE controlled, per-hospital preference (how solid the interface surfaces are). The server is the
// source of truth: it rides in the session payload, a hospital without a value reads as "balanced", and only an admin saves it.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("tenant appearance (integration)", () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;
  const call = (tt: TestTenant, role: Role, method: "GET" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const style = async (tt: TestTenant, role: Role = "FRONT_DESK") => ((await call(tt, role, "GET", "/auth/session")).json() as { user: { surfaceStyle: string } }).user.surfaceStyle;

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

  it("a hospital with no saved value reads as Balanced (existing tenants need no migration of data)", async () => {
    const [row] = await db.select({ s: tenants.surfaceStyle }).from(tenants).where(eq(tenants.id, a.tenantId));
    expect(row!.s).toBeNull();
    expect(await style(a)).toBe("balanced");
  });

  it("a Super Admin and a Hospital Admin can save it; everyone in that hospital then reads it", async () => {
    expect((await call(a, "SUPER_ADMIN", "PUT", "/appearance", { surfaceStyle: "solid" })).statusCode).toBe(200);
    expect(await style(a, "FRONT_DESK")).toBe("solid");
    expect(await style(a, "DOCTOR")).toBe("solid");
    expect((await call(a, "HOSPITAL_ADMIN", "PUT", "/appearance", { surfaceStyle: "airy" })).statusCode).toBe(200);
    expect(await style(a, "PATIENT_COORDINATOR")).toBe("airy");
  });

  it("it is per hospital: changing one never changes the other", async () => {
    await call(a, "SUPER_ADMIN", "PUT", "/appearance", { surfaceStyle: "solid" });
    expect(await style(a)).toBe("solid");
    expect(await style(b)).toBe("balanced");
    await call(b, "SUPER_ADMIN", "PUT", "/appearance", { surfaceStyle: "airy" });
    expect(await style(b)).toBe("airy");
    expect(await style(a)).toBe("solid");
  });

  it("front desk, coordinator and doctor cannot change it", async () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await call(a, role, "PUT", "/appearance", { surfaceStyle: "airy" })).statusCode, role).toBe(403);
    expect(await style(a)).toBe("solid");
  });

  it("only the three named styles are accepted (no free-form values), and no tenant id is read from the body", async () => {
    for (const bad of [{ surfaceStyle: "glass" }, { surfaceStyle: 40 }, { surfaceStyle: "" }, {}, { surfaceStyle: "solid", tenantId: b.tenantId }, { opacity: 0.2 }]) {
      expect((await call(a, "SUPER_ADMIN", "PUT", "/appearance", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await style(b)).toBe("airy"); // untouched by the attempt that named b's tenant id
  });
});
