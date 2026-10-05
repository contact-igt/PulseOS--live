import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DepartmentVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { customFieldDefinitions, departments, journeys, specialtyTemplates, treatmentDefinitions } from "../db/schema.js";
import { DEPARTMENT_TEMPLATES } from "../domain/specialty/department-templates.js";
import { OPHTHALMOLOGY_SPECIALTIES } from "../domain/specialty/ophthalmology.templates.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("departments, template install and field origin (integration)", () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;
  const call = (t: TestTenant, role: "HOSPITAL_ADMIN" | "FRONT_DESK" | "SUPER_ADMIN", method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const counts = async (t: TestTenant) => ({
    departments: (await db.select().from(departments).where(eq(departments.tenantId, t.tenantId))).length,
    services: (await db.select().from(specialtyTemplates).where(eq(specialtyTemplates.tenantId, t.tenantId))).length,
    fields: (await db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.tenantId, t.tenantId))).length,
    treatments: (await db.select().from(treatmentDefinitions).where(eq(treatmentDefinitions.tenantId, t.tenantId))).length,
  });

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

  it("a new tenant has no departments; the global templates are offered, none installed", async () => {
    expect(((await call(a, "HOSPITAL_ADMIN", "GET", "/departments")).json() as DepartmentVm[])).toEqual([]);
    const templates = (await call(a, "HOSPITAL_ADMIN", "GET", "/department-templates")).json() as { key: string; installed: boolean; services: string[] }[];
    expect(templates.map((t) => t.key).sort()).toEqual(DEPARTMENT_TEMPLATES.map((t) => t.key).sort());
    expect(templates.every((t) => !t.installed)).toBe(true);
    expect(templates.find((t) => t.key === "ophthalmology")!.services).toEqual(expect.arrayContaining(["Cataract", "Laser Vision Correction", "Keratoconus", "Oculoplasty", "Squint", "General Eye Consultation", "Other"]));
  });

  it("installing Ophthalmology creates a tenant-owned department with its services, TEMPLATE fields and treatment catalogue", async () => {
    const res = await call(a, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toBe(true);

    const deps = (await call(a, "HOSPITAL_ADMIN", "GET", "/departments")).json() as DepartmentVm[];
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ key: "OPHTHALMOLOGY", displayName: "Ophthalmology", templateKey: "ophthalmology", archived: false });
    expect(deps[0]!.services.map((s) => s.displayName)).toEqual(
      expect.arrayContaining(["Cataract", "Laser Vision Correction", "Keratoconus", "Oculoplasty", "Squint", "General Eye Consultation", "Other"]),
    );

    const fields = await db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.tenantId, a.tenantId));
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.origin === "TEMPLATE")).toBe(true);
    expect((await counts(a)).treatments).toBeGreaterThan(0);
  });

  it("install is idempotent: running it again (even concurrently) adds nothing and reports it was already there", async () => {
    const before = await counts(a);
    const again = await Promise.all([1, 2, 3].map(() => call(a, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" })));
    for (const res of again) {
      expect(res.statusCode).toBe(200);
      expect(res.json().created).toBe(false);
    }
    expect(await counts(a)).toEqual(before);
  });

  it("an unknown template is a 404 and a malformed request a 400", async () => {
    expect((await call(a, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "nope" })).statusCode).toBe(404);
    expect((await call(a, "HOSPITAL_ADMIN", "POST", "/departments/install", {})).statusCode).toBe(400);
  });

  it("a hospital customizing its copy never changes another tenant or the global template", async () => {
    // Tenant A renames a service and archives a template field.
    const cataract = (await db.select().from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, a.tenantId), eq(specialtyTemplates.key, "CATARACT"))))[0]!;
    expect((await call(a, "HOSPITAL_ADMIN", "PATCH", "/specialties/CATARACT", { displayName: "Cataract & IOL" })).statusCode).toBe(200);
    const diabetes = (await db.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, a.tenantId), eq(customFieldDefinitions.specialtyKey, "CATARACT"), eq(customFieldDefinitions.key, "diabetes"))))[0]!;
    expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${diabetes.id}`, { archived: true })).statusCode).toBe(200);

    // Tenant B installs afterwards: pristine.
    await call(b, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    const bCataract = (await db.select().from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, b.tenantId), eq(specialtyTemplates.key, "CATARACT"))))[0]!;
    expect(bCataract.displayName).toBe("Cataract");
    expect(bCataract.id).not.toBe(cataract.id);
    const bDiabetes = (await db.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, b.tenantId), eq(customFieldDefinitions.specialtyKey, "CATARACT"), eq(customFieldDefinitions.key, "diabetes"))))[0]!;
    expect(bDiabetes.archived).toBe(false);
    expect(bDiabetes.id).not.toBe(diabetes.id);

    // The global definition is untouched.
    expect(OPHTHALMOLOGY_SPECIALTIES.find((s) => s.key === "CATARACT")!.displayName).toBe("Cataract");
  });

  it("re-installing never undoes the hospital's own changes (rename and archive survive)", async () => {
    await call(a, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    const cataract = (await db.select().from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, a.tenantId), eq(specialtyTemplates.key, "CATARACT"))))[0]!;
    expect(cataract.displayName).toBe("Cataract & IOL");
    const diabetes = (await db.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, a.tenantId), eq(customFieldDefinitions.specialtyKey, "CATARACT"), eq(customFieldDefinitions.key, "diabetes"))))[0]!;
    expect(diabetes.archived).toBe(true);
  });

  it("only Admin / Super Admin can install or archive; every role can read the departments", async () => {
    expect((await call(a, "FRONT_DESK", "POST", "/departments/install", { templateKey: "gynecology" })).statusCode).toBe(403);
    expect((await call(a, "FRONT_DESK", "GET", "/department-templates")).statusCode).toBe(403);
    expect((await call(a, "FRONT_DESK", "GET", "/departments")).statusCode).toBe(200);
    expect((await call(a, "SUPER_ADMIN", "POST", "/departments/install", { templateKey: "gynecology" })).statusCode).toBe(201);
  });

  it("one tenant cannot see or change another tenant's departments", async () => {
    const aDep = (await db.select().from(departments).where(eq(departments.tenantId, a.tenantId)))[0]!;
    expect((await call(b, "HOSPITAL_ADMIN", "PATCH", `/departments/${aDep.id}`, { displayName: "Hijacked" })).statusCode).toBe(404);
    expect((await call(b, "HOSPITAL_ADMIN", "GET", "/departments")).json().map((d: DepartmentVm) => d.id)).not.toContain(aDep.id);
    expect((await db.select().from(departments).where(eq(departments.id, aDep.id)))[0]!.displayName).not.toBe("Hijacked");
  });

  it("a new journey records its department; archiving the department hides its services for new work but old journeys stay readable", async () => {
    const lead = await call(a, "HOSPITAL_ADMIN", "POST", "/leads", { name: "Dept Test", phone: "+919811100001", specialtyKey: "CATARACT", branchId: a.branchId, sourceKey: "google", journeyType: "Cataract", customFieldValues: {} });
    expect(lead.statusCode).toBe(201);
    const journeyId = lead.json().journeyId as string;
    const ophth = (await db.select().from(departments).where(and(eq(departments.tenantId, a.tenantId), eq(departments.key, "OPHTHALMOLOGY"))))[0]!;
    expect((await db.select().from(journeys).where(eq(journeys.id, journeyId)))[0]!.departmentId).toBe(ophth.id);

    expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/departments/${ophth.id}`, { archived: true })).statusCode).toBe(200);
    const offered = (await call(a, "HOSPITAL_ADMIN", "GET", "/specialties")).json() as { key: string }[];
    expect(offered.map((s) => s.key)).not.toContain("CATARACT");
    expect(offered.map((s) => s.key)).toContain("GYNECOLOGY"); // another department is unaffected
    expect((await call(a, "HOSPITAL_ADMIN", "GET", `/journeys/${journeyId}`)).statusCode).toBe(200);
    expect((await call(a, "HOSPITAL_ADMIN", "GET", `/journeys/${journeyId}`)).json().journey.departmentName).toBe("Ophthalmology");

    expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/departments/${ophth.id}`, { archived: false })).statusCode).toBe(200);
    expect(((await call(a, "HOSPITAL_ADMIN", "GET", "/specialties")).json() as { key: string }[]).map((s) => s.key)).toContain("CATARACT");
  });

  describe("field origin: SYSTEM / TEMPLATE / CUSTOM", () => {
    it("a field a hospital creates is CUSTOM, even if the request claims otherwise", async () => {
      const res = await call(a, "HOSPITAL_ADMIN", "POST", "/crm/fields", { specialtyKey: "*", key: "preferred_language_note", label: "Preferred language", fieldType: "TEXT", origin: "SYSTEM" });
      // Unknown keys are ignored (or refused) — what matters is the stored origin.
      expect([201, 400]).toContain(res.statusCode);
      if (res.statusCode === 201) expect(res.json().origin).toBe("CUSTOM");
    });

    it("a TEMPLATE field can be customized and archived by the hospital, and its history survives the archive", async () => {
      const lead = await call(a, "HOSPITAL_ADMIN", "POST", "/leads", { name: "Origin Test", phone: "+919811100002", specialtyKey: "GENERAL_EYE_CONSULTATION", branchId: a.branchId, sourceKey: "google", journeyType: "General", customFieldValues: { primary_eye_concern: "Blurred vision" } });
      expect(lead.statusCode).toBe(201);
      const journeyId = lead.json().journeyId as string;
      const field = (await db.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, a.tenantId), eq(customFieldDefinitions.specialtyKey, "GENERAL_EYE_CONSULTATION"), eq(customFieldDefinitions.key, "primary_eye_concern"))))[0]!;
      expect(field.origin).toBe("TEMPLATE");
      expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${field.id}`, { label: "Main eye complaint" })).json().origin).toBe("TEMPLATE");
      expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${field.id}`, { archived: true })).statusCode).toBe(200);
      // The stored value is still there and the old journey still renders it.
      const detail = (await call(a, "HOSPITAL_ADMIN", "GET", `/journeys/${journeyId}`)).json();
      expect(JSON.stringify(detail.customFields)).toContain("Blurred vision");
    });

    it("a SYSTEM field cannot be archived, retyped or made optional by a tenant (either endpoint)", async () => {
      const [system] = await db
        .insert(customFieldDefinitions)
        .values({ tenantId: a.tenantId, specialtyKey: "*", key: "system_probe", label: "System probe", fieldType: "TEXT", origin: "SYSTEM", required: true })
        .returning();
      for (const body of [{ archived: true }, { fieldType: "NUMBER" }, { required: false }]) {
        const res = await call(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${system!.id}`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(403);
        expect(res.json().error).toBe("system_field_locked");
      }
      expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/specialties/fields/${system!.id}`, { archived: true })).statusCode).toBe(403);
      const stored = (await db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.id, system!.id)))[0]!;
      expect(stored).toMatchObject({ archived: false, fieldType: "TEXT", required: true });
      // It can still be relabelled — locked, not frozen.
      expect((await call(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${system!.id}`, { label: "Renamed" })).statusCode).toBe(200);
    });
  });
});
