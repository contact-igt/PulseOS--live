import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { PerformanceDashboard } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { customFieldDefinitions, customFieldValues, journeys, patients } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// "Who is enquiring" is built from what was really recorded: patient age (derived into groups) and the hospital's own filterable
// fields. Another hospital's answers never mix in, a clinical-only field never appears, and an empty hospital shows nothing.
describe.skipIf(!DEMO_PASSWORD)("performance: who is enquiring (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let empty: TestTenant;

  const perf = async (tt: TestTenant) => ((await app.inject({ method: "GET", url: "/dashboard/performance?range=30d", cookies: { pulseos_session: tt.cookie.SUPER_ADMIN! } })).json() as PerformanceDashboard).demographics;
  const field = async (tt: TestTenant, key: string, label: string, fieldType: "SELECT" | "TEXT", over: Partial<typeof customFieldDefinitions.$inferInsert> = {}) => {
    const [d] = await db.insert(customFieldDefinitions).values({ tenantId: tt.tenantId, specialtyKey: "*", key, label, fieldType, origin: "CUSTOM", filterable: true, placements: ["journey_detail"], ...over }).returning();
    return d!.id;
  };
  async function person(tt: TestTenant, name: string, age: { dob?: string; reported?: number }, answers: [string, string][] = []) {
    const [p] = await db.insert(patients).values({ tenantId: tt.tenantId, name, phone: "+91 90000 00000", phoneE164: `+9177${Math.floor(10000000 + Math.random() * 89999999)}`, dateOfBirth: age.dob ?? null, reportedAge: age.reported ?? null }).returning();
    const [j] = await db.insert(journeys).values({ tenantId: tt.tenantId, patientId: p!.id, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", stage: "enquiry" }).returning();
    for (const [defId, value] of answers) await db.insert(customFieldValues).values({ tenantId: tt.tenantId, journeyId: j!.id, fieldDefinitionId: defId, value });
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    empty = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const gender = await field(t, "gender", "Gender", "SELECT");
    const area = await field(t, "area", "Area / Locality", "TEXT");
    const uid = await field(t, "uid", "Namokar UID", "TEXT");
    const secret = await field(t, "dx", "Clinical diagnosis", "SELECT", { visibleTo: "clinical" });
    await field(t, "unused", "Never answered", "SELECT");
    const year = new Date().getUTCFullYear();
    await person(t, "A", { dob: `${year - 25}-01-01` }, [[gender, "Female"], [area, "Ashok Vihar"], [uid, "NK-1"], [secret, "Cataract"]]);
    await person(t, "B", { reported: 28 }, [[gender, "Female"], [area, "Ashok Vihar"], [uid, "NK-2"]]);
    await person(t, "C", { dob: `${year - 61}-01-01` }, [[gender, "Male"], [area, "Pitampura"], [uid, "NK-3"]]);
    await person(t, "D", {}, [[uid, "NK-4"]]); // no age, no gender
    // Another hospital's answers must not leak in.
    const og = await field(other, "gender", "Gender", "SELECT");
    await person(other, "Other", { reported: 40 }, [[og, "Male"]]);
  });
  afterAll(async () => {
    for (const tt of [t, other, empty]) {
      await db.delete(customFieldValues).where(eq(customFieldValues.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  it("derives age groups from date of birth or the reported age, leaving people with no age out", async () => {
    const d = (await perf(t)).find((x) => x.key === "age_group")!;
    expect(d.answered).toBe(3);
    expect(d.rows).toEqual([{ label: "18–34", count: 2, pct: 67 }, { label: "50–64", count: 1, pct: 33 }]);
  });

  it("offers each configured filterable field with real answers: choice fields, and text only when answers repeat", async () => {
    const dims = await perf(t);
    expect(dims.find((x) => x.key === "gender")).toMatchObject({ answered: 3, rows: [{ label: "Female", count: 2, pct: 67 }, { label: "Male", count: 1, pct: 33 }] });
    expect(dims.find((x) => x.key === "area")).toMatchObject({ answered: 3, rows: [{ label: "Ashok Vihar", count: 2 }, { label: "Pitampura", count: 1 }] });
  });

  it("never shows a unique identifier, a clinical-only field, or a field nobody has answered", async () => {
    const keys = (await perf(t)).map((x) => x.key);
    expect(keys).not.toContain("uid");
    expect(keys).not.toContain("dx");
    expect(keys).not.toContain("unused");
  });

  it("keeps hospitals apart, and a hospital with no data has no dimensions (no empty charts)", async () => {
    expect((await perf(other)).find((x) => x.key === "gender")).toMatchObject({ answered: 1, rows: [{ label: "Male", count: 1, pct: 100 }] });
    expect(await perf(empty)).toEqual([]);
  });
});
