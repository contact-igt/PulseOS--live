import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role, SpecialtyTemplateVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { specialtyTemplates, tasks } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { serviceKeyFrom } from "../domain/specialty/specialty.service.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// A hospital adds the services it offers; nothing in the code knows any service by name.
describe("service keys", () => {
  it("are stable, upper-case words", () => {
    expect(serviceKeyFrom(" Laser Vision Correction ")).toBe("LASER_VISION_CORRECTION");
    expect(serviceKeyFrom("Glaucoma check-up!")).toBe("GLAUCOMA_CHECK_UP");
    expect(serviceKeyFrom("!!!")).toBe("");
  });
});

describe.skipIf(!DEMO_PASSWORD)("add a service (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  const as = (tt: TestTenant, role: Role, method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const offered = async (tt: TestTenant) => ((await as(tt, "FRONT_DESK", "GET", "/specialties")).json() as SpecialtyTemplateVm[]).map((s) => s.displayName);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    for (const tt of [t, other]) {
      await db.delete(tasks).where(eq(tasks.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  it("an admin adds a service; it is offered to Add Lead at once and a lead can be created for it; another hospital never sees it", async () => {
    const res = await as(t, "HOSPITAL_ADMIN", "POST", "/specialties", { displayName: "Glaucoma Check" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ key: "GLAUCOMA_CHECK", displayName: "Glaucoma Check", defaultJourneyType: "Glaucoma Check", enabled: true, fieldCount: 0 });
    expect(await offered(t)).toContain("Glaucoma Check");
    expect(await offered(other)).not.toContain("Glaucoma Check");
    const lead = await as(t, "FRONT_DESK", "POST", "/leads", { phone: "+919600077001", name: "Service Test", specialtyKey: "GLAUCOMA_CHECK", branchId: t.branchId, journeyType: "Glaucoma Check", sourceKey: "google", customFieldValues: {} });
    expect(lead.statusCode, JSON.stringify(lead.json())).toBe(201);
  });

  it("the service can have its own CRM field, and be switched off without losing history", async () => {
    const field = await as(t, "HOSPITAL_ADMIN", "POST", "/crm/fields", { specialtyKey: "GLAUCOMA_CHECK", key: "eye_pressure_known", label: "Eye pressure known", fieldType: "BOOLEAN", placements: ["add_lead"] });
    expect(field.statusCode).toBe(201);
    expect(((await as(t, "FRONT_DESK", "GET", "/specialties/GLAUCOMA_CHECK/fields")).json() as { key: string }[]).map((f) => f.key)).toContain("eye_pressure_known");
    const off = await app.inject({ method: "PATCH", url: "/specialties/GLAUCOMA_CHECK", cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! }, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(await offered(t)).not.toContain("Glaucoma Check");
    expect((await db.select().from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, t.tenantId), eq(specialtyTemplates.key, "GLAUCOMA_CHECK")))).length).toBe(1);
  });

  it("a duplicate name (any case) is refused; a clashing key gets a numbered key; bad input is refused", async () => {
    expect((await as(t, "HOSPITAL_ADMIN", "POST", "/specialties", { displayName: "glaucoma check" })).statusCode).toBe(409);
    const a = await as(t, "HOSPITAL_ADMIN", "POST", "/specialties", { displayName: "Dry Eye" });
    const b = await as(t, "HOSPITAL_ADMIN", "POST", "/specialties", { displayName: "Dry-Eye" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().key).toBe("DRY_EYE_2");
    for (const bad of [{ displayName: "" }, { displayName: "x".repeat(61) }, { displayName: "OK", tenantId: other.tenantId }, { displayName: "!!!" }]) {
      expect((await as(t, "HOSPITAL_ADMIN", "POST", "/specialties", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("only an administrator may add a service", async () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect((await as(t, role, "POST", "/specialties", { displayName: `Nope ${role}` })).statusCode, role).toBe(403);
  });
});
