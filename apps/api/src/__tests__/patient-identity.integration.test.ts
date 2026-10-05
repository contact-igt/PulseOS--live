import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { PatientSearchRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, customFieldValues, tasks } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// New vs Existing patient, and the clinic's own UID. All of it is ordinary configuration (CRM fields + show rules): the UID is a
// field that only appears for an Existing patient, a New patient is never asked for one (it is issued later, at registration),
// and an Existing patient is recognised by UID as well as by phone. A phone number still decides who the person IS.
describe.skipIf(!DEMO_PASSWORD)("patient type and UID (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;

  const as = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(66000000 + ++n * 53).padStart(8, "0")}`;
  const lead = (tt: TestTenant, body: object) => as(tt, "FRONT_DESK", "POST", "/leads", { specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {}, ...body });
  const search = async (tt: TestTenant, q: string) => (await as(tt, "FRONT_DESK", "GET", `/patients/search?q=${encodeURIComponent(q)}`)).json() as PatientSearchRow[];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, other]) {
      await as(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
      const type = await as(tt, "HOSPITAL_ADMIN", "POST", "/crm/fields", { specialtyKey: "*", key: "patient_type", label: "Patient type", fieldType: "SELECT", options: ["New Patient", "Existing Patient"], placements: ["add_lead", "journey_detail"], filterable: true });
      expect(type.statusCode).toBe(201);
      const uid = await as(tt, "HOSPITAL_ADMIN", "POST", "/crm/fields", { specialtyKey: "*", key: "clinic_uid", label: "Clinic UID", fieldType: "TEXT", placements: ["add_lead", "journey_detail"], filterable: true, rules: [{ when: { field: "patient_type", equals: ["Existing Patient"] }, then: "show" }] });
      expect(uid.statusCode, JSON.stringify(uid.json())).toBe(201);
    }
  });
  afterAll(async () => {
    for (const tt of [t, other]) {
      await db.delete(tasks).where(eq(tasks.tenantId, tt.tenantId));
      await db.delete(appointments).where(eq(appointments.tenantId, tt.tenantId));
      await db.delete(customFieldValues).where(eq(customFieldValues.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  it("Add Lead offers Patient type; the UID question only exists as a rule that shows it for an Existing patient", async () => {
    const fields = (await as(t, "FRONT_DESK", "GET", "/specialties/CATARACT/fields")).json() as { key: string; required: boolean; rules: unknown[] }[];
    const type = fields.find((f) => f.key === "patient_type")!;
    const uid = fields.find((f) => f.key === "clinic_uid")!;
    expect(type.required).toBe(false);
    expect(uid.required).toBe(false); // never demanded
    expect(uid.rules).toEqual([{ when: { field: "patient_type", equals: ["Existing Patient"] }, then: "show" }]);
  });

  it("a New patient is saved without any UID; a UID typed and then hidden by switching to New is not kept", async () => {
    const ok = await lead(t, { phone: phone(), name: "New Person", customFieldValues: { patient_type: "New Patient" } });
    expect(ok.statusCode).toBe(201);
    const stale = await lead(t, { phone: phone(), name: "Switched Person", customFieldValues: { patient_type: "New Patient", clinic_uid: "UID-STALE-1" } });
    expect(stale.statusCode).toBe(201);
    const stored = await db.select().from(customFieldValues).where(eq(customFieldValues.journeyId, (stale.json() as { journeyId: string }).journeyId));
    expect(JSON.stringify(stored.map((r) => r.value))).not.toContain("UID-STALE-1");
  });

  it("an Existing patient can be found by UID, as well as by name or phone", async () => {
    const p = phone();
    const res = await lead(t, { phone: p, name: "Returning Person", customFieldValues: { patient_type: "Existing Patient", clinic_uid: "NK-48213" } });
    expect(res.statusCode).toBe(201);
    const patientId = (res.json() as { patientId: string }).patientId;
    expect((await search(t, "NK-48213")).map((r) => r.id)).toEqual([patientId]);
    expect((await search(t, "nk-4821")).map((r) => r.id)).toContain(patientId);
    expect((await search(t, "Returning")).map((r) => r.id)).toContain(patientId);
    expect((await search(t, p.slice(-8))).map((r) => r.id)).toContain(patientId);
  });

  it("the UID never crosses hospitals", async () => {
    expect(await search(other, "NK-48213")).toEqual([]);
  });

  it("a new enquiry from the same phone is the SAME patient with a NEW journey (a UID never creates a duplicate person)", async () => {
    const p = phone();
    const first = (await lead(t, { phone: p, name: "Repeat Person", customFieldValues: { patient_type: "Existing Patient", clinic_uid: "NK-77001" } })).json() as { patientId: string; journeyId: string };
    const second = await lead(t, { phone: p, name: "Repeat Person", journeyType: "Cataract (second enquiry)", customFieldValues: { patient_type: "Existing Patient", clinic_uid: "NK-77001" } });
    expect(second.statusCode).toBe(201);
    const again = second.json() as { patientId: string; journeyId: string; isNewPatient: boolean };
    expect(again.patientId).toBe(first.patientId);
    expect(again.journeyId).not.toBe(first.journeyId);
    expect(again.isNewPatient).toBe(false);
    expect((await search(t, "NK-77001")).filter((r) => r.id === first.patientId)).toHaveLength(1);
  });

  it("a field only clinical staff may see is not searchable by front desk", async () => {
    const secret = await as(t, "HOSPITAL_ADMIN", "POST", "/crm/fields", { specialtyKey: "*", key: "clinic_note_id", label: "Clinical reference", fieldType: "TEXT", placements: ["add_lead"], filterable: true, visibleTo: "clinical" });
    expect(secret.statusCode).toBe(201);
    const res = await as(t, "HOSPITAL_ADMIN", "POST", "/leads", { phone: phone(), name: "Hidden Ref", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: { clinic_note_id: "SECRET-REF-9" } });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    expect(await search(t, "SECRET-REF-9")).toEqual([]);
  });
});
