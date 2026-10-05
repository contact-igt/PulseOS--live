import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ClinicHours, CrmFieldVm, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, customFieldDefinitions, scheduleResources, tasks } from "../db/schema.js";
import { addDays, dayKeyIn } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const WEEK = (sat: [string, string]): ClinicHours => ({ mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat, sun: null });

// Configuration belongs to ONE hospital (tenant) and is read from one place. A Super Admin's change reaches that hospital's
// booking, slot pre-check, forms and Add Lead on the very next request - and never touches another hospital's.
describe.skipIf(!DEMO_PASSWORD)("tenant configuration: one source, immediate, isolated (integration)", () => {
  let app: FastifyInstance;
  let a: TestTenant; // "V2"
  let b: TestTenant; // "V1"
  const doctorOf = new Map<string, string>();

  const as = (t: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  const saturday = () => {
    let d = addDays(dayKeyIn(new Date(), "Asia/Kolkata"), 2);
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 6) d = addDays(d, 1);
    return d;
  };
  const slot = async (t: TestTenant, local: string) => (await as(t, "FRONT_DESK", "GET", `/appointments/slot-check?doctorId=${doctorOf.get(t.tenantId)}&scheduledAt=${encodeURIComponent(local)}`)).json() as { available: boolean; outsideHours: boolean };
  const hoursOf = async (t: TestTenant) => ((await as(t, "FRONT_DESK", "GET", "/lookups")).json() as { clinicHours: ClinicHours | null }).clinicHours;
  const addLeadFields = async (t: TestTenant) => ((await as(t, "FRONT_DESK", "GET", "/specialties/CATARACT/fields")).json() as { key: string }[]).map((f) => f.key);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    a = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    b = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const t of [a, b]) {
      await as(t, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
      doctorOf.set(t.tenantId, (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id);
      expect((await as(t, "HOSPITAL_ADMIN", "PUT", "/clinic-hours", { clinicHours: WEEK(["09:00", "16:00"]) })).statusCode).toBe(200);
    }
  });
  afterAll(async () => {
    for (const t of [a, b]) {
      await db.delete(tasks).where(eq(tasks.tenantId, t.tenantId));
      await db.delete(appointments).where(eq(appointments.tenantId, t.tenantId));
      await destroyTestTenant(db, t);
    }
    await app.close();
    await queryClient.end();
  });

  it("clinic hours: an admin's change is what the next lookup, slot pre-check and booking use; the other hospital keeps its own", async () => {
    const sat = saturday();
    expect(await slot(a, `${sat}T14:00`)).toMatchObject({ available: true, outsideHours: false });

    expect((await as(a, "HOSPITAL_ADMIN", "PUT", "/clinic-hours", { clinicHours: WEEK(["09:00", "13:00"]) })).statusCode).toBe(200);
    expect((await hoursOf(a))!.sat).toEqual(["09:00", "13:00"]);
    expect(await slot(a, `${sat}T14:00`)).toMatchObject({ available: false, outsideHours: true });
    expect(await slot(a, `${sat}T12:30`)).toMatchObject({ available: true, outsideHours: false });

    const lead = (await as(a, "FRONT_DESK", "POST", "/leads", { phone: "+919630012345", name: "Hours Check", specialtyKey: "CATARACT", branchId: a.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} })).json() as { patientId: string; journeyId: string };
    const book = (at: string) => as(a, "FRONT_DESK", "POST", "/appointments", { ...lead, branchId: a.branchId, doctorId: doctorOf.get(a.tenantId), scheduledAt: at, reason: "Consultation" });
    expect((await book(`${sat}T14:00`)).json()).toEqual({ error: "outside_clinic_hours" });
    expect((await book(`${sat}T12:30`)).statusCode).toBe(201);

    // The other hospital: unchanged, on every path that reads hours.
    expect((await hoursOf(b))!.sat).toEqual(["09:00", "16:00"]);
    expect(await slot(b, `${sat}T14:00`)).toMatchObject({ available: true, outsideHours: false });

    // Changing the other hospital's hours does not reach back either.
    expect((await as(b, "HOSPITAL_ADMIN", "PUT", "/clinic-hours", { clinicHours: WEEK(["10:00", "12:00"]) })).statusCode).toBe(200);
    expect((await hoursOf(a))!.sat).toEqual(["09:00", "13:00"]);
    expect((await hoursOf(b))!.sat).toEqual(["10:00", "12:00"]);
  });

  it("only an administrator changes the hours (front desk and doctor are refused)", async () => {
    for (const role of ["FRONT_DESK", "DOCTOR"] as Role[]) expect((await as(a, role, "PUT", "/clinic-hours", { clinicHours: null })).statusCode, role).toBe(403);
  });

  it("Add Lead fields: switching 'Add Lead' on and off for a field takes effect on the next request, and only for that hospital", async () => {
    const all = (await as(a, "HOSPITAL_ADMIN", "GET", "/crm/fields?includeArchived=true")).json() as CrmFieldVm[];
    const field = all.find((f) => f.specialtyKey === "CATARACT" && f.placements.includes("add_lead") && !f.required)!;
    expect(field, "the ophthalmology template ships at least one optional Add Lead field").toBeTruthy();
    const inB = (await as(b, "HOSPITAL_ADMIN", "GET", "/crm/fields?includeArchived=true")).json() as CrmFieldVm[];
    const sameInB = inB.find((f) => f.specialtyKey === "CATARACT" && f.key === field.key)!;

    expect(await addLeadFields(a)).toContain(field.key);
    const without = field.placements.filter((p) => p !== "add_lead");
    expect((await as(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${field.id}`, { placements: without })).statusCode).toBe(200);
    expect(await addLeadFields(a)).not.toContain(field.key); // gone at once
    expect(await addLeadFields(b)).toContain(field.key); // the other hospital still asks it
    expect(sameInB.placements).toContain("add_lead");

    // History is not deleted by hiding: a value recorded earlier stays readable on the journey.
    const [stored] = await db.select({ placements: customFieldDefinitions.placements, archived: customFieldDefinitions.archived }).from(customFieldDefinitions).where(and(eq(customFieldDefinitions.id, field.id), eq(customFieldDefinitions.tenantId, a.tenantId)));
    expect(stored!.archived).toBe(false);
    expect(stored!.placements).toEqual(without);

    expect((await as(a, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${field.id}`, { placements: field.placements })).statusCode).toBe(200);
    expect(await addLeadFields(a)).toContain(field.key); // and back at once
  });
});
