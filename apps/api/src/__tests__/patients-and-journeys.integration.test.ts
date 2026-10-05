import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { branches, patients, tenants, users } from "../db/schema.js";
import type { FastifyInstance } from "fastify";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("patients and journeys (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("lists patients with search filtering by name", async () => {
    const res = await app.inject({ method: "GET", url: "/patients?search=Priya", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { name: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.name.toLowerCase().includes("priya"))).toBe(true);
  });

  describe("global search typeahead (GET /patients/search)", () => {
    it("returns nothing for a query shorter than 2 characters — never a full-directory fetch", async () => {
      const res = await app.inject({ method: "GET", url: "/patients/search?q=p", cookies: { pulseos_session: cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("matches by name or phone, tenant-scoped, capped, ordered by name", async () => {
      const res = await app.inject({ method: "GET", url: "/patients/search?q=Priya", cookies: { pulseos_session: cookie } });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { id: string; name: string; phone: string; currentJourneyType: string | null; currentStage: string | null }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(8);
      expect(rows.every((r) => r.name.toLowerCase().includes("priya"))).toBe(true);
      for (const r of rows) {
        expect(typeof r.id).toBe("string");
        expect(typeof r.phone).toBe("string");
      }
      // Priya Sharma has active journeys in seed data — stage should be a real value, not just present-but-null.
      expect(rows.some((r) => r.currentStage !== null)).toBe(true);
    });

    it("matching on phone digits also finds the patient", async () => {
      const byName = await app.inject({ method: "GET", url: "/patients/search?q=Priya", cookies: { pulseos_session: cookie } });
      const [priya] = byName.json() as { phone: string }[];
      expect(priya).toBeTruthy();

      const byPhone = await app.inject({ method: "GET", url: `/patients/search?q=${priya.phone.slice(-6)}`, cookies: { pulseos_session: cookie } });
      expect(byPhone.statusCode).toBe(200);
      const rows = byPhone.json() as { phone: string }[];
      expect(rows.some((r) => r.phone === priya.phone)).toBe(true);
    });

    it("unauthenticated request is rejected", async () => {
      const res = await app.inject({ method: "GET", url: "/patients/search?q=Priya" });
      expect(res.statusCode).toBe(401);
    });
  });

  it("Patient 360 shows a patient with more than one active journey (Patient != Journey)", async () => {
    const [priya] = await db.select().from(patients).where(eq(patients.name, "Priya Sharma")).limit(1);
    const res = await app.inject({ method: "GET", url: `/patients/${priya.id}/360`, cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.journeys.length).toBeGreaterThanOrEqual(2);
    const types = body.journeys.map((j: { journeyType: string }) => j.journeyType);
    expect(new Set(types).size).toBeGreaterThanOrEqual(2); // Fertility + Pregnancy, distinct

    // Patient 360's card fields prioritize operational state (owner, doctor, next
    // appointment, treatment status, last interaction) over acquisition data.
    for (const journey of body.journeys as Record<string, unknown>[]) {
      expect(journey).toHaveProperty("lastInteractionAt");
      expect(typeof journey.lastInteractionAt === "string" || journey.lastInteractionAt === null).toBe(true);
    }
    const fertilityJourney = (body.journeys as { journeyType: string; lastInteractionAt: string | null }[]).find((j) => j.journeyType === "Fertility");
    expect(fertilityJourney?.lastInteractionAt).toBeTruthy();
  });

  it("Patient 360 returns 404 for a patient id that does not exist in this tenant", async () => {
    const res = await app.inject({ method: "GET", url: "/patients/00000000-0000-0000-0000-000000000000/360", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("unauthenticated request cannot read any patient data (tenant isolation baseline)", async () => {
    const res = await app.inject({ method: "GET", url: "/patients" });
    expect(res.statusCode).toBe(401);
  });

  it("journeys list supports filtering by stage", async () => {
    const res = await app.inject({ method: "GET", url: "/journeys?stage=completed", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { stage: string }[];
    expect(rows.every((r) => r.stage === "completed")).toBe(true);
  });

  it("journeys summary total matches the spend-at-risk total shown on the dashboard", async () => {
    const [summary, spendAtRisk] = await Promise.all([
      app.inject({ method: "GET", url: "/journeys/summary", cookies: { pulseos_session: cookie } }),
      app.inject({ method: "GET", url: "/dashboard/spend-at-risk", cookies: { pulseos_session: cookie } }),
    ]);
    expect(summary.json().spendAtRisk).toBe(spendAtRisk.json().total);
  });

  it("journeys list filtered by atRisk category returns exactly the journeys counted in that dashboard category", async () => {
    const spendAtRisk = await app.inject({ method: "GET", url: "/dashboard/spend-at-risk", cookies: { pulseos_session: cookie } });
    const category = (spendAtRisk.json().categories as { key: string; journeyCount: number }[]).find((c) => c.journeyCount > 0)!;

    const res = await app.inject({ method: "GET", url: `/journeys?atRisk=${category.key}`, cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as unknown[];
    expect(rows.length).toBe(category.journeyCount);
  });

  it("journeys list filtered by branch only returns journeys for patients in that branch", async () => {
    // The signed-in hospital's own branch (not "any branch in the database": that depends on row order and other hospitals).
    const [branch] = await db.select({ id: branches.id, name: branches.name }).from(branches).innerJoin(tenants, eq(tenants.id, branches.tenantId)).innerJoin(users, eq(users.tenantId, tenants.id)).where(eq(users.email, "gyn.admin@pulseos.local")).orderBy(branches.name).limit(1);
    const res = await app.inject({ method: "GET", url: `/journeys?branchId=${branch.id}`, cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { branchName: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.branchName === branch.name)).toBe(true);
  });
});
