import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { tenants } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// How an administrator sets a hospital's clinic hours on a real server (the seed only does it locally).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const open = ["09:00", "16:00"] as const;
const WEEK = { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: null };

describe.skipIf(!DEMO_PASSWORD)("clinic hours configuration (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  const call = (tt: TestTenant, role: Role, method: "GET" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("an admin sets the weekly hours; lookups returns them; only that hospital changes", async () => {
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/clinic-hours", { clinicHours: WEEK })).statusCode).toBe(200);
    expect((await call(t, "FRONT_DESK", "GET", "/lookups")).json().clinicHours).toEqual(WEEK);
    expect((await call(other, "FRONT_DESK", "GET", "/lookups")).json().clinicHours).toBeNull();
    const [row] = await db.select({ h: tenants.clinicHours }).from(tenants).where(eq(tenants.id, t.tenantId));
    expect(row!.h).toEqual(WEEK);
  });

  it("null clears the restriction", async () => {
    expect((await call(t, "SUPER_ADMIN", "PUT", "/clinic-hours", { clinicHours: null })).statusCode).toBe(200);
    expect((await call(t, "FRONT_DESK", "GET", "/lookups")).json().clinicHours).toBeNull();
  });

  it("front desk, coordinator and doctor cannot change them", async () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await call(t, role, "PUT", "/clinic-hours", { clinicHours: WEEK })).statusCode, role).toBe(403);
  });

  it("refuses nonsense: bad time, close before open, a missing day, extra fields", async () => {
    for (const bad of [{ ...WEEK, mon: ["9am", "16:00"] }, { ...WEEK, mon: ["16:00", "09:00"] }, { ...WEEK, mon: ["09:00", "09:00"] }, { mon: open }, { ...WEEK, tenantId: other.tenantId }]) {
      expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/clinic-hours", { clinicHours: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});
