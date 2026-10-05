import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { journeys, revenueEvents, treatmentOpportunities } from "../db/schema.js";
import { updateTreatmentStatus } from "../domain/treatment/treatment.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// A tenant that does not run a revenue workflow (the Namokar pilot) must not show, compute or accept revenue anywhere:
// not in the screens, and not through a direct API call either. Other tenants keep it exactly as before.
describe.skipIf(!DEMO_PASSWORD)("revenue tracking off for a tenant (integration)", () => {
  let app: FastifyInstance;
  let off: TestTenant;
  let on: TestTenant;
  const get = (t: TestTenant, role: Role, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: t.cookie[role]! } });
  const put = (t: TestTenant, role: Role, key: string, enabled: boolean | null) =>
    app.inject({ method: "PUT", url: `/capabilities/${key}`, cookies: { pulseos_session: t.cookie[role]! }, payload: { enabled } });

  async function treatmentFor(t: TestTenant, value: number, status: "SCHEDULED" = "SCHEDULED") {
    const [journey] = await db.insert(journeys).values({ tenantId: t.tenantId, patientId: t.patientId, journeyType: "Cataract", source: "walk_in", stage: "scheduled" }).returning();
    const [treatment] = await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId: t.patientId, journeyId: journey!.id, treatmentLabel: "Cataract surgery", status, estimatedValue: value }).returning();
    return { journeyId: journey!.id, treatmentId: treatment!.id };
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    off = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    on = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    expect((await put(off, "SUPER_ADMIN", "REVENUE_TRACKING", false)).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const t of [off, on]) {
      await db.delete(revenueEvents).where(eq(revenueEvents.tenantId, t.tenantId));
      await destroyTestTenant(db, t);
    }
    await app.close();
    await queryClient.end();
  });

  it("the session says so, for every role", async () => {
    for (const role of ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) {
      const body = (await get(off, role, "/auth/session")).json() as { user: { capabilities: Record<string, boolean> } };
      expect(body.user.capabilities.REVENUE_TRACKING, role).toBe(false);
    }
    expect(((await get(on, "SUPER_ADMIN", "/auth/session")).json() as { user: { capabilities: Record<string, boolean> } }).user.capabilities.REVENUE_TRACKING).toBe(true);
  });

  it("completing a treatment records NO revenue event when revenue is off, and still does when it is on", async () => {
    const a = await treatmentFor(off, 41_000);
    const done = await updateTreatmentStatus(db, off.tenantId, a.treatmentId, off.userIds.HOSPITAL_ADMIN!, "COMPLETED");
    expect(done.ok).toBe(true);
    expect(await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, a.treatmentId))).toHaveLength(0);

    const b = await treatmentFor(on, 41_000);
    expect((await updateTreatmentStatus(db, on.tenantId, b.treatmentId, on.userIds.HOSPITAL_ADMIN!, "COMPLETED")).ok).toBe(true);
    expect(await db.select().from(revenueEvents).where(eq(revenueEvents.treatmentOpportunityId, b.treatmentId))).toHaveLength(1);
  });

  it("the Today strip carries no revenue figure (not a fake 0) when revenue is off", async () => {
    const offToday = (await get(off, "HOSPITAL_ADMIN", "/dashboard/today")).json() as { attributedRevenue: number | null };
    expect(offToday.attributedRevenue).toBeNull();
    const onToday = (await get(on, "HOSPITAL_ADMIN", "/dashboard/today")).json() as { attributedRevenue: number | null };
    expect(typeof onToday.attributedRevenue).toBe("number");
  });

  it("the journey page has no revenue block and Patient 360 has no revenue number", async () => {
    const a = await treatmentFor(off, 12_000);
    const detail = (await get(off, "SUPER_ADMIN", `/journeys/${a.journeyId}`)).json() as { revenue: unknown };
    expect(detail.revenue).toBeNull();
    const p360 = (await get(off, "SUPER_ADMIN", `/patients/${off.patientId}/360`)).json() as { acquisition: { attributedRevenue: number | null; estimatedTreatmentValue: number | null } };
    expect(p360.acquisition.attributedRevenue).toBeNull();
    expect(p360.acquisition.estimatedTreatmentValue).toBeNull();
  });

  it("revenue analytics are refused even for a Super Admin who calls the API directly", async () => {
    for (const path of ["revenue", "summary", "campaigns", "services"]) {
      const res = await get(off, "SUPER_ADMIN", `/analytics/${path}`);
      expect([403], `${path}: ${res.body}`).toContain(res.statusCode);
      expect(res.json().error).toBe("feature_not_available");
    }
  });

  it("marketing analytics cannot be switched on while revenue is off, and revenue cannot be switched off under it", async () => {
    const res = await put(off, "SUPER_ADMIN", "MARKETING_ANALYTICS", true);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "requires", capabilities: ["REVENUE_TRACKING"] });
    expect((await put(on, "SUPER_ADMIN", "MARKETING_ANALYTICS", true)).statusCode).toBe(200);
    const blocked = await put(on, "SUPER_ADMIN", "REVENUE_TRACKING", false);
    expect(blocked.statusCode).toBe(409);
    expect((await put(on, "SUPER_ADMIN", "MARKETING_ANALYTICS", null)).statusCode).toBe(200);
  });

  it("only a Super Admin can change the switch; a Hospital Admin cannot bring revenue back", async () => {
    expect((await put(off, "HOSPITAL_ADMIN", "REVENUE_TRACKING", true)).statusCode).toBe(403);
    expect(((await get(off, "SUPER_ADMIN", "/auth/session")).json() as { user: { capabilities: Record<string, boolean> } }).user.capabilities.REVENUE_TRACKING).toBe(false);
  });
});
