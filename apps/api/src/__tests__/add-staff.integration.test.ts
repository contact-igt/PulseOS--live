import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { activityLog, branches, scheduleResources, tenants, users } from "../db/schema.js";
import { db, queryClient } from "../db/client.js";
import { addStaff } from "../ops/add-staff.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// Both the operator CLI and the hospital Team screen use the same account storage.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("ops: add a staff account", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let two: TestTenant;
  const slug = `ops-${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 8);
  const email = (n: string) => `${n}.${tag}@pilot.example`;
  const PW = "a-long-real-pilot-password";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    two = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await db.update(tenants).set({ loginSlug: slug }).where(eq(tenants.id, t.tenantId));
    await db.update(tenants).set({ loginSlug: `${slug}-b` }).where(eq(tenants.id, two.tenantId));
    await db.insert(branches).values({ tenantId: two.tenantId, name: "Second branch", city: "Pune" });
  });
  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, two);
    await app.close();
    await queryClient.end();
  });

  it("creates a receptionist who can sign in, in the right hospital, on its only branch", async () => {
    const r = await addStaff(db, { loginSlug: slug, role: "FRONT_DESK", name: "Pilot Receptionist", email: email("rec"), password: PW });
    expect(r.ok).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.email, email("rec")));
    expect(u).toMatchObject({ tenantId: t.tenantId, role: "FRONT_DESK", branchId: t.branchId });
    expect(u!.passwordHash).not.toContain(PW);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("rec"), password: PW } });
    expect(login.statusCode).toBe(200);
  });

  it("a doctor gets a schedule resource automatically; two coordinators are fine", async () => {
    expect((await addStaff(db, { loginSlug: slug, role: "DOCTOR", name: "Dr. Pilot", email: email("doc"), password: PW })).ok).toBe(true);
    const [doc] = await db.select().from(users).where(eq(users.email, email("doc")));
    expect((await db.select().from(scheduleResources).where(eq(scheduleResources.linkedUserId, doc!.id))).length).toBe(1);
    expect((await addStaff(db, { loginSlug: slug, role: "PATIENT_COORDINATOR", name: "Coord A", email: email("c1"), password: PW })).ok).toBe(true);
    expect((await addStaff(db, { loginSlug: slug, role: "PATIENT_COORDINATOR", name: "Coord B", email: email("c2"), password: PW })).ok).toBe(true);
  });

  it("refuses: a duplicate email (any hospital), a short password, an unknown hospital, a role it must not create, a hospital with several branches", async () => {
    expect(await addStaff(db, { loginSlug: slug, role: "FRONT_DESK", name: "Dup", email: email("rec").toUpperCase(), password: PW })).toMatchObject({ ok: false, reason: "email_in_use" });
    expect(await addStaff(db, { loginSlug: slug, role: "FRONT_DESK", name: "Short", email: email("short"), password: "short" })).toMatchObject({ ok: false, reason: "weak_password" });
    expect(await addStaff(db, { loginSlug: "no-such-hospital", role: "FRONT_DESK", name: "Xavier", email: email("x"), password: PW })).toMatchObject({ ok: false, reason: "unknown_hospital" });
    expect(await addStaff(db, { loginSlug: slug, role: "SUPER_ADMIN" as never, name: "Xavier", email: email("sa"), password: PW })).toMatchObject({ ok: false, reason: "role_not_allowed" });
    expect(await addStaff(db, { loginSlug: `${slug}-b`, role: "FRONT_DESK", name: "Xavier", email: email("multi"), password: PW })).toMatchObject({ ok: false, reason: "branch_ambiguous" });
  });

  it("creates scoped Team accounts and enforces role and branch boundaries through HTTP", async () => {
    const list = (cookie?: string) => app.inject({ method: "GET", url: "/hospital-team",
      ...(cookie ? { cookies: { pulseos_session: cookie } } : {}) });
    const create = (cookie: string, overrides: Record<string, unknown> = {}) => app.inject({
      method: "POST", url: "/hospital-team", cookies: { pulseos_session: cookie },
      payload: { name: "Team fixture", email: email("team"), password: PW, role: "HOSPITAL_ADMIN", branchId: t.branchId, ...overrides },
    });
    const owner = t.cookie.SUPER_ADMIN!;
    const admin = t.cookie.HOSPITAL_ADMIN!;
    const receptionist = t.cookie.FRONT_DESK!;
    expect((await list()).statusCode).toBe(401);
    expect((await list(receptionist)).statusCode).toBe(403);
    expect((await create(receptionist)).statusCode).toBe(403);
    expect((await create(admin)).statusCode).toBe(403);
    expect((await create(owner, { role: "SUPER_ADMIN" })).statusCode).toBe(400);
    expect((await create(owner, { tenantId: two.tenantId })).statusCode).toBe(400);
    expect((await create(owner, { branchId: two.branchId })).statusCode).toBe(400);
    const results = await Promise.all([create(owner), create(owner, { email: email("team").toUpperCase() })]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const member = results.find((response) => response.statusCode === 201)!.json();
    expect(member).toMatchObject({ role: "HOSPITAL_ADMIN", branchId: t.branchId });
    expect(member).not.toHaveProperty("passwordHash");
    expect((await list(two.cookie.SUPER_ADMIN!)).json().items).not.toContainEqual(expect.objectContaining({ id: member.id }));
    expect((await list(admin)).json().items).toContainEqual(expect.objectContaining({ id: member.id }));
    expect((await create(admin, { email: email("team-staff"), role: "DOCTOR" })).statusCode).toBe(201);
    const login = await app.inject({ method: "POST", url: "/auth/login/tenant/" + slug, payload: { email: email("team"), password: PW } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ tenantId: t.tenantId, role: "HOSPITAL_ADMIN", branchId: t.branchId });
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityKey, member.id));
    expect(audit).toMatchObject([{ actorId: t.userIds.SUPER_ADMIN, tenantId: t.tenantId, action: "hospital_team.created", metadata: { role: "HOSPITAL_ADMIN", branchId: t.branchId } }]);
  });
});
