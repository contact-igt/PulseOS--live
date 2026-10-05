import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Patient360 } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { journeys, patients } from "../db/schema.js";
import { findOrCreatePatientByPhone, resolveOrCreatePatient } from "../domain/patient/identity.service.js";
import { ageFromDateOfBirth, displayAge, isValidPastDate } from "../lib/age.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe("age helpers (unit)", () => {
  it("whole years from a date of birth, on and around the birthday", () => {
    expect(ageFromDateOfBirth("1990-06-15", "2026-06-14")).toBe(35);
    expect(ageFromDateOfBirth("1990-06-15", "2026-06-15")).toBe(36);
    expect(ageFromDateOfBirth("2000-02-29", "2026-02-28")).toBe(25);
    expect(ageFromDateOfBirth(null, "2026-01-01")).toBeNull();
    expect(ageFromDateOfBirth("2030-01-01", "2026-01-01")).toBeNull();
  });
  it("an exact date of birth wins over a reported age; otherwise the reported age is shown", () => {
    expect(displayAge("1990-06-15", 99, "2026-06-15")).toBe(36);
    expect(displayAge(null, 42, "2026-06-15")).toBe(42);
    expect(displayAge(null, null, "2026-06-15")).toBeNull();
  });
  it("accepts only real calendar dates that are not in the future", () => {
    expect(isValidPastDate("1990-06-15", "2026-10-01")).toBe(true);
    expect(isValidPastDate("2026-10-02", "2026-10-01")).toBe(false);
    expect(isValidPastDate("2026-02-30", "2026-10-01")).toBe(false);
    expect(isValidPastDate("15-06-1990", "2026-10-01")).toBe(false);
    expect(isValidPastDate("1800-01-01", "2026-10-01")).toBe(false);
  });
});

describe.skipIf(!DEMO_PASSWORD)("patient intake: unknown names, age/DOB, unique phone (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  const phone = () => `+9198${String(71000000 + ++n * 13).padStart(8, "0")}`;
  const lead = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: t.cookie.FRONT_DESK! },
      payload: { phone: phone(), specialtyKey: "CATARACT", branchId: t.branchId, sourceKey: "google", journeyType: "Cataract", customFieldValues: {}, ...extra },
    });
  const patientRow = async (id: string) => (await db.select().from(patients).where(eq(patients.id, id)))[0]!;
  const p360 = async (id: string) => (await app.inject({ method: "GET", url: `/patients/${id}/360`, cookies: { pulseos_session: t.cookie.FRONT_DESK! } })).json() as Patient360;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    expect((await app.inject({ method: "POST", url: "/departments/install", cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! }, payload: { templateKey: "ophthalmology" } })).statusCode).toBe(201);
  });

  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("a lead needs only a phone: the name is stored as NULL, shown as 'Unknown patient', and no placeholder name is invented", async () => {
    const res = await lead();
    expect(res.statusCode).toBe(201);
    const row = await patientRow(res.json().patientId);
    expect(row.name).toBeNull();
    const card = await p360(row.id);
    expect(card.patient.name).toBe("Unknown patient");
    // search by the shown label must not match: the label is display-only
    const search = await app.inject({ method: "GET", url: "/patients?search=Unknown", cookies: { pulseos_session: t.cookie.FRONT_DESK! } });
    expect(JSON.stringify(search.json())).not.toContain(row.id);
  });

  it("a blank or whitespace name counts as unknown, not as a name", async () => {
    const res = await lead({ name: "   " });
    expect(res.statusCode).toBe(400); // trimmed to empty violates min(1): the form must omit the field instead
    const ok = await lead({});
    expect((await patientRow(ok.json().patientId)).name).toBeNull();
  });

  it("webhook-style intake with no name leaves the name unknown (no 'Unknown caller' / 'WhatsApp Contact')", async () => {
    const created = await findOrCreatePatientByPhone(db, t.tenantId, phone(), null);
    expect(created.name).toBeNull();
  });

  it("a later contact fills in a missing name or age, but never overwrites what the hospital already holds", async () => {
    const p = phone();
    const first = await lead({ phone: p });
    const id = first.json().patientId as string;
    expect((await patientRow(id)).name).toBeNull();

    await lead({ phone: p, name: "Asha Verma", age: 41 });
    expect(await patientRow(id)).toMatchObject({ name: "Asha Verma", reportedAge: 41 });

    await lead({ phone: p, name: "Someone Else", age: 25, dateOfBirth: "1980-03-04" });
    const after = await patientRow(id);
    expect(after.name).toBe("Asha Verma");
    expect(after.reportedAge).toBe(41);
    expect(after.dateOfBirth).toBe("1980-03-04"); // a date of birth was missing, so it was filled
  });

  it("stores a reported age or an exact date of birth, and shows the right age on Patient 360 and Journey Detail", async () => {
    const byAge = await lead({ name: "Age Only", age: 63 });
    expect((await p360(byAge.json().patientId)).patient).toMatchObject({ age: 63, dateOfBirth: null });

    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - 30);
    dob.setUTCDate(dob.getUTCDate() - 3); // birthday already passed this year → exactly 30
    const iso = dob.toISOString().slice(0, 10);
    const byDob = await lead({ name: "Has DOB", dateOfBirth: iso, age: 99 });
    expect((await p360(byDob.json().patientId)).patient).toMatchObject({ age: 30, dateOfBirth: iso });
    const detail = (await app.inject({ method: "GET", url: `/journeys/${byDob.json().journeyId}`, cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! } })).json();
    expect(detail.patient.age).toBe(30);
  });

  it.each([
    ["age", { age: -1 }],
    ["age", { age: 121 }],
    ["age", { age: 41.5 }],
    ["dateOfBirth", { dateOfBirth: "2999-01-01" }],
    ["dateOfBirth", { dateOfBirth: "not-a-date" }],
    ["dateOfBirth", { dateOfBirth: "2020-02-30" }],
  ])("rejects an impossible %s (%j) before anything is written", async (field, extra) => {
    const p = phone();
    const res = await lead({ phone: p, ...extra });
    expect([400, 422]).toContain(res.statusCode);
    if (res.statusCode === 422) expect(res.json().fields).toContain(field);
    expect(await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phone, p)))).toHaveLength(0);
  });

  it("the same number written three ways is one patient, and each new enquiry is a new Journey", async () => {
    const res1 = await lead({ phone: "+91 98765 43210", name: "Ravi" });
    const res2 = await lead({ phone: "09876543210" });
    const res3 = await lead({ phone: "919876543210", specialtyKey: "SQUINT", journeyType: "Squint" });
    const ids = new Set([res1, res2, res3].map((r) => r.json().patientId));
    expect(ids.size).toBe(1);
    expect(res1.json().isNewPatient).toBe(true);
    expect(res2.json().isNewPatient).toBe(false);
    const js = await db.select().from(journeys).where(eq(journeys.patientId, [...ids][0]!));
    expect(js).toHaveLength(3);
    expect(new Set(js.map((j) => j.id)).size).toBe(3);
  });

  it("concurrent intake of one brand-new number creates exactly one patient (API, and the shared identity path)", async () => {
    const p = phone();
    const results = await Promise.all(Array.from({ length: 8 }, () => lead({ phone: p })));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().patientId)).size).toBe(1);
    expect(results.filter((r) => r.json().isNewPatient)).toHaveLength(1);

    const p2 = phone();
    const viaService = await Promise.all(Array.from({ length: 10 }, () => resolveOrCreatePatient(db, { tenantId: t.tenantId, phone: p2 })));
    expect(new Set(viaService.map((r) => r.patient.id)).size).toBe(1);
    expect(viaService.filter((r) => r.isNewPatient)).toHaveLength(1);

    const stored = await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, p)));
    expect(stored).toHaveLength(1);
  });

  it("the database itself refuses a duplicate normalized number in a tenant, and an unnormalizable one by its raw text", async () => {
    const p = phone();
    await lead({ phone: p });
    await expect(db.insert(patients).values({ tenantId: t.tenantId, name: "Dup", phone: p, phoneE164: p })).rejects.toThrow();

    const raw = "12-34";
    await db.insert(patients).values({ tenantId: t.tenantId, name: "Raw A", phone: raw, phoneE164: null });
    await expect(db.insert(patients).values({ tenantId: t.tenantId, name: "Raw B", phone: raw, phoneE164: null })).rejects.toThrow();
  });

  it("the same number in two tenants is two patients (uniqueness is per tenant)", async () => {
    const p = phone();
    const a = await resolveOrCreatePatient(db, { tenantId: t.tenantId, phone: p, name: "Tenant A patient" });
    const b = await resolveOrCreatePatient(db, { tenantId: other.tenantId, phone: p, name: "Tenant B patient" });
    expect(a.patient.id).not.toBe(b.patient.id);
    expect(a.isNewPatient && b.isNewPatient).toBe(true);
  });
});
